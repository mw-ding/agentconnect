// Kanban reassignment (issue #2 spike §5): a leased card that changes agent or daemon kills its lease and restarts; never transfer.
import type { KanbanStatus } from './card-state.js'

export interface KanbanLease {
  leaseId: string
  agentId: string
  daemonId: string
  /** The card's dispatchRevision this lease was minted under. */
  dispatchRevision: bigint
}

export interface ReassignCard {
  cardId: string
  status: KanbanStatus
  dispatchRevision: bigint
  /** `githubSessionKey#<issueNumber>` (design D4): the thread identity survives reassignment. */
  sessionKey: string
  lease: KanbanLease | null
}

export interface ReassignTarget {
  agentId: string
  daemonId: string
}

export type ReassignStep =
  | { kind: 'revoke_lease'; leaseId: string; outcome: 'reclaimed' }
  | { kind: 'bump_dispatch_revision'; from: bigint; to: bigint }
  | { kind: 'cancel_source_turns'; agentId: string; daemonId: string }
  | { kind: 'set_assignee'; agentId: string }
  | { kind: 'post_comment'; body: string }
  | { kind: 'set_status'; status: 'ready'; countsAsFailure: false }

export interface ReassignPlan {
  steps: ReassignStep[]
  /** The next dispatch opens a NEW session under the same key that bootstraps from the GitHub thread. */
  nextSession: { sessionKey: string; fresh: true } | null
}

/** Thrown for any request to carry a live run across agents or daemons. */
export class KanbanTransferRefusedError extends Error {
  constructor() {
    super('kanban reassignment never transfers a running lease; it kills the lease and restarts')
    this.name = 'KanbanTransferRefusedError'
  }
}

/** The only reassignment path; `mode: 'transfer'` exists solely to be refused, so callers cannot opt into it. */
export function planReassign(
  card: ReassignCard,
  target: ReassignTarget,
  opts: { mode?: 'restart' | 'transfer'; fromName?: string; toName?: string } = {}
): ReassignPlan {
  if (opts.mode === 'transfer') throw new KanbanTransferRefusedError()
  const lease = card.lease
  if (!lease) return { steps: [{ kind: 'set_assignee', agentId: target.agentId }], nextSession: null }
  if (lease.agentId === target.agentId && lease.daemonId === target.daemonId) return { steps: [], nextSession: null }

  // Fence first: the superseded holder's late comments, status reports, and pushes must fail before anything else moves.
  const from = opts.fromName ?? lease.agentId
  const to = opts.toName ?? target.agentId
  return {
    steps: [
      { kind: 'revoke_lease', leaseId: lease.leaseId, outcome: 'reclaimed' },
      { kind: 'bump_dispatch_revision', from: card.dispatchRevision, to: card.dispatchRevision + 1n },
      { kind: 'cancel_source_turns', agentId: lease.agentId, daemonId: lease.daemonId },
      { kind: 'set_assignee', agentId: target.agentId },
      {
        kind: 'post_comment',
        body: `AgentConnect Kanban: reassigned from ${from} to ${to}; restarting in a new session.`
      },
      { kind: 'set_status', status: 'ready', countsAsFailure: false }
    ],
    nextSession: { sessionKey: card.sessionKey, fresh: true }
  }
}

/** The lease fence every run write must pass: a revoked or superseded lease is rejected. */
export function leaseAcceptsWrite(
  card: { dispatchRevision: bigint; lease: KanbanLease | null },
  write: { leaseId: string; dispatchRevision: bigint }
): boolean {
  return (
    card.lease !== null &&
    card.lease.leaseId === write.leaseId &&
    card.lease.dispatchRevision === write.dispatchRevision &&
    card.dispatchRevision === write.dispatchRevision
  )
}

/** Apply a plan to an in-memory card snapshot (the stub executor until M2's dispatcher owns the writes). */
export function applyReassignPlan(card: ReassignCard, plan: ReassignPlan): ReassignCard {
  let next = { ...card }
  for (const step of plan.steps) {
    if (step.kind === 'revoke_lease') next = { ...next, lease: null }
    else if (step.kind === 'bump_dispatch_revision') next = { ...next, dispatchRevision: step.to }
    else if (step.kind === 'set_status') next = { ...next, status: step.status }
  }
  return next
}
