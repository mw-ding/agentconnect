import { describe, expect, it, vi } from 'vitest'
import { FakeClock, WireError } from '@agentconnect.md/connection'
import type { KanbanDispatch, KanbanDispatchRefusal, KanbanReport } from '@agentconnect.md/protocol'
import { KanbanWorker, type KanbanTerminalEntry } from '../../src/kanban/kanban-worker.js'

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
  const terminals = new Map<string, { entry: KanbanTerminalEntry; state: 'held' | 'comment' }>()
  const comments = { drain: vi.fn(async () => {}) }
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
      },
      recordTerminal: (entry) => {
        if (terminals.has(entry.report.leaseId)) return false
        terminals.set(entry.report.leaseId, { entry, state: 'held' })
        return true
      },
      orphanedTerminals: () =>
        [...terminals.values()]
          .filter((t) => t.state === 'held' && reports.get(t.entry.report.leaseId) === null)
          .map((t) => t.entry),
      settleTerminal: (id, accepted) => {
        const t = terminals.get(id)
        if (t?.state !== 'held') return
        if (accepted) t.state = 'comment'
        else terminals.delete(id)
      }
    },
    comments
  })
  const settle = async () => {
    state.active = false
    resolve('acp-1')
    await Promise.resolve()
    await worker.tick()
  }
  return { worker, cp, start, cancel, state, clock, settle, reject, reports, terminals, comments }
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
    expect(h.worker.recordTerminal(dispatch.leaseId, { outcome: 'completed', summary: 'done' }).recorded).toBe(true)
    expect(h.worker.recordTerminal(dispatch.leaseId, { outcome: 'failed', summary: 'no' })).toEqual({
      recorded: false,
      reason: 'already_reported'
    })
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

  it('binds a terminal to the session lease exactly once and keeps its free text off the report', async () => {
    const h = harness()
    h.worker.start()
    h.worker.dispatch(dispatch)
    expect(h.worker.leaseForSession('session-42')).toBe(dispatch.leaseId)
    expect(h.worker.leaseForSession('other-session')).toBeUndefined()
    expect(
      h.worker.recordTerminal(dispatch.leaseId, {
        outcome: 'blocked',
        blockKind: 'needs_input',
        reasonCode: 'agent_blocked',
        summary: 'secret summary text',
        reason: 'which database?'
      })
    ).toEqual({ recorded: true, dispatch })
    const held = h.terminals.get(dispatch.leaseId)!
    expect(held).toMatchObject({
      state: 'held',
      entry: { repoFullName: 'acme/web', issueNumber: 42, summary: 'secret summary text', reason: 'which database?' }
    })
    expect(held.entry.report).toMatchObject({ outcome: 'blocked', blockKind: 'needs_input', reasonCode: 'agent_blocked' })
    expect(h.worker.recordTerminal(dispatch.leaseId, { outcome: 'completed', summary: 'again' })).toEqual({
      recorded: false,
      reason: 'already_reported'
    })
    await h.settle()
    expect(h.cp.report).toHaveBeenCalledOnce()
    expect(JSON.stringify(h.cp.report.mock.calls)).not.toContain('secret summary')
    expect(JSON.stringify(h.cp.report.mock.calls)).not.toContain('database')
    // The CP accepted the report, so the comment is queued and the publisher is woken.
    expect(h.terminals.get(dispatch.leaseId)?.state).toBe('comment')
    expect(h.comments.drain).toHaveBeenCalled()
    // The lease ended with the report: a late call has nothing to bind to.
    expect(h.worker.leaseForSession('session-42')).toBeUndefined()
    expect(h.worker.recordTerminal(dispatch.leaseId, { outcome: 'failed', summary: 'late' })).toEqual({
      recorded: false,
      reason: 'no_lease'
    })
  })

  it('refuses a terminal the durable store already holds, and one it cannot persist', () => {
    const h = harness()
    h.worker.dispatch(dispatch)
    h.terminals.set(dispatch.leaseId, {
      state: 'held',
      entry: { report: {} as KanbanReport, repoFullName: 'acme/web', issueNumber: 42, summary: 'x' }
    })
    expect(h.worker.recordTerminal(dispatch.leaseId, { outcome: 'completed', summary: 'y' })).toEqual({
      recorded: false,
      reason: 'already_reported'
    })
    const other = harness()
    other.worker.dispatch(dispatch)
    const outbox = (other.worker as unknown as { deps: { outbox: { recordTerminal: () => boolean } } }).deps.outbox
    outbox.recordTerminal = () => {
      throw new Error('disk full')
    }
    expect(other.worker.recordTerminal(dispatch.leaseId, { outcome: 'completed', summary: 'y' })).toEqual({
      recorded: false,
      reason: 'durability'
    })
    // A refused persist leaves the run free to report again.
    outbox.recordTerminal = () => true
    expect(other.worker.recordTerminal(dispatch.leaseId, { outcome: 'completed', summary: 'y' }).recorded).toBe(true)
  })

  it('drops the comment of a superseded or dead-lettered report', async () => {
    const h = harness()
    h.worker.start()
    h.worker.dispatch(dispatch)
    h.worker.recordTerminal(dispatch.leaseId, { outcome: 'completed', summary: 'done' })
    h.cp.report.mockResolvedValueOnce({ leaseId: dispatch.leaseId, accepted: false })
    await h.settle()
    expect(h.terminals.has(dispatch.leaseId)).toBe(false)
    // Start drains recovered comments; the tick drains again. Neither accepted a report.
    expect(h.comments.drain).toHaveBeenCalledTimes(2)
    h.worker.stop()

    const g = harness()
    g.worker.dispatch(dispatch)
    g.worker.recordTerminal(dispatch.leaseId, { outcome: 'completed', summary: 'done' })
    g.cp.report.mockRejectedValueOnce(new WireError('BAD_REQUEST', 'schema', false))
    await g.settle()
    expect(g.terminals.has(dispatch.leaseId)).toBe(false)
    expect(g.reports.get(dispatch.leaseId)).toBeNull()
  })

  it('requeues a terminal recorded before a restart and lets the lease fence decide', async () => {
    const h = harness()
    h.worker.dispatch(dispatch)
    h.worker.recordTerminal(dispatch.leaseId, { outcome: 'review_requested', summary: 'ready', prNumber: 7 })
    const held = h.terminals.get(dispatch.leaseId)!
    // A fresh process: the reservation and the recorded terminal survived, the in-memory lease did not.
    const r = harness()
    r.reports.set(dispatch.leaseId, null)
    r.terminals.set(dispatch.leaseId, held)
    r.worker.start()
    expect(r.reports.get(dispatch.leaseId)).toMatchObject({ outcome: 'review_requested', prNumber: 7 })
    await r.worker.flush()
    expect(r.cp.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'review_requested' }))
    expect(r.terminals.get(dispatch.leaseId)?.state).toBe('comment')
    r.worker.stop()
  })
})
