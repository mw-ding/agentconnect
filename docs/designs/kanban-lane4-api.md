# Kanban Lane 4 API contracts

Per-lane contract notes for the Kanban M5 and console work. Each lane edits only its own `##` section so parallel lanes merge cleanly. Parent tracking: [issue #2](https://github.com/mw-ding/agentconnect/issues/2).

## 4b

M5 console board view, the read-only BFF routes behind it, and `dispatch --dry-run` ("why isn't this card running?"). Everything here is **read-only and body-free**: the control plane (CP) still stores and sends no issue titles, bodies, or comments. The one exception is a live pass-through of titles to the console, described below, which is never written, logged, or cached.

All routes live under `/api/v1/orgs/:orgId/kanban/boards/:boardId`, are viewer-readable (`kanbanAccess: 'viewer'`) and check `canView` on the board. A board in another organization, a restricted board not shared with the caller, and a missing board or card all answer `404` `not_found`; no credentials answer `401`. A personal API key reaches these routes like any member (key permission `full` or `read`), because the routes read and never configure; only the existing run-mode `PUT` routes stay interactive-owner-only.

### Card list

`GET …/cards` returns CP metadata for the cards of one board, at most **500** (priority DESC, age ASC), with `total` and `truncated`. Per card: `id`, `issueNumber`, `status`, `assigneeAgentId` and `assignee {name, displayName}` (from the agent table), `priority`, `mode` (effective: the card override, else the board default) and `modeOverride`, `needsAttention` and `attentionReason`, `blockKind`, `consecutiveFailures`, `protocolViolations`, `blockRecurrence`, `cooldownUntil`, `notBefore`, `promotionPending`, `linkedPrNumber`, `stateRevision`, and `openRun {attempt, agentId, dispatchedAt, ackedAt, heartbeatAt}`. It never calls GitHub, so it works while GitHub is down.

### Live titles

`GET …/cards/titles?numbers=1,2,3` reads titles live from GitHub for up to **100** issue numbers that are cards of this board. It mints the existing read-scoped kanban card token (`mintKanbanCard(…, 'read')`, repository-scoped to the board's numeric repo id) and calls `GET /repositories/:repoId/issues/:n` with bounded concurrency (8). Response: `{ titles: { "<n>": { title, state: 'open'|'closed', htmlUrl } }, missing: number[] }` with `Cache-Control: no-store`.

- `missing` holds requested numbers that are not cards of this board (never sent to GitHub), and issues GitHub no longer serves (404/410), pull requests, and numbers that redirect to another issue or repository.
- `title` is **untrusted external text**: render it as plain text. Titles are never written to the database, never logged, never cached server-side. A PG test greps every `kanban_*` and `audit_event` row after a call.
- Errors, independent of the cards route: `400 invalid_numbers`, `400 too_many_numbers`, `409 github_app_not_configured` (no live installation or no GitHub source), `429 github_rate_limited`, `502 github_unavailable`. Messages never carry GitHub response text.

### Explain (dry run)

`GET …/explain` explains every card that is not `done` or `archived`; `GET …/cards/:cardId/explain` explains one card of any status. Per card: `cardId`, `issueNumber`, `status`, `verdict {eligible, role?, agentId?, gate?}`, `hint`, `facts`, `evaluatedAt`, and on the board route `claimOrder` / `capBound`. The board response adds `wouldClaimNext` (card ids) and `wouldClaimNextIssueNumbers`: the cards the next claim would take, in order.

- **One predicate.** The verdict is `explainClaim` (`control-plane/src/kanban/claim-eligibility.ts`, Lane 3's commit, cherry-picked verbatim). `claim-explain.ts` only gathers facts, replays the claim loop's order (priority DESC, createdAt ASC, id ASC) with the board and per-agent caps applied cumulatively, and holds the per-gate hint table. The hint table is a `Record` over every gate, so a gate Lane 3 adds fails the build until it has a hint.
- **Same liveness.** `isDaemonLive` is the connection registry's `READY` check, the same one the dispatcher hands the claim.
- **Cap deferral.** An eligible card the claim would skip because earlier cards fill a cap carries `capBound: 'board_cap' | 'agent_cap'` and is absent from `wouldClaimNext`.
- **Parity rule.** `test/integration/kanban-claim-explain.test.ts` runs `explainBoard` and then the real `claim()` over a matrix (one card per SQL gate plus eligible cards with binding caps) and asserts that the claimed ids equal `wouldClaimNext` in order and that every skipped card is ineligible or cap-bound. A gate added to the SQL claim without the predicate fails that test. `open_lease` is the one predicate gate with no SQL counterpart (the claim has no such check), so it is not in the matrix.
- **No side effects.** One repeatable-read read transaction, no locks, no writes. The routes make no audit row, no GitHub call, and do not wake the dispatcher; the route tests snapshot the card, run, and audit tables around the call.
- **Body-free.** `facts` holds booleans, counts, ids and timestamps only. `hint` is a static sentence per gate (for example "cooling down until <ts> after a failed run"), never issue text.

Gate codes: `board_disabled`, `status_not_claimable`, `promotion_pending`, `cooldown`, `not_before`, `no_assignee`, `agent_missing`, `agent_paused`, `agent_unplaced`, `daemon_offline`, `open_lease`, `board_cap`, `agent_cap`, `verifier_unset`, `verifier_is_worker`.

### Console

`/kanban` lists boards; `/kanban/[boardId]` shows the columns triage, todo, ready, running, blocked, review, done, archived (done and archived collapsed by default). Cards load from the card list; titles load after, fail on their own, and render as text nodes (a missing title shows `#n` only). Non-running cards offer "Why isn't this running?" backed by the card explain route. Owners (board `canEdit`) set the board default and per-card run mode through the existing `PUT …/mode` and `PUT …/cards/:cardId/mode`, after a confirm before write; `INTERACTIVE_AUTH_REQUIRED` and other stable codes show inline. Clearing `needsAttention` is Lane 3's restart route and is not in the console yet.

### CLI

```
agentconnect dispatch --dry-run --board <boardId> [--card <cardId> | --issue <n>] [--org <id|slug>] [--json]
```

Requires a personal API key via `--api-key <key>` or `AGENTCONNECT_API_KEY`; when absent the command exits non-zero with code `personal_api_key_required` and makes no HTTP request. It never falls back to the key `login` saves (`controlPlane.key` in `config.json`): that is the daemon key, and the console API refuses daemon principals with 401 (`authenticateUser` admits user/oauth principals only). Only the stored WebSocket URL seeds the REST base (`wss://host/daemon/ws` → `https://host/api/v1`), overridden by `--api-url`; `--org` is only needed when the key's user belongs to several organizations. The key is sent as a Bearer [REDACTED] and never printed. Output per card is `#n status → ELIGIBLE (work → agent <id>)` or `#n status → blocked by <gate>: <hint>`, then `would claim next: #a, #b` in board mode. `--issue` resolves through the card list. Exit code `0` whenever an explanation was produced (it is a diagnostic); non-zero with the HTTP status and stable `code` on auth, 404, or network errors. Without `--dry-run` it refuses: "only --dry-run is supported; dispatch runs in the control plane". No titles are printed.

The CLI uses the personal API key, not an interactive bearer: `rbac.ts` gates only the owner routes by default, and the explain routes opt out with `kanbanAccess: 'viewer'`, so `canView` decides and a personal-key principal of an org member passes. No `--token` flag is needed.
