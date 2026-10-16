// Spike §5 reassignment rule: kill the lease and restart in a new session; transfer is refused and the old lease is fenced.
import { describe, expect, it } from 'vitest'
import {
  KanbanTransferRefusedError,
  applyReassignPlan,
  leaseAcceptsWrite,
  planReassign,
  type ReassignCard
} from './reassign.js'

const RUNNING: ReassignCard = {
  cardId: 'card-1',
  status: 'running',
  dispatchRevision: 4n,
  sessionKey: 'acme/web#7',
  lease: { leaseId: 'lease-old', agentId: 'agent-a', daemonId: 'daemon-1', dispatchRevision: 4n }
}

describe('planReassign', () => {
  it('kills the lease and restarts under the same session key, fencing before anything else moves', () => {
    const plan = planReassign(
      RUNNING,
      { agentId: 'agent-b', daemonId: 'daemon-2' },
      { fromName: 'ash', toName: 'vera' }
    )
    expect(plan.steps.map((s) => s.kind)).toEqual([
      'revoke_lease',
      'bump_dispatch_revision',
      'cancel_source_turns',
      'set_assignee',
      'post_comment',
      'set_status'
    ])
    expect(plan.steps[0]).toEqual({ kind: 'revoke_lease', leaseId: 'lease-old', outcome: 'reclaimed' })
    expect(plan.steps[1]).toEqual({ kind: 'bump_dispatch_revision', from: 4n, to: 5n })
    expect(plan.steps[2]).toEqual({ kind: 'cancel_source_turns', agentId: 'agent-a', daemonId: 'daemon-1' })
    expect(plan.steps[4]).toEqual({
      kind: 'post_comment',
      body: 'AgentConnect Kanban: reassigned from ash to vera; restarting in a new session.'
    })
    expect(plan.steps[5]).toEqual({ kind: 'set_status', status: 'ready', countsAsFailure: false })
    expect(plan.nextSession).toEqual({ sessionKey: 'acme/web#7', fresh: true })
  })

  it('restarts on a daemon-only move too: same agent, new placement is still a new session', () => {
    const plan = planReassign(RUNNING, { agentId: 'agent-a', daemonId: 'daemon-2' })
    expect(plan.steps[0]?.kind).toBe('revoke_lease')
    expect(plan.nextSession?.fresh).toBe(true)
  })

  it('refuses a transfer outright', () => {
    expect(() => planReassign(RUNNING, { agentId: 'agent-b', daemonId: 'daemon-2' }, { mode: 'transfer' })).toThrow(
      KanbanTransferRefusedError
    )
  })

  it('is a no-op for the current holder and a plain assignee change for an unleased card', () => {
    expect(planReassign(RUNNING, { agentId: 'agent-a', daemonId: 'daemon-1' })).toEqual({
      steps: [],
      nextSession: null
    })
    expect(planReassign({ ...RUNNING, status: 'ready', lease: null }, { agentId: 'agent-b', daemonId: 'd' })).toEqual({
      steps: [{ kind: 'set_assignee', agentId: 'agent-b' }],
      nextSession: null
    })
  })

  it("rejects the superseded holder's late writes once the plan applies", () => {
    const lateWrite = { leaseId: 'lease-old', dispatchRevision: 4n }
    expect(leaseAcceptsWrite(RUNNING, lateWrite)).toBe(true)

    const after = applyReassignPlan(RUNNING, planReassign(RUNNING, { agentId: 'agent-b', daemonId: 'daemon-2' }))
    expect(after).toMatchObject({ status: 'ready', dispatchRevision: 5n, lease: null })
    expect(leaseAcceptsWrite(after, lateWrite)).toBe(false)

    // The next dispatch mints a new lease under the new revision; the old one stays rejected.
    const redispatched = {
      ...after,
      lease: { leaseId: 'lease-new', agentId: 'agent-b', daemonId: 'daemon-2', dispatchRevision: 5n }
    }
    expect(leaseAcceptsWrite(redispatched, lateWrite)).toBe(false)
    expect(leaseAcceptsWrite(redispatched, { leaseId: 'lease-new', dispatchRevision: 5n })).toBe(true)
  })
})
