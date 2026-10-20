# Kanban Lane 4 API contracts

Per-lane contract notes for the Kanban M5 and console work. Each lane edits only its own `##` section so parallel lanes merge cleanly. Parent tracking: [issue #2](https://github.com/mw-ding/agentconnect/issues/2).

## 4a

M5 Projects v2 `Status` projection (org-owned only) plus the consolidated design at [kanban-swarm.md](kanban-swarm.md). Issues and labels stay the system of record; the project's `Status` single-select field is a one-way, best-effort mirror the CP writes for humans.

Board fields: `POST` and `PATCH /api/v1/orgs/:orgId/kanban/boards` accept optional `projectNodeId` + `statusFieldId`, both-or-neither. The pair is stored on the board and returned in the board DTO. `PATCH { projectNodeId: null, statusFieldId: null }` clears both without minting a Projects token or calling Projects; the normal live repository coverage check still runs. Changing the repo (`repoFullName`) or setting a new pair re-proves the guard; PATCH compares the validated `configRevision` under the board lock and returns HTTP 409 `stale` if a concurrent edit invalidated that snapshot; without a verifier/GitHub App the create path refuses with `github_app_not_configured` (409). Migration `20261123300000_kanban_board_project_projection` adds the two board columns with a both-null-or-both-set CHECK, plus `kanban_card.projectItemId`, a cache of the `ProjectV2Item` id so later writes skip the add. Migration `20261123300100_kanban_card_project_item_project` adds `kanban_card.projectItemProjectId`, the project that item belongs to: an item cached for any other project (a re-pointed board) or with no recorded project (a legacy row) is never reused, and the card is re-added through the idempotent add.

Re-pointing a board from P1 to P2 does **not** backfill existing cards. A card appears on P2 only at its next committed status change.

Refusal codes (HTTP 400 unless noted):

| HTTP | `code`                      | When                                                                                                                                                |
| ---- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `project_requires_org_repo` | the board's repo owner is not an Organization                                                                                                       |
| 400  | `project_not_found`         | the project is missing, or the token cannot see it (GraphQL FORBIDDEN/NOT_FOUND, HTTP 403/404/422 on the guard read); never leaks GitHub error text |
| 400  | `project_not_org_owned`     | the project is owned by a User                                                                                                                      |
| 400  | `project_owner_mismatch`    | the project's org login differs from the repo owner (case-insensitive)                                                                              |
| 400  | `status_field_invalid`      | `statusFieldId` is not a single-select field of that project                                                                                        |
| 409  | `github_app_not_configured` | project fields given with no verifier/GitHub App                                                                                                    |
| 429  | `github_rate_limited`       | GitHub rate limit                                                                                                                                   |
| 502  | `github_unavailable`        | every other GitHub API failure, including an HTTP 401 (our own App credential misconfig, never a project verdict)                                   |

The guard is pure (`judgeProjectConfig`) over the repo owner type plus one live GraphQL read of `node(id:) { ... on ProjectV2 { owner, field } }` with `strictErrors`, so a 200 carrying `errors[]` beside partial data still denies as `project_not_found` with log reason `project_access_denied`.

Required Status options: the field must offer one option per CP status, named `Triage`, `Todo`, `Ready`, `Running`, `Blocked`, `Review`, `Done`, `Archived` (matched case-insensitively, so `ready` or `READY` also work). Nothing else is mapped: GitHub's default Status field (`Todo`, `In Progress`, `Done`) projects only `todo` and `done`, and every other status logs `project_option_missing` with no write until the admin adds the missing options (`In Progress` is never used).

Token scope: the `kanban_project` token is minted with `repository_ids: [boardRepoId]`, but only the repository permissions (`issues:read`, `metadata:read`) are narrowed by it. `organization_projects:write` is an organization permission and applies to every project of the installation's org; GitHub offers no per-project or per-repo narrowing, so this is the least privilege available. The runtime owner check below keeps writes on the board's own org.

Writer contract (`cp/src/kanban/project-writer.ts`, `KanbanProjectWriter.project`): mint the `kanban_project` token; read the field's options and owner, cached per (installation id, project, field) for 5 minutes in a bounded map (256 entries, least recently used evicted) that drops an entry whenever a status write fails, so a deleted option is re-read on the next write; re-check the cached owner is an Organization whose login equals the board repo owner case-insensitively (`project_owner_mismatch` otherwise, with no write, which also covers a dev PAT that can reach other orgs); resolve the option; reuse the cached item only when `projectItemProjectId` is this project, else `addProjectV2ItemById` (idempotent); then `updateProjectV2ItemFieldValue`. When a write on a cached item fails with GraphQL `NOT_FOUND` (the item was removed from the project by hand), the writer re-adds once, writes again, and returns the new id; FORBIDDEN stays a denial and never re-adds. The hook stores the item id with its project whenever either changed.

Post-commit seam (`kanbanProjectHook`, `onStatusCommitted({ boardId, issueNumber, issueNodeId? })`): every committed card status change calls it once after its transaction: dispatcher transitions (ack → running, run end, reaper, a dispatch that finds GitHub moved the card), human recovery (`ingestStatus`), graph promotion (todo → ready once the intent clears, its rollback, and recovery's adopt/clear/escalate), the #194 KanbanSync reconcile (human label adoption, reassignment restart, fail-closed), import, and Lane 2b orchestrator creation, unblock, reassignment restart and epic-budget fallback. Sync queues each status immediately after the repository commit, before revocation, label/comment writes, acknowledgement or promotion can fail; assignment-only changes and failed commits queue nothing. It returns at once and runs on its own per-card queue, apart from label writes, so a slow Projects write never delays a later label write for that card. Each run projects the card's status as committed when the run starts, so a burst of commits coalesces into one queued run and out-of-order callers still converge on the latest status. The projection never blocks or fails a transition: every failure is logged with a body-free reason and swallowed. Project UI edits are not reconciled: nothing reads the `Status` field back, so a human edit there stays until the card's next committed status change overwrites it (known gap).

Shutdown settles the dispatcher and graph-doorbell producers (including their sync, graph and import work) before settling the projection queue and disconnecting Prisma. Lane 3 M4 (Refs #414) is integrated: worker review requests, verifier approvals that change status, request-changes returns to ready, and the review-round limit to triage use the same post-commit seam. A verify claim or PR-contract approval that keeps the card in review queues no status projection.

Failure reason codes: `project_issue_node_missing` (skip before minting), `project_not_org_owned` (runtime re-check), `project_owner_mismatch` (runtime owner-login re-check), `project_option_missing`, `project_item_add_failed`, `project_field_write_failed`, `project_item_missing` (a cached item answered NOT_FOUND; one line with `recovered: true`, or `recovered: false` plus the failing step's reason as `cause`), `project_access_denied` (a GitHub denial: GraphQL FORBIDDEN/NOT_FOUND, HTTP 403/404/422), `project_rate_limited` (RATE_LIMITED). An HTTP 401 is our credential misconfig and logs the step's own reason. Board without a pair means no mint and no call.

Re-consent note: the GitHub App manifest now requests `organization_projects:write`. Existing installations must re-consent (GitHub emails the org owner); until then the projection fails closed with `project_access_denied` and transitions keep working.

Still **UNVERIFIED until Block B (the MD-gated live test)** runs:

- The real `addProjectV2ItemById` / `updateProjectV2ItemFieldValue` calls against an org project.
- A token mint combining `repository_ids` with `organization_projects`.
- The real error types for an installation that has not re-consented, and for a removed item (`project_item_missing` assumes GraphQL `NOT_FOUND`).
- The option id format.
- The end-to-end transition → Status flow.

## 4b

M5 console board view, the read-only BFF routes behind it, and `dispatch --dry-run` ("why isn't this card running?"). Everything here is **read-only and body-free**: the control plane (CP) still stores and sends no issue titles, bodies, or comments. The one exception is a live pass-through of titles to the console, described below, which is cached in memory for 60 s, never persisted or logged.

All routes live under `/api/v1/orgs/:orgId/kanban/boards/:boardId`, are viewer-readable (`kanbanAccess: 'viewer'`) and check `canView` on the board. A board in another organization, a restricted board not shared with the caller, and a missing board or card all answer `404` `not_found`; no credentials answer `401`. A personal API key reaches these routes like any member (key permission `full` or `read`), because the routes read and never configure; only the existing run-mode `PUT` routes stay interactive-owner-only.

### Card list

`GET …/cards` returns CP metadata for the cards of one board, at most **500** (priority DESC, age ASC), with `total` and `truncated`. Per card: `id`, `issueNumber`, `status`, `assigneeAgentId` and `assignee {name, displayName}` (from the agent table), `priority`, `mode` (effective: the card override, else the board default) and `modeOverride`, `needsAttention` and `attentionReason`, `blockKind`, `consecutiveFailures`, `protocolViolations`, `blockRecurrence`, `cooldownUntil`, `notBefore`, `promotionPending`, `linkedPrNumber`, `stateRevision`, and `openRun {attempt, agentId, dispatchedAt, ackedAt, heartbeatAt}`. It never calls GitHub, so it works while GitHub is down. With `?numbers=1,2,3` it returns only those issue numbers (a viewer-checked by-number lookup over the same board; `total` counts the match and the view is never truncated) — the dry run resolves `--issue` through it so a board past the 500 cap can never read as "no card #N".

### Live titles

`GET …/cards/titles?numbers=1,2,3` reads titles live from GitHub for up to **100** issue numbers that are cards of this board. It mints the existing read-scoped kanban card token (`mintKanbanCard(…, 'read')`, repository-scoped to the board's numeric repo id) and calls `GET /repositories/:repoId/issues/:n` with bounded concurrency (8). Response: `{ titles: { "<n>": { title, state: 'open'|'closed', htmlUrl } }, missing: number[] }` with `Cache-Control: no-store`.

- `missing` holds requested numbers that are not cards of this board (never sent to GitHub), and issues GitHub no longer serves (404/410), pull requests, and numbers that redirect to another issue or repository.
- `title` is **untrusted external text**: render it as plain text. Titles are cached in memory for 60 s (bounded at 2000 entries with oldest-first eviction, installation/repository/issue-scoped single-flight so concurrent authorized requests share one GitHub call, stale entries revalidated with `If-None-Match` where a 304 refreshes the TTL), never persisted or logged. Missing numbers use the same short TTL before being checked again. A PG test greps every `kanban_*` and `audit_event` row after a call.
- The console requests titles only for rendered, non-terminal cards (never done/archived, never collapsed columns, narrowed by the needs-attention filter) and never polls them: one fetch per visible card set. When one read of a request fails with a rate limit or 5xx, the remaining workers take no further numbers.
- Errors, independent of the cards route: `400 invalid_numbers`, `400 too_many_numbers`, `409 github_app_not_configured` (no live installation or no GitHub source), `429 github_rate_limited`, `502 github_unavailable`. Messages never carry GitHub response text.

### Explain (dry run)

`GET …/explain` explains every card that is not `done` or `archived`; `GET …/cards/:cardId/explain` explains one card of any status. Per card: `cardId`, `issueNumber`, `status`, `verdict {eligible, role?, agentId?, gate?}`, `hint`, `facts`, `evaluatedAt`, and on the board route `claimOrder` / `capBound`. The board response adds `wouldClaimNext` (card ids) and `wouldClaimNextIssueNumbers`: the cards the next claim would take, in order.

- **One predicate.** The verdict is `explainClaim` (`control-plane/src/kanban/claim-eligibility.ts`, shared with main’s dispatcher contract). `claim-explain.ts` only gathers facts, replays the claim loop's order (priority DESC, createdAt ASC, id ASC) with board, per-agent, epic and cross-board daemon caps applied cumulatively, and holds the per-gate hint table. The hint table is a `Record` over every gate, so a gate Lane 3 adds fails the build until it has a hint.
- **Same liveness.** `isDaemonLive` is the connection registry's `READY` check, the same one the dispatcher hands the claim.
- **Cap deferral.** An eligible card the claim would skip because earlier cards fill a cap carries `capBound: 'board_cap' | 'agent_cap' | 'epic_cap' | 'daemon_cap'` and is absent from `wouldClaimNext`.
- **Parity rule.** `test/integration/kanban-claim-explain.test.ts` runs `explainBoard` and then the real `claim()` over a matrix (one card per SQL gate plus eligible cards with binding caps) and asserts that the claimed ids equal `wouldClaimNext` in order and that every skipped card is ineligible or cap-bound. A gate added to the SQL claim without the predicate fails that test. The matrix includes open leases, flagged cards, verified review cards, every prior work agent, and work/verify capacity.
- **No side effects.** One repeatable-read read transaction, no locks, no writes. The routes make no audit row, no GitHub call, and do not wake the dispatcher; the route tests snapshot the card, run, and audit tables around the call.
- **Body-free.** `facts` holds booleans, counts, ids and timestamps only. `hint` is a static sentence per gate (for example "cooling down until <ts> after a failed run"), never issue text.

Gate precedence: `board_disabled`, `status_not_claimable`, `verifier_unset`, `verified`, `needs_attention`, `promotion_pending`, `cooldown`, `not_before`, `open_lease`, `no_assignee`, `agent_missing`, `agent_paused`, `agent_unplaced`, `board_cap`, `agent_cap`, `daemon_offline`, `epic_cap`, `daemon_cap`, `verifier_is_worker`.

### Console

`/kanban` lists boards; `/kanban/[boardId]` shows the columns triage, todo, ready, running, blocked, review, done, archived (done and archived collapsed by default). Cards load from the card list; titles load after, fail on their own, and render as text nodes (a missing title shows `#n` only). Non-running cards offer "Why isn't this running?" backed by the card explain route. Owners (board `canEdit`) set the board default and per-card run mode through the existing `PUT …/mode` and `PUT …/cards/:cardId/mode`, after a confirm before write; `INTERACTIVE_AUTH_REQUIRED` and other stable codes show inline. Clearing `needsAttention` is Lane 3's restart route and is not in the console yet.

### CLI

```
agentconnect dispatch --dry-run --board <boardId> [--card <cardId> | --issue <n>] [--org <id|slug>] [--json]
```

Requires a personal API key via `--api-key <key>` or `AGENTCONNECT_API_KEY`; when absent the command exits non-zero with code `personal_api_key_required` and makes no HTTP request. It never falls back to the key `login` saves (`controlPlane.key` in `config.json`): that is the daemon key, and the console API refuses daemon principals with 401 (`authenticateUser` admits user/oauth principals only). Only the stored WebSocket URL seeds the REST base (`wss://host/daemon/ws` → `https://host/api/v1`), overridden by `--api-url`; `--org` is only needed when the key's user belongs to several organizations. The key is sent as a Bearer [REDACTED] and never printed. Output per card is `#n status → ELIGIBLE (work → agent <id>)` or `#n status → blocked by <gate>: <hint>`, then `would claim next: #a, #b` in board mode. `--issue` resolves through the `?numbers=` lookup. `--org` accepts an id or a slug (slugs resolve through `/orgs`; unknown names fail with `not_found` before any board route is touched). Exit code `0` whenever an explanation was produced (it is a diagnostic); non-zero with the HTTP status and stable `code` on auth, 404, or network errors. Without `--dry-run` it refuses: "only --dry-run is supported; dispatch runs in the control plane". No titles are printed.

The CLI uses the personal API key, not an interactive bearer: `rbac.ts` gates only the owner routes by default, and the explain routes opt out with `kanbanAccess: 'viewer'`, so `canView` decides and a personal-key principal of an org member passes. No `--token` flag is needed.
