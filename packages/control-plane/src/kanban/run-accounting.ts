// Kanban run accounting (issue #2 §4/§7): pure; how a run's end moves its card, and when an open lease is stale.
import type { KanbanStatus } from './card-state.js'

export type KanbanBlockKind = 'dependency' | 'needs_input' | 'capability' | 'transient'
export type KanbanCompletionContract = 'close' | 'pr_merged' | 'pr_checks_green'

/** How one run ended; `reclaimed` is the reaper's, the rest come from the worker's report or a dispatch nack. */
export type KanbanRunEnd =
  | { outcome: 'completed' | 'review_requested' | 'failed' | 'protocol_violation' | 'reclaimed' }
  /** The verifier asked the worker for changes (verifier runs only); moves the card back to ready, no failure. */
  | { outcome: 'changes_requested' }
  /** `provider` marks a classified provider outage, which backs off and is bounded; other transients keep the flat cooldown. */
  | { outcome: 'transient'; provider?: boolean }
  | { outcome: 'blocked'; blockKind: KanbanBlockKind }

export interface AccountingBoard {
  failureLimit: number
  protocolRetryLimit: number
  blockRecurrenceLimit: number
  completionContract: KanbanCompletionContract
  verifierAgentId: string | null
}

export interface AccountingCard {
  status: KanbanStatus
  consecutiveFailures: number
  protocolViolations: number
  blockRecurrence: number
  cooldownUntil: Date | null
  blockKind: KanbanBlockKind | null
  /** Times the verifier asked for changes without the card ever being approved. */
  reviewRounds: number
  /** When the verifier approved but a PR completion contract still gates `done`; null otherwise. */
  verifiedAt: Date | null
}

export type TrippedLimit =
  | 'failure_limit'
  | 'protocol_retry_limit'
  | 'block_recurrence_limit'
  | 'capability'
  | 'transient_limit'
  | 'review_round_limit'

export interface RunEndPlan extends AccountingCard {
  countsAsFailure: boolean
  /** Set when the card left the dispatch loop for triage instead of retrying. */
  tripped?: TrippedLimit
}

export const FAILURE_COOLDOWN_BASE_MS = 60_000
export const FAILURE_COOLDOWN_MAX_MS = 60 * 60_000
export const TRANSIENT_COOLDOWN_MS = 60_000
/** Consecutive provider-outage runs after which a card goes to triage instead of retrying forever (backoff reaches the hour cap at the 7th). */
export const PROVIDER_TRANSIENT_LIMIT = 8
/** Changes a verifier may request before the card routes to triage instead of looping the review forever. */
export const KANBAN_REVIEW_ROUND_LIMIT = 3

/** Facts about earlier runs that the card row does not carry. */
export interface RunEndContext {
  /** Provider-outage `transient` runs that ended back to back just before this one. */
  trailingProviderTransients: number
  /** The run's role: work (ready card) or verify (review card). */
  role: 'work' | 'verify'
}

/** Respawn cooldown after the nth consecutive failure: doubling from one minute, capped at an hour. */
export function failureCooldownMs(n: number): number {
  return Math.min(FAILURE_COOLDOWN_BASE_MS * 2 ** Math.max(0, n - 1), FAILURE_COOLDOWN_MAX_MS)
}

/** A limit trips when its counter reaches it; a misconfigured non-positive limit trips on the first occurrence. */
function reaches(count: number, limit: number): boolean {
  return count >= Math.max(1, limit)
}

/** The card after one run ends; only a `running` card moves for a work run, only a `review` card for a verify run. */
export function planRunEnd(
  card: AccountingCard,
  board: AccountingBoard,
  end: KanbanRunEnd,
  now: Date,
  ctx: RunEndContext = { trailingProviderTransients: 0, role: 'work' }
): RunEndPlan {
  const isVerify = ctx.role === 'verify'
  const movable = isVerify ? card.status === 'review' : card.status === 'running'
  if (!movable) return { ...card, countsAsFailure: false }
  const after = (ms: number) => new Date(now.getTime() + ms)
  const settled = { consecutiveFailures: 0, protocolViolations: 0, cooldownUntil: null, blockKind: null }
  switch (end.outcome) {
    case 'completed': {
      if (!isVerify) {
        // A verifier or a PR contract gates done. A worker pass clears the verify stamp but keeps the round count bounded.
        const gated = board.verifierAgentId !== null || board.completionContract !== 'close'
        return {
          ...card,
          ...settled,
          blockRecurrence: 0,
          verifiedAt: null,
          reviewRounds: gated ? card.reviewRounds : 0,
          status: gated ? 'review' : 'done',
          countsAsFailure: false
        }
      }
      // A verifier approving: done on the close contract, else stays review with the approval stamped for the PR doorbell.
      if (board.completionContract === 'close') {
        return {
          ...card,
          ...settled,
          blockRecurrence: 0,
          verifiedAt: null,
          reviewRounds: 0,
          status: 'done',
          countsAsFailure: false
        }
      }
      return { ...card, ...settled, status: 'review', verifiedAt: now, reviewRounds: 0, countsAsFailure: false }
    }
    case 'review_requested':
      // Worker-only (a verifier's request-review is refused on the daemon). A fresh review clears the verify stamp.
      return { ...card, ...settled, verifiedAt: null, status: 'review', countsAsFailure: false }
    case 'changes_requested': {
      // Verifier-only: back to ready for the original assignee, no failure, one review round counted.
      if (!isVerify) return { ...card, ...settled, verifiedAt: null, status: 'review', countsAsFailure: false }
      const reviewRounds = card.reviewRounds + 1
      if (reviewRounds >= KANBAN_REVIEW_ROUND_LIMIT)
        return {
          ...card,
          reviewRounds,
          verifiedAt: null,
          status: 'triage',
          countsAsFailure: false,
          tripped: 'review_round_limit'
        }
      return { ...card, reviewRounds, verifiedAt: null, status: 'ready', countsAsFailure: false }
    }
    case 'blocked': {
      const blockRecurrence = card.blockRecurrence + 1
      const base = { ...card, cooldownUntil: null, blockKind: end.blockKind, blockRecurrence, countsAsFailure: false }
      if (end.blockKind === 'capability') return { ...base, status: 'triage', tripped: 'capability' }
      if (reaches(blockRecurrence, board.blockRecurrenceLimit))
        return { ...base, status: 'triage', tripped: 'block_recurrence_limit' }
      return { ...base, status: 'blocked' }
    }
    case 'failed': {
      const consecutiveFailures = card.consecutiveFailures + 1
      if (reaches(consecutiveFailures, board.failureLimit))
        return {
          ...card,
          consecutiveFailures,
          cooldownUntil: null,
          status: 'triage',
          countsAsFailure: true,
          tripped: 'failure_limit'
        }
      const cooldownUntil = after(failureCooldownMs(consecutiveFailures))
      return {
        ...card,
        consecutiveFailures,
        cooldownUntil,
        status: isVerify ? 'review' : 'ready',
        countsAsFailure: true
      }
    }
    case 'protocol_violation': {
      // Its own budget (protocolRetryLimit), so a model that forgets the terminal tool is not judged as a crash.
      const protocolViolations = card.protocolViolations + 1
      if (reaches(protocolViolations, board.protocolRetryLimit))
        return {
          ...card,
          protocolViolations,
          cooldownUntil: null,
          status: 'triage',
          countsAsFailure: false,
          tripped: 'protocol_retry_limit'
        }
      const cooldownUntil = after(failureCooldownMs(protocolViolations))
      return {
        ...card,
        protocolViolations,
        cooldownUntil,
        status: isVerify ? 'review' : 'ready',
        countsAsFailure: false
      }
    }
    case 'transient': {
      if (!end.provider)
        return {
          ...card,
          cooldownUntil: after(TRANSIENT_COOLDOWN_MS),
          status: isVerify ? 'review' : 'ready',
          countsAsFailure: false
        }
      // A provider outage is not the card's fault, so it backs off like a failure without counting as one, and is bounded.
      const run = ctx.trailingProviderTransients + 1
      if (reaches(run, PROVIDER_TRANSIENT_LIMIT))
        return { ...card, cooldownUntil: null, status: 'triage', countsAsFailure: false, tripped: 'transient_limit' }
      return {
        ...card,
        cooldownUntil: after(failureCooldownMs(run)),
        status: isVerify ? 'review' : 'ready',
        countsAsFailure: false
      }
    }
    case 'reclaimed':
      return { ...card, cooldownUntil: null, status: isVerify ? 'review' : 'ready', countsAsFailure: false }
  }
}

export type StaleLeaseReason =
  'daemon_missing' | 'agent_moved' | 'dispatch_unacked' | 'epoch_changed' | 'stale_heartbeat'

export interface OpenLeaseFacts {
  dispatchedAt: Date
  ackedAt: Date | null
  heartbeatAt: Date | null
  daemonId: string
  /** The daemon's sessionEpoch last stamped on this run (dispatch or heartbeat). */
  daemonEpoch: bigint
  /** The daemon row's current sessionEpoch; null when the daemon row is gone. */
  currentDaemonEpoch: bigint | null
  /** Where the run's agent is placed now; null when unplaced, undefined when the agent row is gone. */
  agentDaemonId: string | null | undefined
  staleLeaseSec: number
}

export interface StalenessOpts {
  /** How long an unacked dispatch may sit before the reaper reclaims it. */
  unackedGraceMs: number
  /** How long after a daemon re-auth its lease may go without a re-asserting heartbeat. */
  epochGraceMs: number
}

/** Why the reaper should reclaim an open lease, or null while it is healthy. */
export function staleLeaseReason(lease: OpenLeaseFacts, now: Date, opts: StalenessOpts): StaleLeaseReason | null {
  if (lease.currentDaemonEpoch === null || lease.agentDaemonId === undefined) return 'daemon_missing'
  if (lease.agentDaemonId !== lease.daemonId) return 'agent_moved'
  const sinceBeat = now.getTime() - (lease.heartbeatAt ?? lease.ackedAt ?? lease.dispatchedAt).getTime()
  if (lease.ackedAt === null && lease.heartbeatAt === null && sinceBeat > opts.unackedGraceMs) return 'dispatch_unacked'
  if (lease.currentDaemonEpoch !== lease.daemonEpoch && sinceBeat > opts.epochGraceMs) return 'epoch_changed'
  if (sinceBeat > lease.staleLeaseSec * 1000) return 'stale_heartbeat'
  return null
}
