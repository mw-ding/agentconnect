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
  const state = {
    active: true,
    tasks: 0,
    ready: true,
    refusal: undefined as KanbanDispatchRefusal | undefined,
    nudgeRefusal: undefined as KanbanDispatchRefusal | undefined,
    nudgeThrows: false
  }
  const nudgeTurns: Array<{ resolve: (id: string | null) => void; reject: (err: unknown) => void }> = []
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
  const start = vi.fn(async (_d: KanbanDispatch, ready: (id: string) => void) => {
    ready('acp-1')
    return { accepted: true as const, sessionKey: 'session-42', done }
  })
  const nudge = vi.fn(async (_d: KanbanDispatch) => {
    if (state.nudgeThrows) throw new Error('start exploded')
    if (state.nudgeRefusal) return { accepted: false as const, reason: state.nudgeRefusal }
    state.active = true
    const nudgeDone = new Promise<string | null>((resolve, reject) => nudgeTurns.push({ resolve, reject }))
    return { accepted: true as const, sessionKey: 'session-42', done: nudgeDone }
  })
  const cancel = vi.fn()
  const worker = new KanbanWorker({
    clock,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    cp: () => cp,
    start,
    nudge,
    cancel,
    gate: async () => state.refusal,
    probe: { turnActive: () => state.active, liveBackgroundTasks: () => state.tasks },
    outbox: {
      has: async (id) => reports.has(id),
      reserve: async (id) => {
        reports.set(id, null)
      },
      release: async (id) => {
        reports.delete(id)
      },
      put: async (r) => {
        reports.set(r.leaseId, r)
      },
      list: async (n) => [...reports.values()].filter((r): r is KanbanReport => r !== null).slice(0, n),
      remove: async (id) => {
        reports.set(id, null)
      },
      recordTerminal: async (entry) => {
        if (terminals.has(entry.report.leaseId)) return false
        terminals.set(entry.report.leaseId, { entry, state: 'held' })
        return true
      },
      orphanedTerminals: async () =>
        [...terminals.values()]
          .filter((t) => t.state === 'held' && reports.get(t.entry.report.leaseId) === null)
          .map((t) => t.entry),
      settleTerminal: async (id, accepted) => {
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
  const settleNudge = async (sessionId: string | null = 'acp-1') => {
    state.active = false
    nudgeTurns.at(-1)!.resolve(sessionId)
    await Promise.resolve()
    await worker.tick()
  }
  const failNudge = async (err: unknown) => {
    state.active = false
    nudgeTurns.at(-1)!.reject(err)
    await Promise.resolve()
    await worker.tick()
  }
  return {
    worker,
    cp,
    start,
    nudge,
    cancel,
    state,
    clock,
    settle,
    settleNudge,
    failNudge,
    reject,
    reports,
    terminals,
    comments
  }
}

describe('Kanban worker leases', () => {
  it('deduplicates dispatches and heartbeats only observed live turns on the timer', async () => {
    const h = harness()
    h.worker.start()
    expect((await h.worker.dispatch(dispatch)).accepted).toBe(true)
    expect((await h.worker.dispatch(dispatch)).accepted).toBe(true)
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

  it('does not execute an already accepted lease after a daemon restart', async () => {
    const h = harness()
    h.reports.set(dispatch.leaseId, null)
    expect((await h.worker.dispatch(dispatch)).accepted).toBe(true)
    expect(h.start).not.toHaveBeenCalled()
  })

  it('refuses admission without running a turn', async () => {
    const h = harness()
    h.state.refusal = 'write_needs_worktree'
    expect(await h.worker.dispatch({ ...dispatch, mode: 'write' })).toEqual({
      leaseId: dispatch.leaseId,
      accepted: false,
      reason: 'write_needs_worktree'
    })
    expect(h.start).not.toHaveBeenCalled()
  })

  it('keeps a settled turn alive while background tasks run, then reports once', async () => {
    const h = harness()
    await h.worker.dispatch(dispatch)
    h.state.tasks = 1
    expect((await h.worker.recordTerminal(dispatch.leaseId, { outcome: 'completed', summary: 'done' })).recorded).toBe(
      true
    )
    expect(await h.worker.recordTerminal(dispatch.leaseId, { outcome: 'failed', summary: 'no' })).toEqual({
      recorded: false,
      reason: 'already_reported'
    })
    await h.settle()
    expect(h.cp.heartbeat).toHaveBeenLastCalledWith({ leases: [expect.objectContaining({ liveness: 'background' })] })
    expect(h.cp.report).not.toHaveBeenCalled()
    h.state.tasks = 0
    await h.worker.tick()
    expect(h.cp.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'completed', sessionId: 'acp-1' }))
    expect((await h.worker.dispatch(dispatch)).accepted).toBe(true)
    expect(h.start).toHaveBeenCalledTimes(1)
  })

  it('holds body-free reports through a CP outage and retryable failures', async () => {
    const h = harness()
    await h.worker.dispatch(dispatch)
    h.state.ready = false
    h.state.nudgeRefusal = 'draining'
    await h.settle()
    expect(h.reports.get(dispatch.leaseId)).toMatchObject({
      outcome: 'protocol_violation',
      reasonCode: 'nudge_unavailable'
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
    await h.worker.dispatch(dispatch)
    h.state.active = false
    h.reject(new Error('sensitive provider message'))
    await Promise.resolve()
    await h.worker.tick()
    expect(h.cp.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', reasonCode: 'turn_error' }))
    expect(h.nudge).not.toHaveBeenCalled()
    expect(JSON.stringify(h.cp.report.mock.calls)).not.toContain('sensitive')
  })

  it('cancels superseded turns and stops beating or reporting them', async () => {
    const h = harness()
    await h.worker.dispatch(dispatch)
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
    await h.worker.dispatch(dispatch)
    expect(h.worker.leaseForSession('session-42')).toBe(dispatch.leaseId)
    expect(h.worker.leaseForSession('other-session')).toBeUndefined()
    expect(
      await h.worker.recordTerminal(dispatch.leaseId, {
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
    expect(held.entry.report).toMatchObject({
      outcome: 'blocked',
      blockKind: 'needs_input',
      reasonCode: 'agent_blocked'
    })
    expect(await h.worker.recordTerminal(dispatch.leaseId, { outcome: 'completed', summary: 'again' })).toEqual({
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
    expect(await h.worker.recordTerminal(dispatch.leaseId, { outcome: 'failed', summary: 'late' })).toEqual({
      recorded: false,
      reason: 'no_lease'
    })
  })

  it('refuses a terminal the durable store already holds, and one it cannot persist', async () => {
    const h = harness()
    await h.worker.dispatch(dispatch)
    h.terminals.set(dispatch.leaseId, {
      state: 'held',
      entry: { report: {} as KanbanReport, repoFullName: 'acme/web', issueNumber: 42, summary: 'x' }
    })
    expect(await h.worker.recordTerminal(dispatch.leaseId, { outcome: 'completed', summary: 'y' })).toEqual({
      recorded: false,
      reason: 'already_reported'
    })
    const other = harness()
    await other.worker.dispatch(dispatch)
    const outbox = (other.worker as unknown as { deps: { outbox: { recordTerminal: () => Promise<boolean> } } }).deps
      .outbox
    outbox.recordTerminal = async () => {
      throw new Error('disk full')
    }
    expect(await other.worker.recordTerminal(dispatch.leaseId, { outcome: 'completed', summary: 'y' })).toEqual({
      recorded: false,
      reason: 'durability'
    })
    // A refused persist leaves the run free to report again.
    outbox.recordTerminal = async () => true
    expect((await other.worker.recordTerminal(dispatch.leaseId, { outcome: 'completed', summary: 'y' })).recorded).toBe(
      true
    )
  })

  it('drops the comment of a superseded or dead-lettered report', async () => {
    const h = harness()
    h.worker.start()
    await h.worker.dispatch(dispatch)
    await h.worker.recordTerminal(dispatch.leaseId, { outcome: 'completed', summary: 'done' })
    h.cp.report.mockResolvedValueOnce({ leaseId: dispatch.leaseId, accepted: false })
    await h.settle()
    expect(h.terminals.has(dispatch.leaseId)).toBe(false)
    // Start drains recovered comments; the tick drains again. Neither accepted a report.
    expect(h.comments.drain).toHaveBeenCalledTimes(2)
    h.worker.stop()

    const g = harness()
    await g.worker.dispatch(dispatch)
    await g.worker.recordTerminal(dispatch.leaseId, { outcome: 'completed', summary: 'done' })
    g.cp.report.mockRejectedValueOnce(new WireError('BAD_REQUEST', 'schema', false))
    await g.settle()
    expect(g.terminals.has(dispatch.leaseId)).toBe(false)
    expect(g.reports.get(dispatch.leaseId)).toBeNull()
  })

  it('requeues a terminal recorded before a restart and lets the lease fence decide', async () => {
    const h = harness()
    await h.worker.dispatch(dispatch)
    await h.worker.recordTerminal(dispatch.leaseId, { outcome: 'review_requested', summary: 'ready', prNumber: 7 })
    const held = h.terminals.get(dispatch.leaseId)!
    // A fresh process: the reservation and the recorded terminal survived, the in-memory lease did not.
    const r = harness()
    r.reports.set(dispatch.leaseId, null)
    r.terminals.set(dispatch.leaseId, held)
    r.worker.start()
    await vi.waitFor(() =>
      expect(r.reports.get(dispatch.leaseId)).toMatchObject({ outcome: 'review_requested', prNumber: 7 })
    )
    await r.worker.flush()
    expect(r.cp.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'review_requested' }))
    expect(r.terminals.get(dispatch.leaseId)?.state).toBe('comment')
    r.worker.stop()
  })
})

describe('Kanban worker protocol-violation nudge', () => {
  it('nudges a terminal-less turn once, in the same lease, and keeps beating while the nudge turn runs', async () => {
    const h = harness()
    await h.worker.dispatch(dispatch)
    await h.settle()
    expect(h.nudge).toHaveBeenCalledOnce()
    expect(h.nudge).toHaveBeenCalledWith(dispatch)
    // The nudge turn is live: no report yet, and the lease still heartbeats as a turn.
    expect(h.cp.report).not.toHaveBeenCalled()
    expect(h.worker.leaseForSession('session-42')).toBe(dispatch.leaseId)
    await h.worker.tick()
    expect(h.cp.heartbeat).toHaveBeenLastCalledWith({ leases: [expect.objectContaining({ liveness: 'turn' })] })
  })

  it('reports the terminal the nudge turn produced under its own outcome and reason', async () => {
    const h = harness()
    await h.worker.dispatch(dispatch)
    await h.settle()
    await h.worker.recordTerminal(dispatch.leaseId, { outcome: 'completed', reasonCode: 'agent_done', summary: 's' })
    await h.settleNudge()
    expect(h.cp.report).toHaveBeenCalledOnce()
    expect(h.cp.report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'completed', reasonCode: 'agent_done' })
    )
    expect(h.nudge).toHaveBeenCalledOnce()
  })

  it('reports protocol_violation after the nudge when the agent still ignores the protocol, and never nudges twice', async () => {
    const h = harness()
    await h.worker.dispatch(dispatch)
    await h.settle()
    await h.settleNudge()
    expect(h.cp.report).toHaveBeenCalledOnce()
    expect(h.cp.report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'protocol_violation', reasonCode: 'no_terminal_call_after_nudge' })
    )
    await h.worker.tick()
    expect(h.nudge).toHaveBeenCalledOnce()
    expect(h.worker.get(dispatch.leaseId)).toBeUndefined()
  })

  it.each<KanbanDispatchRefusal>(['busy', 'draining', 'paused', 'no_agent'])(
    'reports protocol_violation at once when the nudge is refused (%s)',
    async (reason) => {
      const h = harness()
      h.state.nudgeRefusal = reason
      await h.worker.dispatch(dispatch)
      await h.settle()
      expect(h.cp.report).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'protocol_violation', reasonCode: 'nudge_unavailable' })
      )
    }
  )

  it('reports protocol_violation at once when starting the nudge throws', async () => {
    const h = harness()
    h.state.nudgeThrows = true
    await h.worker.dispatch(dispatch)
    await h.settle()
    expect(h.cp.report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'protocol_violation', reasonCode: 'nudge_unavailable' })
    )
  })

  it('classifies an erroring nudge turn like any turn error and does not nudge again', async () => {
    const h = harness()
    await h.worker.dispatch(dispatch)
    await h.settle()
    await h.failNudge(new Error('API Error: 529 overloaded'))
    expect(h.cp.report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'transient', reasonCode: 'provider_overloaded' })
    )
    expect(h.nudge).toHaveBeenCalledOnce()

    const g = harness()
    await g.worker.dispatch(dispatch)
    await g.settle()
    await g.failNudge(new Error('Incorrect API key provided'))
    expect(g.cp.report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', reasonCode: 'provider_auth' })
    )
  })

  it('does not nudge a turn that errored, was interrupted, or whose lease was superseded', async () => {
    const errored = harness()
    await errored.worker.dispatch(dispatch)
    errored.state.active = false
    errored.reject(new Error('boom'))
    await Promise.resolve()
    await errored.worker.tick()
    expect(errored.nudge).not.toHaveBeenCalled()

    const interrupted = harness()
    await interrupted.worker.dispatch(dispatch)
    interrupted.state.active = false
    ;(
      interrupted.worker as unknown as { settleTurn(id: string, s?: string, e?: unknown, i?: boolean): void }
    ).settleTurn(dispatch.leaseId, undefined, undefined, true)
    await interrupted.worker.tick()
    expect(interrupted.nudge).not.toHaveBeenCalled()
    expect(interrupted.cp.report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'protocol_violation', reasonCode: 'no_terminal_call' })
    )

    const superseded = harness()
    await superseded.worker.dispatch(dispatch)
    superseded.cp.heartbeat.mockResolvedValueOnce({ superseded: [dispatch.leaseId] })
    await superseded.worker.tick()
    await superseded.settle()
    expect(superseded.nudge).not.toHaveBeenCalled()
    expect(superseded.cp.report).not.toHaveBeenCalled()
  })

  it('drops the report when the lease is superseded while the nudge is being admitted', async () => {
    const h = harness()
    await h.worker.dispatch(dispatch)
    h.nudge.mockImplementationOnce(async () => {
      ;(h.worker as unknown as { leases: Map<string, unknown> }).leases.delete(dispatch.leaseId)
      return { accepted: false as const, reason: 'busy' as const }
    })
    await h.settle()
    expect(h.cp.report).not.toHaveBeenCalled()
  })

  it('does not nudge when the worker is stopping and does not double-nudge concurrent settle paths', async () => {
    const h = harness()
    h.worker.stop()
    await h.worker.dispatch(dispatch)
    await h.settle()
    expect(h.nudge).not.toHaveBeenCalled()
    expect(h.cp.report).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: 'no_terminal_call' }))

    const g = harness()
    await g.worker.dispatch(dispatch)
    g.state.active = false
    g.state.tasks = 0
    // The settle timer and the heartbeat tick both see an idle settled lease at once; only one nudge may start.
    await Promise.resolve()
    await Promise.all([g.settle(), g.worker.tick(), g.clock.advance(1)])
    expect(g.nudge).toHaveBeenCalledOnce()
  })
})
