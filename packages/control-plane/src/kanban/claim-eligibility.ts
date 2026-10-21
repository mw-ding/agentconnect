// Pure claim-eligibility predicate (issue #2): explains why a card is or isn't claimable, mirroring the SQL claim's gates.
// Lane 4's `dispatch --dry-run` calls this to explain "why isn't this card running"; the SQL claim stays the authority.
import type { KanbanStatus } from './card-state.js'

/** Which agent a claim dispatches a card to. */
export type ClaimRole = 'work' | 'verify'

/** A stable, body-free reason a card is not claimable right now. Every code maps to a gate the claim applies. */
export type ClaimGate =
  | 'board_disabled'
  | 'board_paused'
  | 'status_not_claimable'
  | 'promotion_pending'
  // A skip/restart's GitHub write has not landed yet; the claim waits so it never reads the pre-control issue.
  | 'control_write_pending'
  | 'label_write_pending'
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
  | 'epic_cap'
  | 'daemon_cap'
  // Review routing: a review card needs a configured verifier that is not its worker (B8 self-approval guard).
  | 'verifier_unset'
  | 'verifier_is_worker'
  // The verifier approved but a PR completion contract still gates done: re-verifying would loop forever.
  | 'verified'
  // Held for a human (B8 or an escalation); only a human status move clears the flag.
  | 'needs_attention'

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
    paused: boolean
    /** Set ⇒ `review` cards route to this verifier (review routing); unset ⇒ a review card waits. */
    verifierAgentId: string | null
    maxInProgress: number
    maxInProgressPerAgent: number
  }
  card: {
    status: KanbanStatus
    assigneeAgentId: string | null
    promotionPending: boolean
    /** A skip/restart committed a control version GitHub does not reflect yet. */
    controlWritePending: boolean
    labelWritePending: boolean
    cooldownUntil: Date | null
    notBefore: Date | null
    /** When the verifier approved a review card under a PR contract; set ⇒ the card is not re-verified. */
    verifiedAt: Date | null
    /** Flagged for a human; set ⇒ the card waits for a human status move, whatever else changes. */
    needsAttention: boolean
    /** An open (un-ended) run already holds this card. */
    hasOpenLease: boolean
  }
  /** Facts about the assignee (the work target); null when there is no assignee. */
  assignee: ClaimAgentFacts | null
  /** Facts about the verifier (the verify target); null when the board has no verifier or the verifier row is gone. */
  verifier: ClaimAgentFacts | null
  /** The agents of every work run on the card (any attempt, any outcome), for the B8 self-approval guard. */
  workAgentIds: readonly string[]
  /** Open runs on the board: the board-wide total and the target agent's own count. */
  openRunCount: number
  openRunCountForAssignee: number
  openRunCountForVerifier: number
  /** Present for an epic child; counts every open work or verify run in that epic. */
  epicCapacity?: { openRunCount: number; maxActive: number }
  /** Present when the daemon cap is configured; counts the target daemon across boards. */
  daemonCapacity?: { openRunCount: number; maxActive: number }
  now: Date
}

/** The card-level claim verdict, mirroring `PgKanbanDispatchRepo.claim` gate for gate and in its order (kanban-lane3-api.md). */
export function explainClaim(input: ClaimEligibilityInput): ClaimVerdict {
  const { board, card, now } = input

  // The claim's row filters, in its WHERE/JOIN order.
  if (!board.enabled) return { eligible: false, gate: 'board_disabled' }
  if (board.paused) return { eligible: false, gate: 'board_paused' }
  if (card.status !== 'ready' && card.status !== 'review') return { eligible: false, gate: 'status_not_claimable' }
  const role: ClaimRole = card.status === 'review' ? 'verify' : 'work'
  if (role === 'verify' && board.verifierAgentId === null) return { eligible: false, gate: 'verifier_unset' }
  if (role === 'verify' && card.verifiedAt !== null) return { eligible: false, gate: 'verified' }
  if (card.needsAttention) return { eligible: false, gate: 'needs_attention' }
  if (card.promotionPending) return { eligible: false, gate: 'promotion_pending' }
  if (card.controlWritePending) return { eligible: false, gate: 'control_write_pending' }
  if (card.labelWritePending) return { eligible: false, gate: 'label_write_pending' }
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

  // Match the claim loop: board and agent room, liveness, epic and daemon caps, then B8.
  if (input.openRunCount >= board.maxInProgress) return { eligible: false, gate: 'board_cap' }
  const own = role === 'verify' ? input.openRunCountForVerifier : input.openRunCountForAssignee
  if (own >= board.maxInProgressPerAgent) return { eligible: false, gate: 'agent_cap' }
  if (!facts.daemonLive) return { eligible: false, gate: 'daemon_offline' }
  if (input.epicCapacity && input.epicCapacity.openRunCount >= input.epicCapacity.maxActive) {
    return { eligible: false, gate: 'epic_cap' }
  }
  if (input.daemonCapacity && input.daemonCapacity.openRunCount >= input.daemonCapacity.maxActive) {
    return { eligible: false, gate: 'daemon_cap' }
  }
  if (role === 'verify' && (agentId === card.assigneeAgentId || input.workAgentIds.includes(agentId))) {
    return { eligible: false, gate: 'verifier_is_worker' }
  }

  return { eligible: true, role, agentId }
}
