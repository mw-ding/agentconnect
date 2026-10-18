// Dry-run explanation of the claim (issue #2 Lane 4b): body-free facts, hints, and the claim loop's ordering/caps simulation.
// The verdict itself is always `explainClaim` (Lane 3 owns it); this module only shapes inputs and outputs around it.
import type { ClaimEligibilityInput, ClaimGate, ClaimVerdict } from './claim-eligibility.js'

/** The gates a claim cap can defer an otherwise eligible card behind, once earlier claims fill the room. */
export type ClaimCapGate = 'board_cap' | 'agent_cap'

/** Body-free facts behind a verdict: booleans, counts, ids and timestamps only, never an issue title or body. */
export interface ClaimFacts {
  boardEnabled: boolean
  status: string
  assigneeAgentId: string | null
  promotionPending: boolean
  cooldownUntil: string | null
  notBefore: string | null
  hasOpenLease: boolean
  assigneeExists: boolean
  assigneePaused: boolean
  assigneePlaced: boolean
  assigneeDaemonLive: boolean
  openRunCount: number
  openRunCountForAssignee: number
  maxInProgress: number
  maxInProgressPerAgent: number
}

export function claimFactsOf(input: ClaimEligibilityInput): ClaimFacts {
  const { board, card, assignee } = input
  return {
    boardEnabled: board.enabled,
    status: card.status,
    assigneeAgentId: card.assigneeAgentId,
    promotionPending: card.promotionPending,
    cooldownUntil: card.cooldownUntil?.toISOString() ?? null,
    notBefore: card.notBefore?.toISOString() ?? null,
    hasOpenLease: card.hasOpenLease,
    assigneeExists: assignee?.exists ?? false,
    assigneePaused: assignee?.paused ?? false,
    assigneePlaced: (assignee?.daemonId ?? null) !== null,
    assigneeDaemonLive: assignee?.daemonLive ?? false,
    openRunCount: input.openRunCount,
    openRunCountForAssignee: input.openRunCountForAssignee,
    maxInProgress: board.maxInProgress,
    maxInProgressPerAgent: board.maxInProgressPerAgent
  }
}

// A Record over every gate: a gate Lane 3 adds fails to compile here until it gets a hint.
const HINTS: Record<ClaimGate, (facts: ClaimFacts) => string> = {
  board_disabled: () => 'the board is disabled; enable it to dispatch cards',
  status_not_claimable: (f) => `only ready cards are dispatched; this card is ${f.status}`,
  promotion_pending: () => 'a promotion to ready is still being confirmed on GitHub',
  cooldown: (f) => `cooling down until ${f.cooldownUntil ?? 'later'} after a failed run`,
  not_before: (f) => `scheduled not to start before ${f.notBefore ?? 'later'}`,
  no_assignee: () => 'no agent is assigned to this card',
  agent_missing: () => 'the assigned agent no longer exists in this organization',
  agent_paused: () => 'the assigned agent is paused',
  agent_unplaced: () => 'the assigned agent is not placed on a daemon',
  daemon_offline: () => "the assigned agent's daemon is not connected",
  open_lease: () => 'a run already holds this card',
  board_cap: (f) => `the board is at its limit of ${f.maxInProgress} in-progress run(s)`,
  agent_cap: (f) => `the assigned agent is at its limit of ${f.maxInProgressPerAgent} in-progress run(s)`,
  verifier_unset: () => 'review cards need a verifier agent configured on the board',
  verifier_is_worker: () => 'the verifier must be a different agent than the one that did the work'
}

export function gateHint(gate: ClaimGate, facts: ClaimFacts): string {
  return HINTS[gate](facts)
}

/** A cap-deferral reads like the gate it names, but is "once earlier cards are dispatched" rather than "now". */
export function capDeferralHint(gate: ClaimCapGate, facts: ClaimFacts): string {
  return `eligible now, but ${HINTS[gate](facts)} once the cards ahead of it are dispatched`
}

export interface ClaimCandidate {
  id: string
  priority: number
  createdAt: Date
  verdict: ClaimVerdict
}

export interface ClaimSimulationCaps {
  maxInProgress: number
  maxInProgressPerAgent: number
  /** Open runs on the board right now, in total and by agent. */
  openTotal: number
  openPerAgent: ReadonlyMap<string, number>
  /** Upper bound on one claim, as the dispatcher's `limit`. */
  limit?: number
}

export interface ClaimSimulation {
  /** Card ids in the order the claim would take them. */
  order: string[]
  /** Eligible cards the claim would skip or never reach because earlier claims fill a cap. */
  capBound: Map<string, ClaimCapGate>
}

/** The claim's candidate order: priority DESC, createdAt ASC, id ASC (at millisecond precision, for exact values). */
export function compareClaimOrder(a: ClaimCandidate, b: ClaimCandidate): number {
  if (a.priority !== b.priority) return b.priority - a.priority
  const byAge = a.createdAt.getTime() - b.createdAt.getTime()
  if (byAge !== 0) return byAge
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Replays `PgKanbanDispatchRepo.claim`'s loop over the cards `explainClaim` finds eligible, with caps applied cumulatively.
 *  Candidates must arrive in the claim's SQL order (priority DESC, createdAt ASC, id ASC); see below for why. */
export function simulateClaim(candidates: readonly ClaimCandidate[], caps: ClaimSimulationCaps): ClaimSimulation {
  const order: string[] = []
  const capBound = new Map<string, ClaimCapGate>()
  const perAgent = new Map(caps.openPerAgent)
  let inProgress = caps.openTotal
  const room = Math.min(caps.maxInProgress - inProgress, caps.limit ?? Number.POSITIVE_INFINITY)
  // WHY no id tiebreak here: PG orders timestamptz(6) at microsecond precision while a JS Date carries milliseconds,
  // so compareClaimOrder's id fallback would put a newer card with a smaller id ahead of an older one born less than
  // a millisecond earlier. The input already arrives in exact SQL order and sort is stable, so sub-ms ties keep that
  // order — which matches the claim exactly, including its id ASC rule for true microsecond ties.
  const eligible = candidates
    .filter((c) => c.verdict.eligible)
    .sort((a, b) => b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime())
  for (const card of eligible) {
    const agentId = card.verdict.eligible ? card.verdict.agentId : ''
    if (order.length >= room || inProgress >= caps.maxInProgress) {
      capBound.set(card.id, 'board_cap')
      continue
    }
    if ((perAgent.get(agentId) ?? 0) >= caps.maxInProgressPerAgent) {
      capBound.set(card.id, 'agent_cap')
      continue
    }
    order.push(card.id)
    perAgent.set(agentId, (perAgent.get(agentId) ?? 0) + 1)
    inProgress += 1
  }
  return { order, capBound }
}
