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
| `prepare_create` | `agentId`, `boardId`, `epicIssueNumber?`, `step`, `specDigest`, `assignee?`, `priority?`, `status?` | `{ verdict: 'existing', issueNumber }` or `{ verdict: 'proceed' }`; both include optional nullable `appLogin`                                                                     |
| `commit_create`  | same + `issueNumber`, `blockedBy?` (≤ 20)                                                           | `{ cardId, issueNumber }`                                                                                                                                                         |
| `link`           | `agentId`, `boardId`, `issueNumber`, `blockedBy?`, `parentIssueNumber?`                             | `{}`                                                                                                                                                                              |
| `unblock`        | `agentId`, `boardId`, `issueNumber`, `blockers?` (omitted = all)                                    | `{ status }`                                                                                                                                                                      |
| `assign`         | `agentId`, `boardId`, `issueNumber`, `assignee: slug \| null`                                       | `{ assigned }`                                                                                                                                                                    |

Refusals are data, never errors, with stable codes: `not_orchestrator`, `board_not_found`, `board_disabled`,
`epic_not_found`, `epic_budget_exhausted`, `card_not_found`, `issue_not_found`, `issue_not_from_app`,
`unknown_agent`, `agent_not_assignable`, `key_conflict`, `issue_mismatch`, `invalid_link`, `cross_repo`,
`repo_mismatch`, `status_not_allowed`, `card_conflict`, `github_unavailable`, `github_partial`. The schema tests prove `title`/`body`/`text` keys are rejected everywhere.

Deploy the CP before the daemon: older CP versions reject the new `kanban/orchestrate` frame and
`kanban_orchestrator_write` gitcred purpose. No relay change is required.

## Role gate

The handler (`handleKanbanOrchestrate`) fences the request against the authenticated connection: the `agentId`
must be an agent hosted by `conn.daemonId`. The service then requires the board to exist in that agent's org, be
enabled, and have `orchestratorAgentId === agentId`. An unknown or other-org board is indistinguishable
(`board_not_found`) so other orgs' boards never leak. D1 offers these tools in every chat session, so any
chat participant who can talk to the orchestrator agent can steer card filing, bounded by this role gate and
the B1 idempotency and B2 budget checks.

## D3 split (daemon files the body, CP writes metadata)

- The daemon masks `{ title, body }`, neutralizes agent-supplied recovery-marker prefixes (case-insensitive,
  including whitespace variants), then computes `specDigest` and POSTs `/repos/{owner}/{repo}/issues` with an
  issues-only, repo-scoped `kanban_orchestrator_write` token. GitHub 401/403 evicts only the presented cached
  token; CP `not_orchestrator` / `board_disabled` on prepare or commit evicts the known agent+repo grant (or
  every orchestrator grant for the agent when the board repo is not yet resolved) and forces the next mint
  past the CP cache. Until a rejection is observed, an already cached gitcred token can remain usable after
  revocation until its TTL expires (normally under one hour).
- The daemon appends its own trailing `<!-- agentconnect:kanban-card-key:<B1 digest> -->`. The durable journal
  (`<root>/state/kanban-pending-creates.json`) stores only keys, timestamps, issue numbers, and rejected lookup
  numbers, never titles, bodies, or tokens. Before POST it writes `{ issueNumber: null, startedAt }`; after POST
  it fills in `{ issueNumber, filedAt }`. Writes use a mode-0600 temporary file, fsync before rename and a
  directory fsync afterwards (the directory fsync is skipped on Windows). Entries expire after one hour and
  the oldest entries are evicted above 256. Loading rejects unsafe/nonpositive numbers and timestamps over
  one minute in the future. Failure to persist the intent prevents POST.
- A filed journal hit skips lookup and POST. `prepare_create: existing` normally returns immediately; when the
  exact key's journal number equals the existing card, `commit_create` replays labels and edges after a partial
  metadata failure. Success or terminal refusal clears the entry; transient failures retain it.
- Ordinary fresh creates skip lookup. Only an intent without a number or a corrupt/invalid journal triggers
  marker recovery. Lookup is bounded to three pages of 100 issues updated within 24 hours, excludes PRs, and
  requires `body.trimEnd().endsWith(marker)`. App mode accepts only Bot users whose login matches the CP's
  trusted `appLogin` case-insensitively. In the PAT development seam, GET `/user` with the same token supplies
  the sole accepted author login; unavailable identity stops recovery. Among matches, the oldest creation
  timestamp wins, with the lowest number breaking ties. Closed orphans keep their closed state. Refused
  looked-up issues (`issue_not_from_app`, `issue_mismatch`, `key_conflict`) are journaled as rejected and skipped
  on later lookups, including after restart.
- An unresolved intent returns a retryable `github_unavailable` result without another POST; later calls can
  retry lookup during the one-hour retention period. A corrupt journal has no per-key intents, so for one hour
  after it loads every fresh create looks up first; a miss refuses retryably without journaling an intent only
  during the first 60 seconds (GitHub's listing lag past any POST it hid), then files normally. A repo with
  more than 300 updates in 24 hours can hide the orphan outside the lookup bound, now a recovery-only
  limitation. After intent expiry/eviction, deleting the journal, or losing its storage, a retry can still file
  a duplicate. That first uncommitted orphan stays open and unlabelled: B1 and duplicate-close cannot retire an
  issue never presented to `commit_create`.
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

- Simultaneous independent creates can both POST; if both reach commit, B1 selects one card and closes the
  losing issue. An issue whose POST lands but never reaches commit can remain open and unlabelled.
- Sub-issue and dependency writes take GitHub's numeric issue **id**, never the issue number; the CardStore methods
  take a `bigint` id to make that hard to get wrong. The live E2E asserts both edges on GitHub.
- `kanbanCreate` takes a board id (uuid); an `owner/repo` alias is not yet accepted.
- Board CRUD exposes `epicMaxCards` / `epicMaxActive`; lowering a budget blocks new cards without changing replays.
