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
