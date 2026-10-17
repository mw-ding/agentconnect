import { describe, expect, it } from 'vitest'
import {
  KanbanRevoke,
  KanbanDispatch,
  KanbanDispatchOk,
  KanbanLeaseHeartbeat,
  KanbanReport,
  KanbanReportOk,
  buildEnvelope,
  decodeEnvelope,
  isFrame
} from '../index.js'

const BOARD = '11111111-1111-4111-8111-111111111111'
const CARD = '22222222-2222-4222-8222-222222222222'
const AGENT = '33333333-3333-4333-8333-333333333333'
const LEASE = '44444444-4444-4444-8444-444444444444'

const dispatch = {
  boardId: BOARD,
  cardId: CARD,
  agentId: AGENT,
  repoId: '987654321',
  repoFullName: 'acme/web',
  issueNumber: 42,
  leaseId: LEASE,
  attempt: 1,
  dispatchRevision: '3',
  sessionKeyPrefix: 'github:987654321',
  mode: 'read' as const
}

const report = {
  boardId: BOARD,
  cardId: CARD,
  agentId: AGENT,
  leaseId: LEASE,
  attempt: 1,
  dispatchRevision: '3',
  outcome: 'failed' as const,
  reasonCode: 'turn_error'
}

describe('kanban wire (issue #2 M2)', () => {
  it('kanban/revoke addresses only a card lease and rejects free text', () => {
    const req = { cardId: CARD, leaseId: LEASE }
    expect(decodeEnvelope(JSON.stringify(buildEnvelope('kanban/revoke', req))).ok).toBe(true)
    expect(KanbanRevoke.safeParse({ ...req, body: 'secret' }).success).toBe(false)
    expect(KanbanRevoke.safeParse({ ...req, leaseId: 'invalid' }).success).toBe(false)
    expect(decodeEnvelope(JSON.stringify(buildEnvelope('kanban/revoke/ok', { leaseId: LEASE }))).ok).toBe(true)
  })

  it('kanban/dispatch is a body-free lease grant (ids + fence only, strict)', () => {
    const decoded = decodeEnvelope(JSON.stringify(buildEnvelope('kanban/dispatch', dispatch)))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok || !isFrame('kanban/dispatch')(decoded.frame)) throw new Error('narrow')
    expect(decoded.frame.payload).toEqual(dispatch)
    // A smuggled title or body is rejected, never stripped silently.
    expect(KanbanDispatch.safeParse({ ...dispatch, title: 'Fix the login page' }).success).toBe(false)
    expect(KanbanDispatch.safeParse({ ...dispatch, body: 'secret' }).success).toBe(false)
    expect(decodeEnvelope(JSON.stringify(buildEnvelope('kanban/dispatch', { ...dispatch, body: 'x' }))).ok).toBe(false)
  })

  it('kanban/dispatch rejects malformed identities and fences', () => {
    const bad: Array<Record<string, unknown>> = [
      { repoId: 'acme/web' },
      { repoId: '0' },
      { issueNumber: 0 },
      { issueNumber: 1.5 },
      { attempt: 0 },
      { leaseId: 'not-a-uuid' },
      { dispatchRevision: '0' },
      { dispatchRevision: 3 },
      { sessionKeyPrefix: 'github:1#2' },
      { sessionKeyPrefix: '' },
      { repoFullName: 'acme web' },
      { mode: 'admin' }
    ]
    for (const patch of bad)
      expect(KanbanDispatch.safeParse({ ...dispatch, ...patch }).success, JSON.stringify(patch)).toBe(false)
    const { agentId: _, ...missingAgent } = dispatch
    expect(KanbanDispatch.safeParse(missingAgent).success).toBe(false)
    expect(KanbanDispatch.safeParse({ ...dispatch, sessionKeyPrefix: 'acme/web', mode: 'write' }).success).toBe(true)
  })

  it('kanban/dispatch/ok carries a typed refusal only when not accepted', () => {
    expect(KanbanDispatchOk.safeParse({ leaseId: LEASE, accepted: true }).success).toBe(true)
    expect(
      KanbanDispatchOk.safeParse({ leaseId: LEASE, accepted: false, reason: 'write_needs_worktree' }).success
    ).toBe(true)
    expect(KanbanDispatchOk.safeParse({ leaseId: LEASE, accepted: false }).success).toBe(false)
    expect(KanbanDispatchOk.safeParse({ leaseId: LEASE, accepted: true, reason: 'busy' }).success).toBe(false)
    expect(KanbanDispatchOk.safeParse({ leaseId: LEASE, accepted: false, reason: 'because I said so' }).success).toBe(
      false
    )
  })

  it('kanban/lease-heartbeat names leases and liveness only', () => {
    const beat = {
      leases: [{ leaseId: LEASE, cardId: CARD, dispatchRevision: '3', liveness: 'turn', sessionId: 's-1' }]
    }
    expect(decodeEnvelope(JSON.stringify(buildEnvelope('kanban/lease-heartbeat', beat))).ok).toBe(true)
    expect(KanbanLeaseHeartbeat.safeParse({ leases: [{ ...beat.leases[0], summary: 'did stuff' }] }).success).toBe(
      false
    )
    expect(KanbanLeaseHeartbeat.safeParse({ leases: [{ ...beat.leases[0], liveness: 'thinking' }] }).success).toBe(
      false
    )
    const many = Array.from({ length: 257 }, () => beat.leases[0])
    expect(KanbanLeaseHeartbeat.safeParse({ leases: many }).success).toBe(false)
  })

  it('kanban/report is body-free and requires blockKind exactly when blocked', () => {
    expect(decodeEnvelope(JSON.stringify(buildEnvelope('kanban/report', report))).ok).toBe(true)
    expect(KanbanReport.safeParse({ ...report, summary: 'free text' }).success).toBe(false)
    expect(KanbanReport.safeParse({ ...report, reasonCode: 'Contains spaces and CAPS' }).success).toBe(false)
    expect(KanbanReport.safeParse({ ...report, outcome: 'reclaimed' }).success).toBe(false)
    expect(KanbanReport.safeParse({ ...report, outcome: 'blocked' }).success).toBe(false)
    expect(KanbanReport.safeParse({ ...report, outcome: 'blocked', blockKind: 'needs_input' }).success).toBe(true)
    expect(KanbanReport.safeParse({ ...report, blockKind: 'needs_input' }).success).toBe(false)
    expect(KanbanReportOk.safeParse({ leaseId: LEASE, accepted: false, reason: 'superseded' }).success).toBe(true)
  })
})
