# Lane 3 Kanban claim-eligibility predicate (frozen contract)

**Version:** 1.2 (2026-10-18)

The pure claim predicate is `explainClaim` in `cp/src/kanban/claim-eligibility.ts`
(`cp/` = `packages/control-plane/`). Lane 4's `dispatch --dry-run` calls it to explain
"why isn't this card running". The SQL claim in
`cp/src/persistence/repositories/kanban-dispatch.repo.ts` `claim()` remains the
authority; this predicate mirrors it gate for gate and must never disagree on
whether a card is claimable.

Changelog: 1.2 adds `board.paused` and the `board_paused` gate immediately after `board_disabled`, preserving v1.1 review routing, `verified`, `needs_attention`, and any-attempt B8 ordering.

## Signature

```ts
export type ClaimRole = 'work' | 'verify'

export type ClaimGate =
  | 'board_disabled'
  | 'board_paused'
  | 'status_not_claimable'
  | 'promotion_pending'
  | 'cooldown'
  | 'not_before'
  | 'no_assignee'
  | 'agent_missing'
  | 'agent_paused'
  | 'agent_unplaced'
  | 'daemon_offline'
  | 'open_lease'
  | 'board_cap'
  | 'agent_cap'
  | 'verifier_unset'
  | 'verifier_is_worker'
  | 'verified'
  | 'needs_attention'

export type ClaimVerdict = { eligible: true; role: ClaimRole; agentId: string } | { eligible: false; gate: ClaimGate }

export interface ClaimAgentFacts {
  exists: boolean
  paused: boolean
  daemonId: string | null
  daemonLive: boolean
}

export interface ClaimEligibilityInput {
  board: { enabled; paused; verifierAgentId; maxInProgress; maxInProgressPerAgent }
  card: {
    status
    assigneeAgentId
    promotionPending
    cooldownUntil
    notBefore
    verifiedAt
    needsAttention
    hasOpenLease
  }
  assignee: ClaimAgentFacts | null
  verifier: ClaimAgentFacts | null
  workAgentIds: readonly string[]
  openRunCount: number
  openRunCountForAssignee: number
  openRunCountForVerifier: number
  now: Date
}

export function explainClaim(input: ClaimEligibilityInput): ClaimVerdict
```

Input is plain data: the card, board, agent/daemon facts, open-lease counts, and `now`.
No I/O, no Prisma, no frames.

## Gate codes and ordering

A card is checked in the SQL claim's own order, and the first blocking gate wins: first
the claim's row filters (its `WHERE`/`JOIN`), then the per-candidate checks of its loop
(the board's room, the target agent's share, daemon liveness, and B8 last).

A `ready` card is a **work** claim to `assigneeAgentId`. A `review` card on a board with a
`verifierAgentId` is a **verify** claim to that verifier: the agent gates read the verifier's facts and
`agent_cap` reads `openRunCountForVerifier`.

| #   | Gate                   | Condition                                                                                  |
| --- | ---------------------- | ------------------------------------------------------------------------------------------ |
| 1   | `board_disabled`       | the board is not enabled                                                                   |
| 2   | `board_paused`         | the board is paused; open runs can still report and expire                                 |
| 3   | `status_not_claimable` | status is neither `ready` nor `review`                                                     |
| 4   | `verifier_unset`       | status is `review` and the board has no `verifierAgentId`                                  |
| 5   | `verified`             | status is `review` and `verifiedAt` is set: the verifier approved under a PR contract      |
| 6   | `needs_attention`      | the card is flagged for a human (B8 or an escalation)                                      |
| 7   | `promotion_pending`    | the card holds a pending graph promotion                                                   |
| 8   | `cooldown`             | `cooldownUntil` is in the future                                                           |
| 9   | `not_before`           | `notBefore` is in the future                                                               |
| 10  | `open_lease`           | an open (un-ended) run already holds the card                                              |
| 11  | `no_assignee`          | no target agent id (assignee for work, verifier for verify)                                |
| 12  | `agent_missing`        | the target agent row is gone                                                               |
| 13  | `agent_paused`         | the target agent is paused                                                                 |
| 14  | `agent_unplaced`       | the target agent has no daemon placement                                                   |
| 15  | `board_cap`            | the board's open runs have reached `maxInProgress`                                         |
| 16  | `agent_cap`            | the target agent's open runs have reached `maxInProgressPerAgent`                          |
| 17  | `daemon_offline`       | the target agent's daemon has no live connection                                           |
| 18  | `verifier_is_worker`   | status is `review` and the verifier is the assignee or wrote any work run on the card (B8) |

`verifier_is_worker` is last because the claim evaluates B8 on the locked candidate, after
its cap and liveness checks; that is also where it flags the card for a human.
`needs_attention` holds a flagged card in any status: B8 leaves its card in `review`, and
a human-attributed status label the dispatcher ingests or an authorized owner restart clears the flag. Skip archives the card. Editing the board, such as fixing `verifierAgentId`, never
releases it on its own.

## SQL/predicate parity rule

For every card, `explainClaim` returns `eligible: true` if and only if
`PgKanbanDispatchRepo.claim` mints a lease for it. A `pg` integration test
(`cp/test/integration/kanban-claim-eligibility.test.ts`) builds one card per gate
plus eligible cards, reads both paths against real Postgres, and asserts agreement.
When you change a claim gate in the SQL, change `explainClaim` in the same commit —
and vice versa.

## 3b

Lane 3b adds human comment commands, live human authorization, and PR completion
contracts (TRD 4.3, 4.4, 4.5, 4.7, 4.9 worker half, 4.10). Everything below is
body-free: no issue title, issue body, comment text, or PR text reaches the CP.

### Shared human-action helpers

`cp/src/kanban/human-action.ts` is the single gate for a human moving a card. #194's
label sync can call it per attributed label event.

```ts
export interface KanbanHumanActor {
  login: string
  id?: number | string
  type?: string // GitHub account type: User | Bot | Organization
  viaApp?: boolean // the event's performed_via_github_app
}
export type HumanActionRefusal = 'not_human' | 'app_actor' | 'no_write' | 'lookup_failed'
export function authorizeHumanKanbanAction(input: {
  repo: RepoPermissionTarget
  actor: KanbanHumanActor
  appSlug: string | undefined
  permissions: RepoPermissionLookup // pass a GithubRepoPermission with ttlMs: 0
}): Promise<{ ok: true; authority: KanbanHumanAuthority } | { ok: false; reason: HumanActionRefusal; error?: unknown }>

export const KANBAN_COMMANDS = ['unblock', 'reopen', 'ready'] as const
export type HumanTransitionRefusal = 'wrong_status' | 'leased' | 'illegal' | 'no_write'
export function planHumanTransition(
  card: { status: KanbanStatus; leased: boolean },
  command: KanbanCommand,
  observed: ObservedIssue
):
  | { ok: true; from; to: 'ready'; plan: LabelPlan }
  | { ok: false; reason: HumanTransitionRefusal; refusalComment: string }
export function humanRefusalComment(command, status, reason): string
```

- Bots, this App (`<appSlug>[bot]`), Organization accounts, and App-on-behalf-of-user
  events are refused before any lookup. This is the B8 worker-half rule: agents hold
  only installation tokens, so their comments and label edits arrive as the App. The
  CP has no agent-to-GitHub-user mapping, so no login comparison is possible or needed.
- Write means `admin`, `maintain`, or `write` from a live, uncached lookup. A thrown
  lookup is `lookup_failed`. The comment handler then throws, so the GUID stays
  unlanded and the redelivery sweep re-asks.
- Only `authorizeHumanKanbanAction` and the importer may mint `KanbanHumanAuthority`.
  `human-authority.test.ts` enforces this.

### Comment grammar

The command is read only from the first line of a new comment
(`issue_comment.created`). It is case-insensitive, may have leading or trailing
whitespace, and needs one or more spaces or tabs between the two words:
`/kanban unblock`, `/kanban reopen`, or `/kanban ready`. Anything else is ignored with
no reply. That includes a command on a later line, a quoted command (`> /kanban …`),
extra words, edits, deletions, and comments on pull-request conversations.

| Command   | Applies to       | Effect                                              |
| --------- | ---------------- | --------------------------------------------------- |
| `unblock` | `blocked`        | → `ready`, clears `blockKind`                       |
| `reopen`  | `done`           | → `ready`, reopens the issue, clears the PR binding |
| `ready`   | `todo`, `triage` | → `ready`                                           |

Every applied move also clears the cooldown, recovery backoff, promotion intent, and
`needsAttention`. A leased card refuses all three commands (`leased`). A command that
does not fit the card's status is refused as `wrong_status`. A sender without write
access is recorded as `no_write` without a reply. Other refusals from writers post
exactly one fixed-template comment naming only the command, labels, and reason code.

### Doorbell frame (`rc/github-graph`, still `.strict()`)

`event` gains `issue_comment`, `pull_request`, and `check_suite`. There are three new
optional fields; at most one is present on a frame:

```ts
command?: { name: 'unblock' | 'reopen' | 'ready'; commentId: GithubNumericId; viaApp?: boolean;
            sender: { login: string /* ≤64 */; id?: GithubNumericId; type: string /* ≤32 */ } }
pullRequest?: { number: number; merged: boolean; headSha: GitSha }        // pull_request closed
checkSuite?: { headSha: GitSha; conclusion: string | null; prNumbers: number[] /* ≤10 */ } // check_suite completed
```

For a command, `ids`/`numbers` name the issue. For PR frames they are empty.
`isKanbanDoorbellDelivery(event, action)` is the shared allowlist the relay forwards
and the CP redelivery sweep re-asks: graph events, the `issues` actions,
`issue_comment:created`, `pull_request:closed`, and `check_suite:completed`. A
delivery that is not a command (or has a bot sender, a PR conversation, or an
unprovable sha) is still forwarded as a seen-only marker, so it lands.

The relay drops bot senders. For user comments it forwards optional `command.viaApp`
when GitHub sets `comment.performed_via_github_app`, keeping only a boolean. The CP
refuses these App-on-behalf-of-user commands before looking up write access. It
re-checks the sender type and then runs the live write check. Label recovery fails
closed when its human authorization dependency is absent.

### Idempotency

`kanban_command` (migration `20261123200100_kanban_m4_contracts`) is unique on
`(boardId, commentId)`. In one transaction it records the outcome (`applied` or the
refusal code) together with the card's `stateRevision` CAS (from-status, no open run)
and a `kanban_card_change` audit row. That row carries
`humanAuthority {login, permission}`, `command`, `commentId`, and
`source: 'comment_command'`.

The GitHub effect runs after the commit: the label write and reopen, or the one
refusal comment for a writer's `wrong_status`, `leased`, or `illegal` command.
A `no_write` refusal is recorded and settled silently, with no GitHub reply or label
write, so untrusted comments cannot amplify into App posts. `settledAt` marks it done. A redelivery of an unsettled row re-runs
the effect; it does not re-decide. A lost CAS is re-read up to three times.

### PR completion contracts

The pure planner is in `cp/src/kanban/contracts.ts`:
`planContract(input) → done | triage(pr_closed_unmerged) | wait(reason)` and
`checksVerdict(runs) → green | pending | failed | none`.

- The planner only judges cards that meet all of these: status `review`,
  `completionContract` ≠ `close`, `linkedPrNumber` set, and no open run.
- Before either completion or unmerged-close triage, the live PR must be bound to
  this card: author login `<appSlug>[bot]` with type `Bot`, head branch
  `ac/card-<issueNumber>` in the board's repository (no fork), and base equal to
  the repository's live default branch. Its `created_at` must be at or after
  `linkedPrWorkStartedAt`, the start of the work run that reported this PR.
  Missing provenance or any binding mismatch means `wait(pr_unbound)`, logged
  with metadata only; it never completes or triages. Issue-closing references
  alone are not authority. No PR bodies or issue text are read into CP state.
- A bound linked PR closed unmerged → `triage`, `needsAttention` with reason
  `pr_closed_unmerged`, and one comment. This happens whether or not a verifier is set.
- `pr_merged`: the PR is merged and no verifier is configured, or `verifiedAt` is set
  → `done`, and the issue closes as completed.
- `pr_checks_green`: the newest run of every check on the PR's live head has
  completed with `success`, `neutral`, or `skipped`, including at least one
  `success` → `done`, under the same verifier
  condition.
  - "Newest run of every check" means the highest run id for GitHub Actions per
    `(app.id, workflowPath, name)`. The reader maps `check_suite.id` to
    a workflow path through `GET /repositories/{id}/actions/runs?head_sha=<sha>`.
    Same-named jobs in different workflows stay independent; a new run in the
    same workflow supersedes its earlier run. Non-Actions apps and unmapped
    suites use `(app.id, check_suite.id, name)`, preserving `filter=latest`'s
    suite boundary. Missing suites stay independent by check-run id.
  - A failure anywhere means `wait` (no flapping).
  - Neutral/skipped-only lists wait; at least one success is required.
  - No runs, or a check/workflow list truncated past 300 entries, never counts as green.
  - Configure an independent verifier for `pr_checks_green` boards: workers can
    edit workflows, and green checks alone do not prove the card's requirements.
  - A suite doorbell whose `headSha` is not the live head is ignored (`stale_doorbell`).
- The CP re-reads the PR and its runs live, by repository id, with
  `mintKanbanPr` (`pull_requests:read` + `checks:read` + `actions:read`, CP-only).
- Migration `20261123200110_kanban_pr_binding` adds nullable
  `kanban_card.linkedPrWorkStartedAt`. A fenced work report commits the linked PR
  and its dispatch start together. A new work claim invalidates old provenance
  until that work reports a PR, so a report omitting its PR cannot inherit an
  earlier completion. Verifier reports cannot replace that binding;
  `/kanban reopen` clears both. Existing links with no provenance wait for a new
  work report. The conservative reporting-run boundary may require a fresh PR
  after a retry, even when a prior attempt opened one.
- `done` resets `reviewRounds` and `verifiedAt`.
- Triggers:
  - the `pull_request` and `check_suite` doorbells;
  - any run end that leaves the card in `review` (the verifier approving after the PR
    finished, or a worker reporting after its PR merged);
  - the dispatcher tick's bounded sweep: 25 cards per board, with a cursor.

### Deploy order

Deploy the CP before the relay. An old CP fails to decode an `rc/github-graph` frame
that carries the new event values or fields. It answers with an error frame, drops
the frame, and keeps the link up; the redelivery sweep re-asks the delivery once the
CP is upgraded. An old relay simply never sends these frames.

The App manifest already subscribes `issue_comment`, `pull_request`, `check_run`, and
`check_suite`, and already grants `checks`, `pull_requests`, and `actions`.
No re-consent is needed. Apply the new migration before starting the new CP, and
upgrade the CP before emitting `command.viaApp` from the relay. Its optional
boolean is additive for new decoders; an old strict decoder rejects it, leaving
the delivery eligible for redelivery after upgrade.

The live E2E alone injects a constructor binding override for its PAT user's login
and type and its disposable base branch; its real head still uses `ac/card-<issue>`
in the same repository, and creation must follow the seeded work start. This
avoids merging scratch commits into the real default branch. Production never
reads a binding override from configuration or environment.

## Changelog

- **1.1 (2026-10-18):**
  - Review routing lands in the predicate: a `review` card is a `verify` claim to
    `verifierAgentId` with the verifier's agent facts and `openRunCountForVerifier`, and
    `verifier_unset`/`verifier_is_worker` now fire.
  - New `verified` gate (input `card.verifiedAt`): a card the verifier approved under
    `pr_merged`/`pr_checks_green` stays in `review` for the PR and is never re-verified. A work
    claim, a worker's pass, `changes_requested`, and a human status move clear the stamp, so the
    next review round is verifiable again.
  - B8 compares the verifier against every work attempt on the card: input `latestWorkAgentId`
    is replaced by `workAgentIds`.
  - New `needs_attention` gate (input `card.needsAttention`): the claim no longer takes a flagged
    card, so a board edit alone cannot lift a B8 park; only the human status move clears the flag.
  - Gates are reordered to the SQL claim's order: `open_lease` joins the row filters before the
    agent gates, and `daemon_offline` follows `agent_cap`, with `verifier_is_worker` last.
- **1.0 (2026-10-17):** initial frozen contract.

## 3c

Human controls (issue #2 B5) and the per-card write branch + synthesizer (B3).

### Routes (all owner + interactive OIDC, like the run-mode setters)

- `POST /api/v1/orgs/:orgId/kanban/boards/:boardId/pause` — pause a board.
  Idempotent; a paused board claims nothing but its reaper, reports, heartbeats,
  label sync, graph promotion and doorbells keep running. Returns the board DTO.
- `POST /api/v1/orgs/:orgId/kanban/boards/:boardId/resume` — resume and re-arm
  the dispatcher. Idempotent. Returns the board DTO.
- `POST /api/v1/orgs/:orgId/kanban/boards/:boardId/cards/:cardId/skip` — archive
  the card (issue closed `not_planned`), revoke any open lease with a
  dispatch-revision bump, and post one body-free comment. `404` for a card not on
  the board, `409` when the transition is not allowed.
- `POST /api/v1/orgs/:orgId/kanban/boards/:boardId/cards/:cardId/restart` — reset
  the card to `ready` (clearing failure counters, block recurrence, cooldown,
  block kind, and the attention flag), revoke any open lease, reopen a closed
  issue, write the status label and one body-free comment, then re-arm the
  dispatcher. `404`/`409` as above.

All four leave body-free audit rows: `board_paused`, `board_resumed`,
`card_skipped`, `card_restarted`.

### Board fields

`KanbanBoard` gains `paused` (default false), `pausedAt`, `pausedByUserId`
(`User` FK, `SetNull`), and `synthesizerAgentId` (`Agent` FK, `SetNull`).
`synthesizerAgentId` is accepted on the board CRUD bodies and validated like
`verifierAgentId` (an agent of the board's organization).

### Synthesizer card (B3)

A card whose issue has sub-issues (an epic) and is `todo` is promoted to `ready`
and assigned to `synthesizerAgentId` when every sub-issue is closed `completed`
and the graph read is not truncated; any `not_planned`/open sub-issue, a truncated
read, or no synthesizer configured leaves it alone. This is `planSynthesis` in
`cp/src/kanban/graph-reconciler.ts`, evaluated beside the existing blocker
promotion, with a sub-issue close re-evaluating its parent epic (the mirror of a
blocker re-evaluating its dependents). The write uses the same CAS + promotion
intent + idempotent label-write pattern as graph promotion, replacing prior
`ac/agent:*` labels with `ac/agent:<synthesizer-slug>`. An `issues.closed` or
`issues.reopened` doorbell re-reads the changed child and its parent graph.

### Write-card branch (B3)

A WRITE-mode Kanban run for issue #n checks out its session worktree on branch
`ac/card-<n>`, created from the repository's default branch on first use and
reused on later attempts and after a restart; it is never reused for another
card. The branch name comes from `kanbanCardBranch` in
`packages/daemon/src/kanban/card-branch.ts` and is told to the worker in the
kanban prompt. Read-mode runs are unchanged.

Skip, restart and synthesis enqueue body-free `kanban_notification` rows in the
same transaction as the status move (unique on card id and state revision).
Restart and synthesis use reason codes `restarted` and `synthesis` for ready
notifications. Headless boards and status self-moves stay silent.

For `ac/card-<n>`, an existing checked-out worktree is never detached or deleted
by a competing session. Removed daemon session registrations can be pruned and
the branch reused, preserving committed progress. Existing directories require
explicit retirement before another session can acquire their branch. A confined
session's clone keeps the branch locally; separate clones do not share unpushed
commits.
