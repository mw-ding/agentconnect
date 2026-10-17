# Lane 3 Kanban claim-eligibility predicate (frozen contract)

**Version:** 1.0 (2026-10-17)

The pure claim predicate is `explainClaim` in `cp/src/kanban/claim-eligibility.ts`
(`cp/` = `packages/control-plane/`). Lane 4's `dispatch --dry-run` calls it to explain
"why isn't this card running". The SQL claim in
`cp/src/persistence/repositories/kanban-dispatch.repo.ts` `claim()` remains the
authority; this predicate mirrors it gate for gate and must never disagree on
whether a card is claimable.

## Signature

```ts
export type ClaimRole = 'work' | 'verify'

export type ClaimGate =
  | 'board_disabled'
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

export type ClaimVerdict = { eligible: true; role: ClaimRole; agentId: string } | { eligible: false; gate: ClaimGate }

export interface ClaimAgentFacts {
  exists: boolean
  paused: boolean
  daemonId: string | null
  daemonLive: boolean
}

export interface ClaimEligibilityInput {
  board: { enabled; verifierAgentId; maxInProgress; maxInProgressPerAgent }
  card: { status; assigneeAgentId; promotionPending; cooldownUntil; notBefore; hasOpenLease }
  assignee: ClaimAgentFacts | null
  verifier: ClaimAgentFacts | null
  latestWorkAgentId: string | null
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

A card is checked in this order; the first blocking gate wins. `board_cap` and
`agent_cap` are evaluated last because the SQL claim only reaches them once the
board's room and the candidate's own eligibility are established.

| #   | Gate                   | Condition                                                                               |
| --- | ---------------------- | --------------------------------------------------------------------------------------- |
| 1   | `board_disabled`       | the board is not enabled                                                                |
| 2   | `status_not_claimable` | status is neither `ready` nor `review`                                                  |
| 3   | `verifier_unset`       | status is `review` and the board has no `verifierAgentId`                               |
| 4   | `verifier_is_worker`   | status is `review` and the verifier is the assignee or the latest work run's agent (B8) |
| 5   | `promotion_pending`    | the card holds a pending graph promotion                                                |
| 6   | `cooldown`             | `cooldownUntil` is in the future                                                        |
| 7   | `not_before`           | `notBefore` is in the future                                                            |
| 8   | `no_assignee`          | no target agent id (assignee for work, verifier for verify)                             |
| 9   | `agent_missing`        | the target agent row is gone                                                            |
| 10  | `agent_paused`         | the target agent is paused                                                              |
| 11  | `agent_unplaced`       | the target agent has no daemon placement                                                |
| 12  | `daemon_offline`       | the target agent's daemon has no live connection                                        |
| 13  | `open_lease`           | an open (un-ended) run already holds the card                                           |
| 14  | `board_cap`            | the board's open runs have reached `maxInProgress`                                      |
| 15  | `agent_cap`            | the target agent's open runs have reached `maxInProgressPerAgent`                       |

The verifier gates (3–4) only fire once review routing lands; until then a `review`
card reports `status_not_claimable`. `needs_attention` is **not** a gate: escalated
cards are parked in `todo` (never `ready`/`review`), so the status gate already
excludes them.

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

| Command   | Applies to       | Effect                                               |
| --------- | ---------------- | ---------------------------------------------------- |
| `unblock` | `blocked`        | → `ready`, clears `blockKind`                        |
| `reopen`  | `done`           | → `ready`, reopens the issue, drops `linkedPrNumber` |
| `ready`   | `todo`, `triage` | → `ready`                                            |

Every applied move also clears the cooldown, recovery backoff, promotion intent, and
`needsAttention`. A leased card refuses all three commands (`leased`). A command that
does not fit the card's status is refused as `wrong_status`. A sender without write
access is refused as `no_write`. Each refusal posts exactly one fixed-template comment
that names only the command, labels, and reason code.

### Doorbell frame (`rc/github-graph`, still `.strict()`)

`event` gains `issue_comment`, `pull_request`, and `check_suite`. There are three new
optional fields; at most one is present on a frame:

```ts
command?: { name: 'unblock' | 'reopen' | 'ready'; commentId: GithubNumericId;
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

The relay drops bot senders. The CP re-checks the sender type and then runs the live
write check.

### Idempotency

`kanban_command` (migration `20261123200100_kanban_m4_contracts`) is unique on
`(boardId, commentId)`. In one transaction it records the outcome (`applied` or the
refusal code) together with the card's `stateRevision` CAS (from-status, no open run)
and a `kanban_card_change` audit row. That row carries
`humanAuthority {login, permission}`, `command`, `commentId`, and
`source: 'comment_command'`.

The GitHub effect runs after the commit: the label write and reopen, or the one
refusal comment. `settledAt` marks it done. A redelivery of an unsettled row re-runs
the effect; it does not re-decide. A lost CAS is re-read up to three times.

### PR completion contracts

The pure planner is in `cp/src/kanban/contracts.ts`:
`planContract(input) → done | triage(pr_closed_unmerged) | wait(reason)` and
`checksVerdict(runs) → green | pending | failed | none`.

- The planner only judges cards that meet all of these: status `review`,
  `completionContract` ≠ `close`, `linkedPrNumber` set, and no open run.
- A linked PR closed unmerged → `triage`, `needsAttention` with reason
  `pr_closed_unmerged`, and one comment. This happens whether or not a verifier is set.
- `pr_merged`: the PR is merged and no verifier is configured, or `verifiedAt` is set
  → `done`, and the issue closes as completed.
- `pr_checks_green`: the newest run of every check on the PR's live head has
  completed with `success`, `neutral`, or `skipped` → `done`, under the same verifier
  condition.
  - "Newest run of every check" means the highest run id per (app, check name).
    GitHub's `filter=latest` only dedupes within a suite, so a re-run in a new
    workflow run would otherwise leave the superseded failure listed.
  - A failure anywhere means `wait` (no flapping).
  - No runs, or a list truncated past 300 runs, never counts as green.
  - A suite doorbell whose `headSha` is not the live head is ignored (`stale_doorbell`).
- The CP re-reads the PR and its runs live, by repository id, with
  `mintKanbanPr` (`pull_requests:read` + `checks:read`, CP-only).
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
`check_suite`, and already grants `checks` and `pull_requests`. No re-consent is needed.
