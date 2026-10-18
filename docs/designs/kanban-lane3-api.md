# Lane 3 Kanban claim-eligibility predicate (frozen contract)

**Version:** 1.1 (2026-10-18)

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
  | 'verified'

export type ClaimVerdict = { eligible: true; role: ClaimRole; agentId: string } | { eligible: false; gate: ClaimGate }

export interface ClaimAgentFacts {
  exists: boolean
  paused: boolean
  daemonId: string | null
  daemonLive: boolean
}

export interface ClaimEligibilityInput {
  board: { enabled; verifierAgentId; maxInProgress; maxInProgressPerAgent }
  card: { status; assigneeAgentId; promotionPending; cooldownUntil; notBefore; verifiedAt; hasOpenLease }
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

A card is checked in the SQL claim's own order, and the first blocking gate wins: first
the claim's row filters (its `WHERE`/`JOIN`), then the per-candidate checks of its loop
(the board's room, the target agent's share, daemon liveness, and B8 last).

A `ready` card is a **work** claim to `assigneeAgentId`. A `review` card on a board with a
`verifierAgentId` is a **verify** claim to that verifier: the agent gates read the verifier's facts and
`agent_cap` reads `openRunCountForVerifier`.

| #   | Gate                   | Condition                                                                               |
| --- | ---------------------- | --------------------------------------------------------------------------------------- |
| 1   | `board_disabled`       | the board is not enabled                                                                |
| 2   | `status_not_claimable` | status is neither `ready` nor `review`                                                  |
| 3   | `verifier_unset`       | status is `review` and the board has no `verifierAgentId`                               |
| 4   | `verified`             | status is `review` and `verifiedAt` is set: the verifier approved under a PR contract   |
| 5   | `promotion_pending`    | the card holds a pending graph promotion                                                |
| 6   | `cooldown`             | `cooldownUntil` is in the future                                                        |
| 7   | `not_before`           | `notBefore` is in the future                                                            |
| 8   | `open_lease`           | an open (un-ended) run already holds the card                                           |
| 9   | `no_assignee`          | no target agent id (assignee for work, verifier for verify)                             |
| 10  | `agent_missing`        | the target agent row is gone                                                            |
| 11  | `agent_paused`         | the target agent is paused                                                              |
| 12  | `agent_unplaced`       | the target agent has no daemon placement                                                |
| 13  | `board_cap`            | the board's open runs have reached `maxInProgress`                                      |
| 14  | `agent_cap`            | the target agent's open runs have reached `maxInProgressPerAgent`                       |
| 15  | `daemon_offline`       | the target agent's daemon has no live connection                                        |
| 16  | `verifier_is_worker`   | status is `review` and the verifier is the assignee or the latest work run's agent (B8) |

`verifier_is_worker` is last because the claim evaluates B8 on the locked candidate, after
its cap and liveness checks; that is also where it flags the card for a human.
`needs_attention` is **not** a gate: escalated cards are parked in `todo` (never
`ready`/`review`), so the status gate already excludes them.

## SQL/predicate parity rule

For every card, `explainClaim` returns `eligible: true` if and only if
`PgKanbanDispatchRepo.claim` mints a lease for it. A `pg` integration test
(`cp/test/integration/kanban-claim-eligibility.test.ts`) builds one card per gate
plus eligible cards, reads both paths against real Postgres, and asserts agreement.
When you change a claim gate in the SQL, change `explainClaim` in the same commit —
and vice versa.

## Changelog

- **1.1 (2026-10-18):** review routing lands in the predicate: a `review` card is a `verify`
  claim to `verifierAgentId` with the verifier's agent facts and `openRunCountForVerifier`, and
  `verifier_unset`/`verifier_is_worker` now fire. New `verified` gate (input `card.verifiedAt`):
  a card the verifier approved under `pr_merged`/`pr_checks_green` stays in `review` for the PR
  and is never re-verified; a work claim, a worker's pass, `changes_requested`, and a human
  status move clear the stamp, so the next review round is verifiable again. Gates are reordered to the SQL claim's order:
  `open_lease` joins the row filters before the agent gates, and `daemon_offline` follows
  `agent_cap`, with `verifier_is_worker` last.
- **1.0 (2026-10-17):** initial frozen contract.
