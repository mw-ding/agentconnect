// Pure claim-eligibility predicate (issue #2): explains why a card is or isn't claimable, mirroring the SQL claim's gates.
// Lane 4's `dispatch --dry-run` calls this to explain "why isn't this card running"; the SQL claim stays the authority.
import type { KanbanStatus } from './card-state.js'

/** Which agent a claim dispatches a card to. */
export type ClaimRole = 'work' | 'verify'

/** A stable, body-free reason a card is not claimable right now. Every code maps to a gate the claim applies. */
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
  // Review routing: a review card needs a configured verifier that is not its worker (B8 self-approval guard).
  | 'verifier_unset'
  | 'verifier_is_worker'

/** The verdict: claimable (with the target role and agent), or the first gate in precedence order that blocks it. */
export type ClaimVerdict = { eligible: true; role: ClaimRole; agentId: string } | { eligible: false; gate: ClaimGate }

/** Facts about one agent the card could be dispatched to: existence, pause state, placement, and daemon liveness. */
export interface ClaimAgentFacts {
  /** The agent row exists for the target id. */
  exists: boolean
  /** The agent is paused (the claim joins only non-paused agents). */
  paused: boolean
  /** The agent's daemon placement; null means unplaced, so the claim cannot reach it. */
  daemonId: string | null
  /** The daemon's live control connection (the claim's in-memory liveness check). */
  daemonLive: boolean
}

export interface ClaimEligibilityInput {
  board: {
    enabled: boolean
    /** Set ⇒ `review` cards route to this verifier (review routing); unset ⇒ a review card waits. */
    verifierAgentId: string | null
    maxInProgress: number
    maxInProgressPerAgent: number
  }
  card: {
    status: KanbanStatus
    assigneeAgentId: string | null
    promotionPending: boolean
    cooldownUntil: Date | null
    notBefore: Date | null
    /** An open (un-ended) run already holds this card. */
    hasOpenLease: boolean
  }
  /** Facts about the assignee (the work target); null when there is no assignee. */
  assignee: ClaimAgentFacts | null
  /** Facts about the verifier (the verify target); null when the board has no verifier or the verifier row is gone. */
  verifier: ClaimAgentFacts | null
  /** The agent id of the card's latest completed work run, for the B8 self-approval guard. */
  latestWorkAgentId: string | null
  /** Open runs on the board: the board-wide total and the target agent's own count. */
  openRunCount: number
  openRunCountForAssignee: number
  openRunCountForVerifier: number
  now: Date
}

/** The card-level claim verdict, mirroring `PgKanbanDispatchRepo.claim` gate for gate and in its order (kanban-lane3-api.md). */
export function explainClaim(input: ClaimEligibilityInput): ClaimVerdict {
  const { board, card, now } = input

  // The claim's row filters, in its WHERE/JOIN order.
  if (!board.enabled) return { eligible: false, gate: 'board_disabled' }
  if (card.status !== 'ready' && card.status !== 'review') return { eligible: false, gate: 'status_not_claimable' }
  const role: ClaimRole = card.status === 'review' ? 'verify' : 'work'
  if (role === 'verify' && board.verifierAgentId === null) return { eligible: false, gate: 'verifier_unset' }
  if (card.promotionPending) return { eligible: false, gate: 'promotion_pending' }
  if (card.cooldownUntil !== null && card.cooldownUntil.getTime() > now.getTime()) {
    return { eligible: false, gate: 'cooldown' }
  }
  if (card.notBefore !== null && card.notBefore.getTime() > now.getTime()) {
    return { eligible: false, gate: 'not_before' }
  }
  if (card.hasOpenLease) return { eligible: false, gate: 'open_lease' }

  // A review card is claimed to the board's verifier, a ready card to its assignee; every agent gate reads that target.
  const agentId = role === 'verify' ? board.verifierAgentId : card.assigneeAgentId
  if (agentId === null) return { eligible: false, gate: 'no_assignee' }
  const facts = role === 'verify' ? input.verifier : input.assignee
  if (!facts?.exists) return { eligible: false, gate: 'agent_missing' }
  if (facts.paused) return { eligible: false, gate: 'agent_paused' }
  if (facts.daemonId === null) return { eligible: false, gate: 'agent_unplaced' }

  // Then the claim loop's checks, in its order: the board's room, the target's own share, daemon liveness, B8.
  if (input.openRunCount >= board.maxInProgress) return { eligible: false, gate: 'board_cap' }
  const own = role === 'verify' ? input.openRunCountForVerifier : input.openRunCountForAssignee
  if (own >= board.maxInProgressPerAgent) return { eligible: false, gate: 'agent_cap' }
  if (!facts.daemonLive) return { eligible: false, gate: 'daemon_offline' }
  if (role === 'verify' && (agentId === card.assigneeAgentId || agentId === input.latestWorkAgentId)) {
    return { eligible: false, gate: 'verifier_is_worker' }
  }

  return { eligible: true, role, agentId }
}
