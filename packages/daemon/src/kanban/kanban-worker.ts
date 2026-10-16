// Kanban worker (issue #2 M2): owns this daemon's card leases; liveness comes from turn and background-task state, never the model.
import {
  KANBAN_MAX_LEASES_PER_BEAT,
  type KanbanBlockKind,
  type KanbanDispatch,
  type KanbanDispatchOk,
  type KanbanDispatchRefusal,
  type KanbanLeaseBeat,
  type KanbanLeaseHeartbeat,
  type KanbanLeaseHeartbeatOk,
  type KanbanReport,
  type KanbanReportOk,
  type KanbanReportOutcome
} from '@agentconnect.md/protocol'
import { WireError, type Clock, type TimerHandle } from '@agentconnect.md/connection'

/** How a run ended, as the M3 terminal tools will record it; absent at turn end ⇒ `protocol_violation`. */
export interface KanbanTerminal {
  outcome: Exclude<KanbanReportOutcome, 'protocol_violation'>
  blockKind?: KanbanBlockKind
  reasonCode?: string
  prNumber?: number
}

export interface KanbanLease {
  dispatch: KanbanDispatch
  /** The daemon-local logical session key the card's turns run under. */
  sessionKey: string
  sessionId?: string
  /** The dispatched turn has ended (successfully or not); later turns in the session are tracked by probe only. */
  turnSettled: boolean
  turnError?: string
  terminal?: KanbanTerminal
}

/** What the daemon can observe about a lease's session right now. */
export interface KanbanLivenessProbe {
  turnActive(sessionKey: string): boolean
  liveBackgroundTasks(agentId: string, sessionId: string): number
}

export type KanbanStartResult =
  | { accepted: true; sessionKey: string; done: Promise<string | null> }
  | { accepted: false; reason: KanbanDispatchRefusal }

/** Durable report outbox: a terminal report survives CP outages and daemon restarts until the CP answers. */
export interface KanbanReportOutbox {
  has(leaseId: string): boolean
  reserve(leaseId: string, queuedAt: number): void
  release(leaseId: string): void
  put(report: KanbanReport, queuedAt: number): void
  list(limit: number): KanbanReport[]
  remove(leaseId: string): void
}

export interface KanbanCpLink {
  ready(): boolean
  heartbeat(payload: KanbanLeaseHeartbeat): Promise<KanbanLeaseHeartbeatOk>
  report(payload: KanbanReport): Promise<KanbanReportOk>
}

export interface KanbanWorkerDeps {
  clock: Clock
  log: { debug(m: string): void; info(m: string): void; warn(m: string): void }
  outbox: KanbanReportOutbox
  cp(): KanbanCpLink | undefined
  /** Synchronous admission gates (agent present, paused, draining, write worktree). */
  gate(d: KanbanDispatch): KanbanDispatchRefusal | undefined
  /** Admit the turn; `onSessionReady` fires once the ACP session exists. */
  start(d: KanbanDispatch, onSessionReady: (sessionId: string) => void): KanbanStartResult
  cancel(lease: KanbanLease): void
  probe: KanbanLivenessProbe
  heartbeatMs?: number
}

export const KANBAN_HEARTBEAT_MS = 60_000
const FLUSH_BATCH = 50

export class KanbanWorker {
  private readonly leases = new Map<string, KanbanLease>()
  private timer: TimerHandle | undefined
  private stopped = true
  private flushing = false
  private beating = false

  constructor(private readonly deps: KanbanWorkerDeps) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Read-only view for diagnostics and tests. */
  get(leaseId: string): Readonly<KanbanLease> | undefined {
    return this.leases.get(leaseId)
  }

  /** `kanban/dispatch` REQ: admit the card's turn into its GitHub thread session, or refuse with a typed reason. */
  dispatch(d: KanbanDispatch): KanbanDispatchOk {
    if (this.leases.has(d.leaseId) || this.deps.outbox.has(d.leaseId)) return { leaseId: d.leaseId, accepted: true }
    const refusal = this.deps.gate(d)
    if (refusal) return { leaseId: d.leaseId, accepted: false, reason: refusal }
    try {
      this.deps.outbox.reserve(d.leaseId, this.deps.clock.now())
    } catch {
      return { leaseId: d.leaseId, accepted: false, reason: 'durability' }
    }
    let readySessionId: string | undefined
    const started = this.deps.start(d, (sessionId) => {
      readySessionId = sessionId
      const lease = this.leases.get(d.leaseId)
      if (lease) lease.sessionId = sessionId
    })
    if (!started.accepted) {
      this.deps.outbox.release(d.leaseId)
      return { leaseId: d.leaseId, accepted: false, reason: started.reason }
    }
    // The CP mints a new lease for a card only after ending the old one, so an older local lease is already superseded.
    for (const [id, lease] of this.leases) if (lease.dispatch.cardId === d.cardId) this.leases.delete(id)
    const lease: KanbanLease = {
      dispatch: d,
      sessionKey: started.sessionKey,
      sessionId: readySessionId,
      turnSettled: false
    }
    this.leases.set(d.leaseId, lease)
    started.done.then(
      (sessionId) => this.settleTurn(d.leaseId, sessionId ?? undefined),
      (err: unknown) => this.settleTurn(d.leaseId, undefined, err instanceof Error ? err.message : String(err))
    )
    return { leaseId: d.leaseId, accepted: true }
  }

  forSession(sessionKey: string): KanbanDispatch | undefined {
    for (const lease of this.leases.values()) if (lease.sessionKey === sessionKey) return lease.dispatch
    return undefined
  }

  /** M3 seam: the terminal tool records the run's outcome; the report is sent once the session goes idle. */
  recordTerminal(leaseId: string, terminal: KanbanTerminal): boolean {
    const lease = this.leases.get(leaseId)
    if (!lease || lease.terminal) return false
    lease.terminal = terminal
    return true
  }

  /** Liveness for one lease, or null when nothing is running for it. */
  liveness(lease: KanbanLease): KanbanLeaseBeat['liveness'] | null {
    if (this.deps.probe.turnActive(lease.sessionKey)) return 'turn'
    if (lease.sessionId && this.deps.probe.liveBackgroundTasks(lease.dispatch.agentId, lease.sessionId) > 0)
      return 'background'
    return null
  }

  /** One beat: finalize idle settled leases, heartbeat the live ones, drop superseded, then drain the outbox. */
  async tick(): Promise<void> {
    if (this.beating) return
    this.beating = true
    try {
      const beats: KanbanLeaseBeat[] = []
      for (const [leaseId, lease] of [...this.leases]) {
        const live = this.liveness(lease)
        if (live === null) {
          if (lease.turnSettled) this.finalize(leaseId, lease)
          continue
        }
        beats.push({
          leaseId,
          cardId: lease.dispatch.cardId,
          dispatchRevision: lease.dispatch.dispatchRevision,
          liveness: live,
          ...(lease.sessionId ? { sessionId: lease.sessionId } : {})
        })
      }
      const cp = this.deps.cp()
      if (cp?.ready()) {
        for (let i = 0; i < beats.length; i += KANBAN_MAX_LEASES_PER_BEAT) {
          try {
            const { superseded } = await cp.heartbeat({ leases: beats.slice(i, i + KANBAN_MAX_LEASES_PER_BEAT) })
            for (const id of superseded) {
              const lease = this.leases.get(id)
              if (lease) {
                this.leases.delete(id)
                this.deps.cancel(lease)
                this.deps.log.info(`kanban: lease ${id} superseded by the control plane`)
              }
            }
          } catch (err) {
            this.deps.log.debug(`kanban: heartbeat failed (${err instanceof Error ? err.message : String(err)})`)
            break
          }
        }
      }
    } finally {
      this.beating = false
    }
    await this.flush()
  }

  /** Send queued reports oldest first; a CP answer (accepted or superseded) or a permanent refusal releases the row. */
  async flush(): Promise<void> {
    const cp = this.deps.cp()
    if (!cp?.ready() || this.flushing) return
    this.flushing = true
    try {
      for (const report of this.deps.outbox.list(FLUSH_BATCH)) {
        try {
          const reply = await cp.report(report)
          if (!reply.accepted) this.deps.log.info(`kanban: report for lease ${report.leaseId} superseded`)
          this.deps.outbox.remove(report.leaseId)
        } catch (err) {
          if (err instanceof WireError && !err.retryable) {
            this.deps.log.warn(`kanban: dead-lettering report for lease ${report.leaseId} (${err.code})`)
            this.deps.outbox.remove(report.leaseId)
            continue
          }
          // Transient: keep the row; the next beat or reconnect retries.
          return
        }
      }
    } finally {
      this.flushing = false
    }
  }

  private settleTurn(leaseId: string, sessionId?: string, error?: string): void {
    const lease = this.leases.get(leaseId)
    if (!lease) return
    lease.turnSettled = true
    if (sessionId) lease.sessionId ??= sessionId
    if (error) {
      lease.turnError = error
      this.deps.log.warn(`kanban: lease ${leaseId} turn failed (${error})`)
    }
    // The dispatch bookkeeping clears just after the turn promise settles, so re-check on the next timer turn.
    this.deps.clock.setTimeout(() => {
      const current = this.leases.get(leaseId)
      if (current && this.liveness(current) === null) {
        try {
          this.finalize(leaseId, current)
          void this.flush().catch((err: unknown) => this.deps.log.warn(`kanban: outbox flush failed (${String(err)})`))
        } catch (err) {
          this.deps.log.warn(`kanban: report persistence failed for ${leaseId} (${String(err)})`)
        }
      }
    }, 0)
  }

  private finalize(leaseId: string, lease: KanbanLease): void {
    const d = lease.dispatch
    const terminal = lease.terminal
    const outcome: KanbanReportOutcome = terminal?.outcome ?? (lease.turnError ? 'failed' : 'protocol_violation')
    const reasonCode =
      terminal?.reasonCode ?? (terminal ? undefined : lease.turnError ? 'turn_error' : 'no_terminal_call')
    const report: KanbanReport = {
      boardId: d.boardId,
      cardId: d.cardId,
      agentId: d.agentId,
      leaseId,
      attempt: d.attempt,
      dispatchRevision: d.dispatchRevision,
      outcome,
      ...(outcome === 'blocked' ? { blockKind: terminal?.blockKind ?? 'transient' } : {}),
      ...(reasonCode ? { reasonCode } : {}),
      ...(lease.sessionId ? { sessionId: lease.sessionId } : {}),
      ...(terminal?.prNumber ? { prNumber: terminal.prNumber } : {})
    }
    this.deps.outbox.put(report, this.deps.clock.now())
    this.leases.delete(leaseId)
    this.deps.log.info(`kanban: lease ${leaseId} ended (${outcome})`)
  }

  private arm(): void {
    if (this.stopped) return
    this.timer = this.deps.clock.setTimeout(() => {
      void this.tick()
        .catch((err: unknown) => this.deps.log.warn(`kanban: tick failed (${String(err)})`))
        .finally(() => this.arm())
    }, this.deps.heartbeatMs ?? KANBAN_HEARTBEAT_MS)
  }
}
