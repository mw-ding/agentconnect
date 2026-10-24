// Dry-run explanation of the claim (issue #2 Lane 4b): body-free facts, hints, and the claim loop's ordering/caps simulation.
// The verdict itself is always `explainClaim` (Lane 3 owns it); this module only shapes inputs and outputs around it.
import type { ClaimEligibilityInput, ClaimGate, ClaimVerdict } from './claim-eligibility.js'

/** The gates a claim cap can defer an otherwise eligible card behind, once earlier claims fill the room. */
export type ClaimCapGate = 'board_cap' | 'agent_cap' | 'epic_cap' | 'daemon_cap'

/** Body-free facts behind a verdict: booleans, counts, ids and timestamps only, never an issue title or body. */
export interface ClaimFacts {
  boardEnabled: boolean
  boardPaused: boolean
  status: string
  assigneeAgentId: string | null
  role: 'work' | 'verify'
  targetAgentId: string | null
  targetExists: boolean
  targetPaused: boolean
  targetPlaced: boolean
  targetDaemonLive: boolean
  verifierAgentId: string | null
  verifiedAt: string | null
  needsAttention: boolean
  workAgentIds: string[]
  openRunCountForVerifier: number
  epicCapacity: NonNullable<ClaimEligibilityInput['epicCapacity']> | null
  daemonCapacity: NonNullable<ClaimEligibilityInput['daemonCapacity']> | null
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
  const role = card.status === 'review' ? 'verify' : 'work'
  const target = role === 'verify' ? input.verifier : assignee
  return {
    boardEnabled: board.enabled,
    boardPaused: board.paused,
    status: card.status,
    assigneeAgentId: card.assigneeAgentId,
    role,
    targetAgentId: role === 'verify' ? board.verifierAgentId : card.assigneeAgentId,
    targetExists: target?.exists ?? false,
    targetPaused: target?.paused ?? false,
    targetPlaced: (target?.daemonId ?? null) !== null,
    targetDaemonLive: target?.daemonLive ?? false,
    verifierAgentId: board.verifierAgentId,
    verifiedAt: card.verifiedAt?.toISOString() ?? null,
    needsAttention: card.needsAttention,
    workAgentIds: [...input.workAgentIds],
    openRunCountForVerifier: input.openRunCountForVerifier,
    epicCapacity: input.epicCapacity ?? null,
    daemonCapacity: input.daemonCapacity ?? null,
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
  board_paused: () => 'the board is paused; resume it to dispatch cards',
  label_write_pending: () => 'the issue status is still being written on GitHub; dispatch waits for the label sync',
  control_write_pending: () =>
    'a skip or restart is still writing the issue on GitHub; the label sync retries a failed write, then the card is dispatched ' +
    '(a deleted or transferred issue never takes the write, so that card needs a human)',
  status_not_claimable: (f) => `only ready (work) and review (verify) cards are dispatched; this card is ${f.status}`,
  verified: () => 'the verifier approved this card; it is waiting for the completion contract',
  needs_attention: () => 'this card needs human attention; a human status move clears the hold',
  epic_cap: (f) => `the epic is at its limit of ${f.epicCapacity?.maxActive} in-progress run(s)`,
  daemon_cap: (f) => `the target daemon is at its limit of ${f.daemonCapacity?.maxActive} in-progress run(s)`,
  promotion_pending: () => 'a promotion to ready is still being confirmed on GitHub',
  cooldown: (f) => `cooling down until ${f.cooldownUntil ?? 'later'} after a failed run`,
  not_before: (f) => `scheduled not to start before ${f.notBefore ?? 'later'}`,
  no_assignee: () => 'no agent is assigned to this card',
  agent_missing: () => 'the target agent no longer exists in this organization',
  agent_paused: () => 'the target agent is paused',
  agent_unplaced: () => 'the target agent is not placed on a daemon',
  daemon_offline: () => "the target agent's daemon is not connected",
  open_lease: () => 'a run already holds this card',
  board_cap: (f) => `the board is at its limit of ${f.maxInProgress} in-progress run(s)`,
  agent_cap: (f) => `the target agent is at its limit of ${f.maxInProgressPerAgent} in-progress run(s)`,
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
  epicCapacity?: { id: string; openRunCount: number; maxActive: number }
  daemonCapacity?: { id: string; openRunCount: number; maxActive: number }
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

// Replay cumulative caps over candidates in exact SQL order, preserving sub-millisecond age ties.
export function simulateClaim(candidates: readonly ClaimCandidate[], caps: ClaimSimulationCaps): ClaimSimulation {
  const order: string[] = []
  const capBound = new Map<string, ClaimCapGate>()
  const perAgent = new Map(caps.openPerAgent)
  let inProgress = caps.openTotal
  const room = Math.min(caps.maxInProgress - inProgress, caps.limit ?? Number.POSITIVE_INFINITY)
  // Stable sorting preserves the SQL microsecond order that JS Date cannot represent.
  const perEpic = new Map<string, number>()
  const perDaemon = new Map<string, number>()
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
    const epic = card.epicCapacity
    if (epic && (perEpic.get(epic.id) ?? epic.openRunCount) >= epic.maxActive) {
      capBound.set(card.id, 'epic_cap')
      continue
    }
    const daemon = card.daemonCapacity
    if (daemon && (perDaemon.get(daemon.id) ?? daemon.openRunCount) >= daemon.maxActive) {
      capBound.set(card.id, 'daemon_cap')
      continue
    }
    if (epic) perEpic.set(epic.id, (perEpic.get(epic.id) ?? epic.openRunCount) + 1)
    if (daemon) perDaemon.set(daemon.id, (perDaemon.get(daemon.id) ?? daemon.openRunCount) + 1)
    order.push(card.id)
    perAgent.set(agentId, (perAgent.get(agentId) ?? 0) + 1)
    inProgress += 1
  }
  return { order, capBound }
}
