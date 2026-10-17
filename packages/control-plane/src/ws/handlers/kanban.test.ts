import { describe, expect, it, vi } from 'vitest'
import type { AnyFrame } from '@agentconnect.md/protocol'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { handleKanbanCard, handleKanbanLeaseHeartbeat, handleKanbanReport } from './kanban.js'

const DAEMON_ID = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const LEASE = '44444444-4444-4444-8444-444444444444'
const CARD = '22222222-2222-4222-8222-222222222222'

const frame = (type: 'kanban/lease-heartbeat' | 'kanban/report' | 'kanban/card', payload: unknown): AnyFrame =>
  ({ v: 1, id: crypto.randomUUID(), ts: '2026-10-15T12:00:00.000Z', type, payload }) as AnyFrame

const beat = { leases: [{ leaseId: LEASE, cardId: CARD, dispatchRevision: '3', liveness: 'background' }] }
const report = {
  boardId: '11111111-1111-4111-8111-111111111111',
  cardId: CARD,
  agentId: '33333333-3333-4333-8333-333333333333',
  leaseId: LEASE,
  attempt: 1,
  dispatchRevision: '3',
  outcome: 'protocol_violation'
}

function conn() {
  return {
    daemonId: DAEMON_ID,
    sessionEpoch: 9,
    replyTo: vi.fn(),
    sendError: vi.fn()
  } as unknown as DaemonConnection & {
    replyTo: ReturnType<typeof vi.fn>
    sendError: ReturnType<typeof vi.fn>
  }
}

describe('kanban WS handlers', () => {
  it('fences heartbeats with the authenticated daemon and epoch, never the payload', async () => {
    const onHeartbeat = vi.fn().mockResolvedValue([LEASE])
    const c = conn()
    const f = frame('kanban/lease-heartbeat', beat)
    await handleKanbanLeaseHeartbeat(f, c, { kanbanDispatcher: { onHeartbeat } } as unknown as DaemonWsDeps)
    expect(onHeartbeat).toHaveBeenCalledWith(DAEMON_ID, 9, beat.leases)
    expect(c.replyTo).toHaveBeenCalledWith(f, 'kanban/lease-heartbeat/ok', { superseded: [LEASE] })
  })

  it('replies to a report only after the fenced write resolves', async () => {
    const onReport = vi.fn().mockResolvedValue({ leaseId: LEASE, accepted: false, reason: 'superseded' })
    const c = conn()
    const f = frame('kanban/report', report)
    await handleKanbanReport(f, c, { kanbanDispatcher: { onReport } } as unknown as DaemonWsDeps)
    expect(onReport).toHaveBeenCalledWith(DAEMON_ID, 9, report)
    expect(c.replyTo).toHaveBeenCalledWith(f, 'kanban/report/ok', {
      leaseId: LEASE,
      accepted: false,
      reason: 'superseded'
    })
  })

  it('answers SCOPE_DENIED without a dispatcher and a retryable INTERNAL on a storage error', async () => {
    const c = conn()
    await handleKanbanReport(frame('kanban/report', report), c, {} as DaemonWsDeps)
    expect(c.sendError).toHaveBeenLastCalledWith(expect.any(String), 'SCOPE_DENIED', expect.any(String), false)
    const onReport = vi.fn().mockRejectedValue(new Error('db down'))
    await handleKanbanReport(frame('kanban/report', report), c, { kanbanDispatcher: { onReport } } as never)
    expect(c.sendError).toHaveBeenLastCalledWith(expect.any(String), 'INTERNAL', expect.any(String), true)
    expect(c.replyTo).not.toHaveBeenCalled()
  })

  it('fences a card read with the authenticated daemon and epoch, never the payload', async () => {
    const req = { boardId: report.boardId, cardId: CARD, leaseId: LEASE, dispatchRevision: '3' }
    const onCardShow = vi.fn().mockResolvedValue({ leaseId: LEASE, accepted: false, reason: 'superseded' })
    const c = conn()
    const f = frame('kanban/card', req)
    await handleKanbanCard(f, c, { kanbanDispatcher: { onCardShow } } as unknown as DaemonWsDeps)
    expect(onCardShow).toHaveBeenCalledWith(DAEMON_ID, 9, req)
    expect(c.replyTo).toHaveBeenCalledWith(f, 'kanban/card/ok', {
      leaseId: LEASE,
      accepted: false,
      reason: 'superseded'
    })

    await handleKanbanCard(frame('kanban/card', req), c, {} as DaemonWsDeps)
    expect(c.sendError).toHaveBeenLastCalledWith(expect.any(String), 'SCOPE_DENIED', expect.any(String), false)
    const failing = vi.fn().mockRejectedValue(new Error('db down'))
    await handleKanbanCard(frame('kanban/card', req), c, { kanbanDispatcher: { onCardShow: failing } } as never)
    expect(c.sendError).toHaveBeenLastCalledWith(expect.any(String), 'INTERNAL', expect.any(String), true)
  })
})
