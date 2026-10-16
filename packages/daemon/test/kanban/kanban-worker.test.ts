import { describe, expect, it, vi } from 'vitest'
import { FakeClock, WireError } from '@agentconnect.md/connection'
import type { KanbanDispatch, KanbanDispatchRefusal, KanbanReport } from '@agentconnect.md/protocol'
import { KanbanWorker } from '../../src/kanban/kanban-worker.js'

const dispatch: KanbanDispatch = {
  boardId: '11111111-1111-4111-8111-111111111111',
  cardId: '22222222-2222-4222-8222-222222222222',
  agentId: '33333333-3333-4333-8333-333333333333',
  leaseId: '44444444-4444-4444-8444-444444444444',
  repoId: '123',
  repoFullName: 'acme/web',
  issueNumber: 42,
  attempt: 1,
  dispatchRevision: '3',
  sessionKeyPrefix: 'github:123',
  mode: 'read'
}

function harness() {
  const clock = new FakeClock()
  const reports = new Map<string, KanbanReport | null>()
  const state = { active: true, tasks: 0, ready: true, refusal: undefined as KanbanDispatchRefusal | undefined }
  let resolve!: (id: string) => void
  let reject!: (err: Error) => void
  const done = new Promise<string>((res, rej) => {
    resolve = res
    reject = rej
  })
  const cp = {
    ready: () => state.ready,
    heartbeat: vi.fn(async () => ({ superseded: [] as string[] })),
    report: vi.fn(async (r: KanbanReport) => ({ leaseId: r.leaseId, accepted: true }))
  }
  const start = vi.fn((_d: KanbanDispatch, ready: (id: string) => void) => {
    ready('acp-1')
    return { accepted: true as const, sessionKey: 'session-42', done }
  })
  const cancel = vi.fn()
  const worker = new KanbanWorker({
    clock,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    cp: () => cp,
    start,
    cancel,
    gate: () => state.refusal,
    probe: { turnActive: () => state.active, liveBackgroundTasks: () => state.tasks },
    outbox: {
      has: (id) => reports.has(id),
      reserve: (id) => {
        reports.set(id, null)
      },
      release: (id) => {
        reports.delete(id)
      },
      put: (r) => {
        reports.set(r.leaseId, r)
      },
      list: (n) => [...reports.values()].filter((r): r is KanbanReport => r !== null).slice(0, n),
      remove: (id) => {
        reports.set(id, null)
      }
    }
  })
  const settle = async () => {
    state.active = false
    resolve('acp-1')
    await Promise.resolve()
    await worker.tick()
  }
  return { worker, cp, start, cancel, state, clock, settle, reject, reports }
}

describe('Kanban worker leases', () => {
  it('deduplicates dispatches and heartbeats only observed live turns on the timer', async () => {
    const h = harness()
    h.worker.start()
    expect(h.worker.dispatch(dispatch).accepted).toBe(true)
    expect(h.worker.dispatch(dispatch).accepted).toBe(true)
    expect(h.start).toHaveBeenCalledTimes(1)
    await h.clock.advance(60_000)
    await vi.waitFor(() => expect(h.cp.heartbeat).toHaveBeenCalledTimes(1))
    expect(h.cp.heartbeat).toHaveBeenCalledWith({
      leases: [
        {
          leaseId: dispatch.leaseId,
          cardId: dispatch.cardId,
          dispatchRevision: '3',
          liveness: 'turn',
          sessionId: 'acp-1'
        }
      ]
    })
    h.worker.stop()
    await h.clock.advance(120_000)
    expect(h.cp.heartbeat).toHaveBeenCalledTimes(1)
  })

  it('does not execute an already accepted lease after a daemon restart', () => {
    const h = harness()
    h.reports.set(dispatch.leaseId, null)
    expect(h.worker.dispatch(dispatch).accepted).toBe(true)
    expect(h.start).not.toHaveBeenCalled()
  })

  it('refuses admission without running a turn', () => {
    const h = harness()
    h.state.refusal = 'write_needs_worktree'
    expect(h.worker.dispatch({ ...dispatch, mode: 'write' })).toEqual({
      leaseId: dispatch.leaseId,
      accepted: false,
      reason: 'write_needs_worktree'
    })
    expect(h.start).not.toHaveBeenCalled()
  })

  it('keeps a settled turn alive while background tasks run, then reports once', async () => {
    const h = harness()
    h.worker.dispatch(dispatch)
    h.state.tasks = 1
    expect(h.worker.recordTerminal(dispatch.leaseId, { outcome: 'completed' })).toBe(true)
    expect(h.worker.recordTerminal(dispatch.leaseId, { outcome: 'failed' })).toBe(false)
    await h.settle()
    expect(h.cp.heartbeat).toHaveBeenLastCalledWith({ leases: [expect.objectContaining({ liveness: 'background' })] })
    expect(h.cp.report).not.toHaveBeenCalled()
    h.state.tasks = 0
    await h.worker.tick()
    expect(h.cp.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'completed', sessionId: 'acp-1' }))
    expect(h.worker.dispatch(dispatch).accepted).toBe(true)
    expect(h.start).toHaveBeenCalledTimes(1)
  })

  it('holds body-free reports through a CP outage and retryable failures', async () => {
    const h = harness()
    h.worker.dispatch(dispatch)
    h.state.ready = false
    await h.settle()
    expect(h.reports.get(dispatch.leaseId)).toMatchObject({
      outcome: 'protocol_violation',
      reasonCode: 'no_terminal_call'
    })
    h.state.ready = true
    h.cp.report.mockRejectedValueOnce(new WireError('INTERNAL', 'offline', true))
    await h.worker.flush()
    expect(h.reports.get(dispatch.leaseId)).not.toBeNull()
    await h.worker.flush()
    expect(h.reports.get(dispatch.leaseId)).toBeNull()
  })

  it('reports turn failures without sending the error text to the CP', async () => {
    const h = harness()
    h.worker.dispatch(dispatch)
    h.state.active = false
    h.reject(new Error('sensitive provider message'))
    await Promise.resolve()
    await h.worker.tick()
    expect(h.cp.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', reasonCode: 'turn_error' }))
    expect(JSON.stringify(h.cp.report.mock.calls)).not.toContain('sensitive')
  })

  it('cancels superseded turns and stops beating or reporting them', async () => {
    const h = harness()
    h.worker.dispatch(dispatch)
    h.cp.heartbeat.mockResolvedValueOnce({ superseded: [dispatch.leaseId] })
    await h.worker.tick()
    expect(h.cancel).toHaveBeenCalledOnce()
    await h.settle()
    expect(h.cp.report).not.toHaveBeenCalled()
    expect(h.worker.get(dispatch.leaseId)).toBeUndefined()
  })
})
