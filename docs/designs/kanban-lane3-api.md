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
  | 'needs_attention'

export type ClaimVerdict = { eligible: true; role: ClaimRole; agentId: string } | { eligible: false; gate: ClaimGate }

export interface ClaimAgentFacts {
  exists: boolean
  paused: boolean
  daemonId: string | null
  daemonLive: boolean
}

export interface ClaimEligibilityInput {
  board: { enabled; verifierAgentId; maxInProgress; maxInProgressPerAgent }
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
| 2   | `status_not_claimable` | status is neither `ready` nor `review`                                                     |
| 3   | `verifier_unset`       | status is `review` and the board has no `verifierAgentId`                                  |
| 4   | `verified`             | status is `review` and `verifiedAt` is set: the verifier approved under a PR contract      |
| 5   | `needs_attention`      | the card is flagged for a human (B8 or an escalation)                                      |
| 6   | `promotion_pending`    | the card holds a pending graph promotion                                                   |
| 7   | `cooldown`             | `cooldownUntil` is in the future                                                           |
| 8   | `not_before`           | `notBefore` is in the future                                                               |
| 9   | `open_lease`           | an open (un-ended) run already holds the card                                              |
| 10  | `no_assignee`          | no target agent id (assignee for work, verifier for verify)                                |
| 11  | `agent_missing`        | the target agent row is gone                                                               |
| 12  | `agent_paused`         | the target agent is paused                                                                 |
| 13  | `agent_unplaced`       | the target agent has no daemon placement                                                   |
| 14  | `board_cap`            | the board's open runs have reached `maxInProgress`                                         |
| 15  | `agent_cap`            | the target agent's open runs have reached `maxInProgressPerAgent`                          |
| 16  | `daemon_offline`       | the target agent's daemon has no live connection                                           |
| 17  | `verifier_is_worker`   | status is `review` and the verifier is the assignee or wrote any work run on the card (B8) |

`verifier_is_worker` is last because the claim evaluates B8 on the locked candidate, after
its cap and liveness checks; that is also where it flags the card for a human.
`needs_attention` holds a flagged card in any status: B8 leaves its card in `review`, and
only the documented human status move (a human-attributed status label the dispatcher
ingests) clears the flag. Editing the board, such as fixing `verifierAgentId`, never
releases it on its own.

## The approval stamp and review rounds

`verifiedAt` is the verifier's approval under `pr_merged`/`pr_checks_green`; the `verified`
gate keeps such a card in `review` for its PR instead of verifying it again. Every path that
starts a new review round clears the stamp:

- a work claim (`claim()` in `kanban-dispatch.repo.ts`);
- a worker's `completed` or `review_requested` run end, and a verifier's `changes_requested`
  (`planRunEnd` in `cp/src/kanban/run-accounting.ts`);
- a human status move, on both of its paths: a live human-attributed status label adopted by
  the label sync (`PgKanbanSyncRepo.apply`, any accepted change of status) and the parked
  human ingest (`PgKanbanDispatchRepo.ingestStatus`).

A move the CP makes on its own (a non-writer's revert to `triage`, a fail-closed attribution
timeout) keeps the stamp: neither moves a card into `review`, and the next work claim or human
move clears it before another round can reach the verifier.

`reviewRounds` counts the verifier's `changes_requested` replies, and the card trips to
`triage` (`review_round_limit`) when it reaches `KANBAN_REVIEW_ROUND_LIMIT` (3). Only an
approval resets it; a worker's pass and every human move keep it. So after a trip, a human
who moves the card back to `ready` buys exactly **one more verify round**: the worker runs,
the verifier reviews once, and a further `changes_requested` (round 4) sends the card straight
back to `triage`, while an approval ends the loop and resets the count. This is deliberate:
an agent can never reset the count, and a human who wants a full fresh budget must decide so
again after each extra round.

## SQL/predicate parity rule

For every card, `explainClaim` returns `eligible: true` if and only if
`PgKanbanDispatchRepo.claim` mints a lease for it. A `pg` integration test
(`cp/test/integration/kanban-claim-eligibility.test.ts`) builds one card per gate
plus eligible cards, reads both paths against real Postgres, and asserts agreement.
When you change a claim gate in the SQL, change `explainClaim` in the same commit —
and vice versa.

## Changelog

- **1.1 (2026-10-18):**
  - Review routing lands in the predicate: a `review` card is a `verify` claim to
    `verifierAgentId` with the verifier's agent facts and `openRunCountForVerifier`, and
    `verifier_unset`/`verifier_is_worker` now fire.
  - New `verified` gate (input `card.verifiedAt`): a card the verifier approved under
    `pr_merged`/`pr_checks_green` stays in `review` for the PR and is never re-verified. A work
    claim, a worker's pass, `changes_requested`, and a human status move (the label sync's
    `apply` and the parked ingest alike) clear the stamp, so the next review round is
    verifiable again. See "The approval stamp and review rounds".
  - B8 compares the verifier against every work attempt on the card: input `latestWorkAgentId`
    is replaced by `workAgentIds`.
  - New `needs_attention` gate (input `card.needsAttention`): the claim no longer takes a flagged
    card, so a board edit alone cannot lift a B8 park; only the human status move clears the flag.
  - Gates are reordered to the SQL claim's order: `open_lease` joins the row filters before the
    agent gates, and `daemon_offline` follows `agent_cap`, with `verifier_is_worker` last.
- **1.1 erratum (2026-10-18):** the 1.1 entry said every human status move clears
  `verifiedAt`, but only the parked ingest did; after the merge with the label sync (#194), its
  `apply` clears it too, so the statement now holds. The predicate and its inputs are unchanged.
- **1.0 (2026-10-17):** initial frozen contract.
