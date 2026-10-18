# Kanban Lane 2b — the orchestrator surface

The orchestrator agent (named by `KanbanBoard.orchestratorAgentId`) decomposes an epic into cards on the same
board, links them, and assigns them. It reuses the frozen Lane 1 repo API (`cp/src/persistence/ports.ts`) for
every card write and `CardStore` for every GitHub metadata write, so the D3 invariant holds: the CP never sees an
issue title, body, or comment.

## Wire: `kanban/orchestrate` (D→C REQ → `kanban/orchestrate/ok` REP)

Body-free and strict, discriminated by `op`. Every request carries `agentId` (uuid); every op except `list` also
carries `boardId` (uuid). `step` is `/^[a-z0-9][a-z0-9_.:-]{0,63}$/`; `specDigest` is 64 lowercase hex (sha256 of
the masked title+body, computed in the daemon). The CP computes the B1 key as
`kanbanOrchestrateCardKey({ boardId, epicIssueNumber, step, specDigest })`, so no spec text
crosses the wire. The epic ref is its issue **number**, or `board:<id>` when absent.

| op               | fields                                                                                              | reply (`ok: true`)                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`           | `agentId`, `boardId?`, `status?`                                                                    | `{ truncated, boards: [{ boardId, repoFullName, cards: [{ issueNumber, status, assigneeAgentId, assigneeSlug, priority, blockKind, epicIssueNumber, leased }] }] }` (≤ 200 cards) |
| `prepare_create` | `agentId`, `boardId`, `epicIssueNumber?`, `step`, `specDigest`, `assignee?`, `priority?`, `status?` | `{ verdict: 'existing', issueNumber }` or `{ verdict: 'proceed' }`                                                                                                                |
| `commit_create`  | same + `issueNumber`, `blockedBy?` (≤ 20)                                                           | `{ cardId, issueNumber }`                                                                                                                                                         |
| `link`           | `agentId`, `boardId`, `issueNumber`, `blockedBy?`, `parentIssueNumber?`                             | `{}`                                                                                                                                                                              |
| `unblock`        | `agentId`, `boardId`, `issueNumber`, `blockers?` (omitted = all)                                    | `{ status }`                                                                                                                                                                      |
| `assign`         | `agentId`, `boardId`, `issueNumber`, `assignee: slug \| null`                                       | `{ assigned }`                                                                                                                                                                    |

Refusals are data, never errors, with stable codes: `not_orchestrator`, `board_not_found`, `board_disabled`,
`epic_not_found`, `epic_budget_exhausted`, `card_not_found`, `issue_not_found`, `issue_not_from_app`,
`unknown_agent`, `agent_not_assignable`, `key_conflict`, `issue_mismatch`, `invalid_link`, `cross_repo`,
`github_unavailable`, `github_partial`. The schema tests prove `title`/`body`/`text` keys are rejected everywhere.

## Role gate

The handler (`handleKanbanOrchestrate`) fences the request against the authenticated connection: the `agentId`
must be an agent hosted by `conn.daemonId`. The service then requires the board to exist in that agent's org, be
enabled, and have `orchestratorAgentId === agentId`. An unknown or other-org board is indistinguishable
(`board_not_found`) so other orgs' boards never leak.

## D3 split (daemon files the body, CP writes metadata)

- The daemon masks `{ title, body }` with `maskAgentSecrets`, computes `specDigest`, and POSTs
  `/repos/{owner}/{repo}/issues` with a purpose-bound `kanban_orchestrator_write` token (issues-only, board repo
  only, minted when the agent orchestrates an enabled board on that repo). A 401/403 invalidates the presented
  cached grant and forces the next mint past the CP token cache; other errors keep the grant.
- Each issue body carries `<!-- agentconnect:kanban-card-key:<B1 digest> -->`. After `prepare_create` finds no
  registered B1 card, the daemon first consults its durable pending journal (`<root>/state/
kanban-pending-creates.json`: the same agent/board/epic/step/spec key → issue number + file time, one-hour
  expiry, 256-entry oldest-first cap, written atomically via tmp + rename at mode 0600, keys only — never titles,
  bodies, or tokens). A journal hit skips both the lookup and POST. Otherwise the daemon lists the repository's
  issues newest-first (`state=all&sort=created&direction=desc&since=<now-24h>`, at most 3 pages, excluding PRs)
  and matches that exact marker before POSTing. Listing avoids search-index lag immediately after a crash. A
  lookup failure stops creation. If an orphan exists, the daemon journals it and commits that issue, including a
  closed orphan (its GitHub state stays closed). The CP receives only the number and digest, never the body. A
  card already registered under B1 is returned by prepare before journal, lookup, or B2.
- The remaining window is tiny: a crash between the issue POST response and the journal write, combined with
  listing lag, can still file twice; the CP's B1 uniqueness and duplicate-close path then select one card and
  retire the loser.
- `commit_create` then registers the issue through `createEpicChild`: one transaction locks the epic card
  `FOR UPDATE`, re-checks B2, and composes the Lane 1 `upsertCard` (B1 key, `source: 'orchestrator'`,
  `actorAgentId`). Labels (`ac/status:<status>`, `ac/agent:<slug>`) and the epic sub-issue / `blocked_by` edges are
  written via `CardStore`; an edge already present in the live graph is skipped, while a 422 is accepted only if
  a re-read confirms the edge. A failure after the DB write is
  `github_partial` (idempotent to retry). A key matched to a different issue closes our duplicate as `not_planned`
  and returns the winner.

## B2 per-epic budgets

`KanbanBoard.epicMaxCards` (default 100) and `epicMaxActive` (default 16), both CHECK > 0, plus
`KanbanCard.epicCardId` (self-FK, `ON DELETE SET NULL`) and `epicCardsCreated` (lifetime, monotonic — archiving a
child never refunds).

- **maxCards**: checked in `prepare_create`, and again under the epic row lock in `createEpicChild` / `adoptEpic`.
  Exhausted → refuse before filing and move the epic to `triage` (CAS + label) when it is unleased and the
  transition is allowed; a leased epic is just refused. The B1 replay (`existing`) answers before the budget, so a
  re-plan of an already-filed card is never refused by a full epic.
- **maxActive**: in the claim, a ready child is skipped while its epic already has ≥ `epicMaxActive` open runs
  (counted within the claim loop like the per-agent cap).

## Per-daemon cap (audit 2.2)

A ready card is skipped while its placed daemon already holds ≥ `KANBAN_MAX_IN_PROGRESS_PER_DAEMON` (default 8)
open runs across all boards. The count is taken under a per-daemon advisory xact lock acquired in sorted order, so
two boards claiming in parallel serialize and cannot overshoot.

## Known gaps

- Simultaneous independent creates can still race past the marker lookup; the CP's B1 uniqueness and duplicate-close
  path select one card and retire the losing issue. Crash retries reuse the journal first, then the durable marker.
- Sub-issue and dependency writes take GitHub's numeric issue **id**, never the issue number; the CardStore methods
  take a `bigint` id to make that hard to get wrong. The live E2E asserts both edges on GitHub.
- `kanbanCreate` takes a board id (uuid); an `owner/repo` alias is not yet accepted.
- Board CRUD exposes `epicMaxCards` / `epicMaxActive`; lowering a budget blocks new cards without changing replays.
