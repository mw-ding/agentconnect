# Lane 3 Kanban claim-eligibility predicate (frozen contract)

**Version:** 1.1 (2026-10-17)

The pure claim predicate is `explainClaim` in `cp/src/kanban/claim-eligibility.ts`
(`cp/` = `packages/control-plane/`). Lane 4's `dispatch --dry-run` calls it to explain
"why isn't this card running". The SQL claim in
`cp/src/persistence/repositories/kanban-dispatch.repo.ts` `claim()` remains the
authority; this predicate mirrors it gate for gate and must never disagree on
whether a card is claimable.

Changelog: 1.1 adds `board.paused` and the `board_paused` gate after `board_disabled`.

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

export type ClaimVerdict = { eligible: true; role: ClaimRole; agentId: string } | { eligible: false; gate: ClaimGate }

export interface ClaimAgentFacts {
  exists: boolean
  paused: boolean
  daemonId: string | null
  daemonLive: boolean
}

export interface ClaimEligibilityInput {
  board: { enabled; paused; verifierAgentId; maxInProgress; maxInProgressPerAgent }
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
| 2   | `board_paused`         | the board is paused; open runs can still report and expire                              |
| 3   | `status_not_claimable` | status is neither `ready` nor `review`                                                  |
| 4   | `verifier_unset`       | status is `review` and the board has no `verifierAgentId`                               |
| 5   | `verifier_is_worker`   | status is `review` and the verifier is the assignee or the latest work run's agent (B8) |
| 6   | `promotion_pending`    | the card holds a pending graph promotion                                                |
| 7   | `cooldown`             | `cooldownUntil` is in the future                                                        |
| 8   | `not_before`           | `notBefore` is in the future                                                            |
| 9   | `no_assignee`          | no target agent id (assignee for work, verifier for verify)                             |
| 10  | `agent_missing`        | the target agent row is gone                                                            |
| 11  | `agent_paused`         | the target agent is paused                                                              |
| 12  | `agent_unplaced`       | the target agent has no daemon placement                                                |
| 13  | `daemon_offline`       | the target agent's daemon has no live connection                                        |
| 14  | `open_lease`           | an open (un-ended) run already holds the card                                           |
| 15  | `board_cap`            | the board's open runs have reached `maxInProgress`                                      |
| 16  | `agent_cap`            | the target agent's open runs have reached `maxInProgressPerAgent`                       |

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
