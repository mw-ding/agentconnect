// Kanban run accounting (issue #2 §4/§7): pure; how a run's end moves its card, and when an open lease is stale.
import type { KanbanStatus } from './card-state.js'

export type KanbanBlockKind = 'dependency' | 'needs_input' | 'capability' | 'transient'
export type KanbanCompletionContract = 'close' | 'pr_merged' | 'pr_checks_green'

/** How one run ended; `reclaimed` is the reaper's, the rest come from the worker's report or a dispatch nack. */
export type KanbanRunEnd =
  | { outcome: 'completed' | 'review_requested' | 'failed' | 'protocol_violation' | 'transient' | 'reclaimed' }
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
}

export type TrippedLimit = 'failure_limit' | 'protocol_retry_limit' | 'block_recurrence_limit' | 'capability'

export interface RunEndPlan extends AccountingCard {
  countsAsFailure: boolean
  /** Set when the card left the dispatch loop for triage instead of retrying. */
  tripped?: TrippedLimit
}

export const FAILURE_COOLDOWN_BASE_MS = 60_000
export const FAILURE_COOLDOWN_MAX_MS = 60 * 60_000
export const TRANSIENT_COOLDOWN_MS = 60_000

/** Respawn cooldown after the nth consecutive failure: doubling from one minute, capped at an hour. */
export function failureCooldownMs(n: number): number {
  return Math.min(FAILURE_COOLDOWN_BASE_MS * 2 ** Math.max(0, n - 1), FAILURE_COOLDOWN_MAX_MS)
}

/** A limit trips when its counter reaches it; a misconfigured non-positive limit trips on the first occurrence. */
function reaches(count: number, limit: number): boolean {
  return count >= Math.max(1, limit)
}

/** The card after one run ends; only a `running` card moves, so a human's earlier move (blocked, triage) stands. */
export function planRunEnd(card: AccountingCard, board: AccountingBoard, end: KanbanRunEnd, now: Date): RunEndPlan {
  if (card.status !== 'running') return { ...card, countsAsFailure: false }
  const after = (ms: number) => new Date(now.getTime() + ms)
  const settled = { consecutiveFailures: 0, protocolViolations: 0, cooldownUntil: null, blockKind: null }
  switch (end.outcome) {
    case 'completed': {
      // A verifier or a PR contract gates done; otherwise completion closes the card (M4 adds the contracts).
      const gated = board.verifierAgentId !== null || board.completionContract !== 'close'
      return { ...card, ...settled, blockRecurrence: 0, status: gated ? 'review' : 'done', countsAsFailure: false }
    }
    case 'review_requested':
      return { ...card, ...settled, status: 'review', countsAsFailure: false }
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
      return { ...card, consecutiveFailures, cooldownUntil, status: 'ready', countsAsFailure: true }
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
      return { ...card, protocolViolations, cooldownUntil, status: 'ready', countsAsFailure: false }
    }
    case 'transient':
      return { ...card, cooldownUntil: after(TRANSIENT_COOLDOWN_MS), status: 'ready', countsAsFailure: false }
    case 'reclaimed':
      return { ...card, cooldownUntil: null, status: 'ready', countsAsFailure: false }
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
  if (lease.ackedAt === null && now.getTime() - lease.dispatchedAt.getTime() > opts.unackedGraceMs)
    return 'dispatch_unacked'
  if (lease.currentDaemonEpoch !== lease.daemonEpoch && sinceBeat > opts.epochGraceMs) return 'epoch_changed'
  if (sinceBeat > lease.staleLeaseSec * 1000) return 'stale_heartbeat'
  return null
}
