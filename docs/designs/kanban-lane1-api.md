# Lane 1 frozen repo API (Kanban M1) — for Lanes 2/3/4

**Version:** 1.1 (2026-10-17, PR #136 review fixes)

Introduced on branch `backend/2-kanban-m1-gaps` in commit `df86b612e`. Path keys: `cp/` = `packages/control-plane/`.
These signatures are **frozen**. Changes after 1.0 are additive except where the change log says a field was
removed for safety. Every change is logged at the bottom of this file.

All types are exported from `cp/src/persistence/ports.ts`. The implementation is `PgKanbanCardRepo` in
`cp/src/persistence/repositories/kanban.repo.ts`, and the container exposes it as `repos.kanbanCard`.
Every write is body-free: GitHub ids, logins, statuses, agent ids, and CP config only.

## 1. Card upsert (auto-import + orchestrator `kanbanCreate`)

```ts
// ports.ts
export type KanbanInitialStatus = Exclude<KanbanStatus, 'running'>

export interface KanbanCardRow {
  id: string; boardId: string; issueId: bigint; issueNumber: number; issueNodeId: string | null
  idempotencyKey: string | null; status: KanbanStatus; assigneeAgentId: string | null
  priority: number; mode: 'read' | 'write' | null; stateRevision: bigint; dispatchRevision: bigint; createdAt: Date
}

export interface KanbanHumanAuthority {
  login: string                        // the GitHub login whose label set the status
  permission: RepoPermissionLevel      // its live level; must be admin | maintain | write
}

export interface KanbanCardUpsertInput {
  boardId: string
  expectedRepoId: bigint               // REQUIRED: the repository the issue was read from (repo fence)
  issueId: bigint                      // GitHub numeric issue id
  issueNumber: number
  issueNodeId?: string | null
  idempotencyKey?: string | null       // cardIdempotencyKey({ epic, step, spec }) from cp/src/kanban/card-key.ts
  status?: KanbanInitialStatus         // create-only; default 'triage'; see "Status authority"
  assigneeAgentId?: string | null      // create-only; must be an assignable agent of the board's org
  priority?: number                    // create-only; default 0
  source: string                       // audit tag, e.g. 'import' | 'orchestrator'
  actorUserId?: string | null
  actorAgentId?: string | null         // the orchestrator agent, if any
  humanAuthority?: KanbanHumanAuthority | null  // import path only; see "Status authority"
}
// There is no `mode` field (removed in 1.1). A new card always inherits board.defaultMode.

export interface KanbanCardUpsertResult {
  card: KanbanCardRow
  created: boolean
  matchedBy: 'created' | 'issue' | 'idempotency_key'
}

export type KanbanCardUpsertErrorCode =
  | 'board_not_found' | 'agent_not_in_org' | 'agent_not_assignable' | 'invalid_status'
  | 'status_not_allowed' | 'key_conflict' | 'repo_mismatch' | 'issue_mismatch'
export class KanbanCardUpsertError extends Error { readonly code: KanbanCardUpsertErrorCode }

// KanbanCardRepo
upsertCard(input: KanbanCardUpsertInput): Promise<KanbanCardUpsertResult>
findByIdempotencyKey(boardId: string, idempotencyKey: string): Promise<KanbanCardRow | null>
getCard(cardId: string): Promise<KanbanCardRow | null>
```

**Semantics**

- **Create-or-return, never update.** An existing card keeps its status, assignee, priority, and mode. The only field
  an upsert can change on an existing row is a null `idempotencyKey`, which gets the input key (see below).
- **Mode is never an input.** The insert always writes `mode: null` (inherit the board default), even if a `mode`
  property reaches the repo through a cast. The only way to override a card's mode is the interactive-owner path
  `KanbanModeAdminRepo.setCardMode`, which bumps `modeRevision` and writes a `kanban_mode_change` audit row.
- **Status authority.** Without a human authority only `triage` and `todo` are accepted, and neither can be claimed
  (a claim needs `ready` plus an assignee). Any other initial status (`ready`, `blocked`, `review`, `done`,
  `archived`) needs **all** of the following, or the upsert throws `status_not_allowed`:
  - `source === 'import'`
  - `actorAgentId` null or absent
  - a `humanAuthority` with a non-empty login and a write-level permission (`admin`, `maintain`, `write`)

  The created audit row records `details.humanAuthority: { login, permission }` (null when there was none). Agents
  move cards past `todo` only through the audited human-gated paths: 1b's `casStatus` / promotion flow, and
  `setCardMode` for mode. `running` is still refused with `invalid_status`.

- **Repository fence.** Inside the upsert transaction the board row is read with
  `SELECT "orgId", "repoId" FROM "kanban_board" WHERE "id" = $1 FOR SHARE`. `updateBoard` takes `FOR UPDATE`, so a
  retarget can't interleave. If the board's `repoId` differs from `expectedRepoId`, the upsert throws `repo_mismatch`
  and writes nothing. That check comes before every path, including a return of an existing card. The org and
  assignee checks run under the same lock.
- **Resolution order.**
  1. Try `INSERT … ON CONFLICT DO NOTHING`, which covers the uniques `(boardId, issueId)`, `(boardId, issueNumber)`,
     and `(boardId, idempotencyKey)`. On insert it returns `created: true, matchedBy: 'created'` and writes one
     `AuditEvent` (`kind: 'kanban_card_change'`, `details.change: 'created'`) in the same transaction.
  2. If a key was given and a card already has it, that card comes back with
     `created: false, matchedBy: 'idempotency_key'`, **even if it names a different issue**.
  3. Otherwise the card for this issue comes back (`matchedBy: 'issue'`):
     - If that card matched by number but has a different `issueId`, the upsert throws `issue_mismatch`.
     - If that card has no key and one was given, the key is attached and a `kanban_card_change` audit row is
       written (`details.change: 'key_attached'`).
- **Race-safe.** N concurrent upserts for one issue, or one key, give exactly one row and one created-audit row, and
  every caller gets the same `card.id`. It's safe inside an ambient Prisma transaction, because a conflict never
  aborts it. The insert uses `ON CONFLICT DO NOTHING`. Key adoption runs under `SAVEPOINT kanban_key_adopt`, so a
  racing P2002 rolls back only to the savepoint, and the loop re-reads and returns the winning card.
- **Errors** (`KanbanCardUpsertError.code`):
  - `board_not_found`
  - `repo_mismatch`: the board now watches a different repository than `expectedRepoId`
  - `agent_not_in_org`: the assignee isn't an agent of the board's org
  - `agent_not_assignable`: the assignee is a `restricted` agent (see §2 policy)
  - `invalid_status`: `running` or an unknown status
  - `status_not_allowed`: a status past `todo` without a valid human authority
  - `key_conflict`: the issue's card already carries a **different** non-null key
  - `issue_mismatch`: the issue number's card belongs to a different GitHub issue id

  Any other error is a DB failure. One more: if the conflicting row is deleted three times between the insert and
  the re-read, it throws a plain `Error`.

**Lane 2 `kanbanCreate` recipe**

```ts
const key = cardIdempotencyKey({ epic: String(epicIssueId), step, spec })
const existing = await repos.kanbanCard.findByIdempotencyKey(boardId, key)
if (existing) return existing                       // re-plan: never file a second issue
const issue = await fileIssueOnGitHub(...)          // App token; labels incl. ac/status:todo (or triage)
const { card, created, matchedBy } = await repos.kanbanCard.upsertCard({
  boardId, expectedRepoId: board.repoId, issueId: BigInt(issue.id), issueNumber: issue.number,
  issueNodeId: issue.node_id, idempotencyKey: key, status: 'todo', assigneeAgentId,
  source: 'orchestrator', actorAgentId: orchestratorAgentId
})
if (!created && matchedBy === 'idempotency_key' && card.issueNumber !== issue.number) {
  // A concurrent create won the key; close our duplicate issue (state_reason not_planned).
}
// Getting to ready goes through the human-gated promotion path (Lane 1b), never through upsert.
```

## 2. `ac/agent:<slug>` → assignee

```ts
// cp/src/kanban/agent-label.ts (pure)
export const AGENT_LABEL_PREFIX = 'ac/agent:'
export function agentLabel(slug: string): string
export type AgentLabelParse =
  | { kind: 'none' }
  | { kind: 'agent'; slug: string }
  | { kind: 'conflict'; slugs: string[] } // ≥2 distinct valid slugs
  | { kind: 'malformed'; labels: string[] } // any unparseable ac/agent:* (and <2 valid slugs)
export function parseAgentLabel(labels: readonly string[]): AgentLabelParse
```

The prefix match and the slug are case-insensitive, and the slug is lowercased. A valid slug matches
`^[a-z0-9][a-z0-9-]{0,62}$`. Treat `conflict` and `malformed` as "no confident assignee": keep the current one.

```ts
// KanbanCardRepo
resolveAgentSlug(orgId: string, slug: string): Promise<string | null>   // see assignee policy
setAssignee(input: KanbanSetAssigneeInput): Promise<KanbanSetAssigneeResult>

export interface KanbanLeaseRef { leaseId: string; runId: string; agentId: string; daemonId: string; dispatchRevision: bigint }
export interface KanbanSetAssigneeInput {
  cardId: string
  agentId: string | null                 // null = unassign
  expectedDispatchRevision?: bigint      // optional CAS
  onLease?: 'refuse' | 'revoke'          // default 'refuse'
  now: Date
  source: string                         // audit tag: 'label' | 'orchestrator' | 'api' …
  actorUserId?: string | null
  actorAgentId?: string | null
}
export type KanbanSetAssigneeResult =
  | { ok: true; changed: boolean; card: KanbanCardRow; previousAgentId: string | null; revokedLease: KanbanLeaseRef | null }
  | { ok: false; reason: 'not_found' | 'stale' | 'agent_not_in_org' | 'agent_not_assignable' }
  | { ok: false; reason: 'leased'; lease: KanbanLeaseRef }
```

**Assignee policy (1.1).** One policy covers `resolveAgentSlug`, `upsertCard`, and `setAssignee`:

- An assignee must be an agent of the board's org (otherwise `agent_not_in_org`).
- It must not have `visibility: 'restricted'`. Restricted agents serve a named member audience, never a board-wide
  label. `resolveAgentSlug` returns `null` for them; `upsertCard` throws `agent_not_assignable` and `setAssignee`
  returns `{ ok: false, reason: 'agent_not_assignable' }`.
- `status` (`active` / `inactive` / `paused`) is **not** part of the policy. It's a runtime state: the claim already
  skips paused agents' cards, and the card runs once the agent resumes.

Unknown, deleted, or renamed agents resolve to `null`.

**Semantics.** Everything runs in one transaction under `SELECT … FOR UPDATE` on the card. That serializes it against a
claim (claims `SKIP LOCKED` card rows) and against run ends.

- If the assignee is unchanged, it returns `ok: true, changed: false` and writes nothing, even while leased.
- If the card is unleased, it sets `assigneeAgentId`, bumps `dispatchRevision` (status and `stateRevision` stay), and
  writes an audit row (`details.change: 'assignee'`).
- If the card has an open run and `onLease` is `'refuse'` (the default), it returns `{ ok: false, reason: 'leased', lease }`
  and changes nothing.
- If the card has an open run and `onLease` is `'revoke'`, it applies the reassign rule (spike §5) and never transfers:
  - the open run ends with `outcome: 'reclaimed'` and `reasonCode: 'reassigned'`, which doesn't count as a failure
  - `dispatchRevision` gets bumped, which fences the old holder's heartbeat, report, and comment grant
  - a `running` card goes back to `ready` (`stateRevision` +1, promotion and attention fields cleared)
  - the audit row records `revokedLeaseId`

  It returns `revokedLease`. **The caller then** cancels that lease's turns (`agentId`/`daemonId`), posts the fixed
  comment `planReassign(...)` renders ("reassigned from X to Y; restarting in a new session"), and pokes the board
  claim. The next claim opens a new run and a new session under the same `github#n` key.

- A stale `expectedDispatchRevision` returns `stale`.

**Lane 2 `kanbanAssign` recipe**

```ts
const agentId = await repos.kanbanCard.resolveAgentSlug(board.orgId, slug)
if (!agentId) throw new Error('unknown or unassignable agent slug')
const r = await repos.kanbanCard.setAssignee({
  cardId,
  agentId,
  onLease: 'revoke',
  now,
  source: 'orchestrator',
  actorAgentId
})
if (r.ok && r.revokedLease) {
  /* cancel turns on r.revokedLease.daemonId, post planReassign comment, poke claim */
}
// Then mirror the ac/agent:<slug> label on GitHub through the CardStore (Lane 1b keeps label→DB in sync).
```

## 3. Live repository permission (shared with Lane 3)

```ts
// cp/src/github/repo-permission.ts
export type RepoPermissionLevel = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none'
export interface RepoPermissionTarget {
  installationId: bigint
  repoId: bigint
  repoFullName: string
} // = KanbanRepoRef
export interface RepoPermissionLookup {
  permission(repo: RepoPermissionTarget, login: string): Promise<RepoPermissionLevel>
}
export function hasWriteAccess(level: RepoPermissionLevel): boolean // admin | maintain | write
export function parseRepoPermission(res: { permission?: string; role_name?: string }): RepoPermissionLevel
export class GithubRepoPermission implements RepoPermissionLookup {
  constructor(deps: {
    tokens: Pick<InstallationTokenService, 'mintKanbanCard'>
    fetchImpl?
    baseUrl?
    ttlMs?: number /* default 60s, 0 = off */
    now?: () => number
  })
}
export async function checkWriteAccess(
  lookup,
  repo,
  login
): Promise<{ level: RepoPermissionLevel; write: boolean; error?: unknown }>
```

`GithubRepoPermission` calls `GET /repositories/{repoId}/collaborators/{login}/permission` with a read-scoped
`kanban_card` installation token. Addressing by repo id means a rename can't misroute the call. In the E2E, the PAT
seam `{ mintKanbanCard: async () => ({ token }) }` works unchanged.

- 404 and 422 mean `'none'`: a non-collaborator or an unknown login.
- Any other failure throws.
- **Only non-write results are cached** (`triage`, `read`, `none`), keyed by `repoId:login` (case-insensitive) with a
  60s TTL. `admin`, `maintain`, and `write` are never cached, so every positive gate is a live check:
  - a demoted writer is refused immediately
  - a GitHub outage after a positive result fails closed through `checkWriteAccess`

  A cached negative can delay a newly promoted collaborator by up to the TTL, which is the safe direction. Failures
  are never cached.

- **Gate with `checkWriteAccess`.** It fails closed: a throw becomes `{ write: false, error }`.

`GithubService.userRepoPermission*` (hooks / comment authz) now shares `parseRepoPermission`, with unchanged behavior
(maintain folds to write there).

## 4. Auto-import attribution (`cp/src/kanban/importer.ts`)

`KanbanImporter` imports a status-labeled issue that has no card yet. Its status is **kept** only when all of these
hold:

1. The issue author has live write access (`checkWriteAccess`).
2. Exactly one well-formed, non-`running` `ac/status:*` label is on the issue, and the latest `labeled` event for that
   label has an actor that:
   - passes `isHumanActor` (a `User`, not a `[bot]` login, no `performed_via_github_app`)
   - is not `isAppActor(event, appSlug)`
   - has live write access
3. If the events contain any `transferred` event, the latest one's actor (the transferrer) passes the same human +
   live-write check.

Events come from `CardStore.readLabelEvents(repo, issueNumber)`. It returns body-free `LabelEvent`s (id, event,
label name, actor type/login, an App flag), oldest first, using the existing newest-first pagination and page cap. A
history past the cap throws.

If anything can't be attributed, the card is imported as **`triage`** rather than skipped. That covers a missing
labeled event, a failed events read, a bot, App, or App-on-behalf actor, a non-writer, and a permission lookup that
throws. This matches TRD §7 ("cards from authors without write access land in `triage` and are never
auto-dispatched") and the existing store semantics: a triage card is visible on the board, but a claim needs `ready`
plus an assignee, and a human must move it. The importer also writes the `ac/status:triage` label first, so GitHub
agrees.

- **Assignee.** The importer stores an `ac/agent:` pick only when the status was kept **and** every current
  `ac/agent:*` label's latest `labeled` event passes the same human + live-write check. Otherwise
  `assigneeAgentId: null`.
- **Human authority.** When the status is kept, the upsert carries `humanAuthority: { login, permission }` from the
  status label's adder, and nothing else does.
- **Lookups and logs.** Permission lookups are deduplicated per login (case-insensitive) within one import. Errors are
  logged at warn level and body-free: board id, issue number, a reason (`events_unreadable` /
  `permission_lookup_failed`), the error class, and the HTTP status. Error messages are never logged.
- **Wiring.** The container passes `appSlug: githubAppCfg?.slug` and the HTTP logger.

## 5. Board routes (`cp/src/http/routes/kanban.ts`)

**Stable refusal codes.** Every refusal body carries `code`, so clients branch on the code, never the message.

| HTTP | `code`                      | When                                                            |
| ---- | --------------------------- | --------------------------------------------------------------- |
| 404  | `not_found`                 | board or card is missing, invisible, or in another org          |
| 400  | `agent_not_in_org`          | orchestrator/verifier is not an agent of the org                |
| 400  | `empty_audience`            | restricted board with no current member in `sharedWith`         |
| 409  | `repo_taken`                | the org already has a board for the repository                  |
| 409  | `repo_has_cards`            | retargeting a board that has cards                              |
| 409  | `active_runs`               | deleting a board while a card holds an open lease               |
| 409  | `repo_changed`              | PATCH without `repoFullName` re-resolved to a different repo id |
| 400  | `repo_not_covered`          | resolver: no live installation of the org covers the repository |
| 409  | `github_app_not_configured` | resolver: the deployment has no GitHub App                      |
| 429  | `github_rate_limited`       | resolver: GitHub rate limit                                     |
| 502  | `github_unavailable`        | resolver: other GitHub API failure                              |

Request-validation 400s from the schema layer and the auth layer's 401/403s keep their existing shapes. The auth
layer's interactive-only 403 already carries `INTERACTIVE_AUTH_REQUIRED`.

**Owner gate is default-on.** `ownerGateByDefault(app)` adds an `onRoute` hook to the plugin that prepends
`interactiveOwner` (interactive OIDC sign-in plus the org `owner` role) to every route's `preValidation`. A route
opts out only with `config: { kanbanAccess: 'viewer' }`, and its handler must then do its own `canView` check.
Today only the two board reads (`GET /kanban/boards`, `GET /kanban/boards/:boardId`) opt out. A route that Lanes 2–4
add to this plugin is owner-only unless it says otherwise.

## 6. Audit kinds

Migration `20261122100000_kanban_board_card_audit` adds `AuditKind` values `kanban_board_change` (board CRUD, PR 1a)
and `kanban_card_change` (create, key attach, assignee, and, in 1b, every status transition). It was renamed from
`20261122000000_…` before shipping, so it sorts after upstream's `20261122000000_googlechat_session_audience`. Other
lanes shouldn't reuse the `20261122*` timestamps.

## Change log

- 2026-10-16 PR 1a review: additive `KanbanBoardWriteRefusal` member `repo_has_cards` (HTTP 409) prevents rebinding a
  populated board to a different numeric repository. Frozen card/permission signatures unchanged. Board create and
  update now participate in shared membership locking, and member removal repairs board audiences.
- 2026-10-17 v1.1, PR #136 review fixes:
  - **Removed** `KanbanCardUpsertInput.mode`. New cards always inherit the board default, and only `setCardMode`
    overrides it. This breaks the "additive only" rule on purpose: the field let a non-human caller mint a write
    lease.
  - **Required** `KanbanCardUpsertInput.expectedRepoId`, checked under `FOR SHARE` on the board row.
  - **Added** `KanbanCardUpsertInput.humanAuthority` and `KanbanHumanAuthority`. Statuses past `todo` require a
    write-level human authority, `source: 'import'`, and no `actorAgentId`.
  - **Added** upsert error codes `status_not_allowed`, `repo_mismatch`, `issue_mismatch`, and `agent_not_assignable`.
  - **Added** the `setAssignee` refusal reason `agent_not_assignable`.
  - `resolveAgentSlug` now returns `null` for restricted agents. The assignee policy is documented in §2.
  - Key adoption runs under a savepoint and writes a `key_attached` audit row.
  - `GithubRepoPermission` no longer caches write-level results.
  - Added `CardStore.readLabelEvents`. The importer attributes status, agent, and transfer events (§4) and takes the
    `appSlug` and `log` deps.
  - Board routes carry stable `code`s (§5), and the plugin's owner gate is default-on with a `kanbanAccess: 'viewer'`
    opt-out.
  - Migration renamed to `20261122100000_kanban_board_card_audit`.
