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

/** How a run ended, as the terminal tools record it; absent at turn end ⇒ `protocol_violation`. */
export interface KanbanTerminal {
  outcome: Exclude<KanbanReportOutcome, 'protocol_violation'>
  blockKind?: KanbanBlockKind
  reasonCode?: string
  prNumber?: number
  /** Free text for the final issue comment; it stays on the daemon and never rides the body-free report. */
  summary?: string
  reason?: string
}

export const KANBAN_SUMMARY_MAX_CHARS = 20_000
export const KANBAN_REASON_MAX_CHARS = 2_000

/** A durably recorded terminal outcome: the report to send plus the comment to post once the CP accepts it. */
export interface KanbanTerminalEntry {
  report: KanbanReport
  repoFullName: string
  issueNumber: number
  summary: string
  reason?: string
}

export type KanbanTerminalResult =
  | { recorded: true; dispatch: KanbanDispatch }
  | { recorded: false; reason: 'no_lease' | 'already_reported' | 'durability' }

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
  /** Claim the lease's single terminal outcome; false when one is already recorded. */
  recordTerminal(entry: KanbanTerminalEntry, at: number): boolean
  /** Recorded terminals whose report was never queued (the daemon stopped mid-run). */
  orphanedTerminals(): KanbanTerminalEntry[]
  /** The CP answered the report: accepted queues the final comment, superseded drops it. */
  settleTerminal(leaseId: string, accepted: boolean): void
}

/** Posts the final comments of accepted terminal reports; single-flight and retrying on its own schedule. */
export interface KanbanFinalComments {
  drain(): Promise<void>
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
  comments?: KanbanFinalComments
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
    this.requeueOrphans()
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

  /** The live lease a session's terminal tool binds to; the agent never names it. */
  leaseForSession(sessionKey: string): string | undefined {
    for (const [id, lease] of this.leases) if (lease.sessionKey === sessionKey) return id
    return undefined
  }

  /** Record the run's one outcome durably; the report is sent once the session goes idle, so the turn can finish. */
  recordTerminal(leaseId: string, terminal: KanbanTerminal): KanbanTerminalResult {
    const lease = this.leases.get(leaseId)
    if (!lease) return { recorded: false, reason: 'no_lease' }
    if (lease.terminal) return { recorded: false, reason: 'already_reported' }
    const d = lease.dispatch
    let fresh: boolean
    try {
      fresh = this.deps.outbox.recordTerminal(
        {
          report: this.buildReport(leaseId, { ...lease, terminal }),
          repoFullName: d.repoFullName,
          issueNumber: d.issueNumber,
          summary: terminal.summary ?? '',
          ...(terminal.reason ? { reason: terminal.reason } : {})
        },
        this.deps.clock.now()
      )
    } catch (err) {
      this.deps.log.warn(`kanban: terminal persistence failed for ${leaseId} (${String(err)})`)
      return { recorded: false, reason: 'durability' }
    }
    if (!fresh) return { recorded: false, reason: 'already_reported' }
    lease.terminal = terminal
    return { recorded: true, dispatch: d }
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
    // Retries comments whose earlier post failed, on the publisher's own backoff.
    this.drainComments()
  }

  /** Send queued reports oldest first; a CP answer (accepted or superseded) or a permanent refusal releases the row. */
  async flush(): Promise<void> {
    const cp = this.deps.cp()
    if (!cp?.ready() || this.flushing) return
    this.flushing = true
    let accepted = false
    try {
      for (const report of this.deps.outbox.list(FLUSH_BATCH)) {
        try {
          const reply = await cp.report(report)
          if (!reply.accepted) this.deps.log.info(`kanban: report for lease ${report.leaseId} superseded`)
          // Settle before the ACK: a crash between the two resends the report, and the CP answers a replay idempotently.
          this.deps.outbox.settleTerminal(report.leaseId, reply.accepted)
          this.deps.outbox.remove(report.leaseId)
          if (reply.accepted) accepted = true
        } catch (err) {
          if (err instanceof WireError && !err.retryable) {
            this.deps.log.warn(`kanban: dead-lettering report for lease ${report.leaseId} (${err.code})`)
            this.deps.outbox.settleTerminal(report.leaseId, false)
            this.deps.outbox.remove(report.leaseId)
            continue
          }
          // Transient: keep the row; the next beat or reconnect retries.
          return
        }
      }
    } finally {
      this.flushing = false
      if (accepted) this.drainComments()
    }
  }

  private drainComments(): void {
    // Shutdown's final flush only hands reports over; comments wait for the next start.
    if (this.stopped) return
    void this.deps.comments
      ?.drain()
      .catch((err: unknown) => this.deps.log.warn(`kanban: final comment drain failed (${String(err)})`))
  }

  /** A terminal recorded before a restart is still the run's word: queue its report, and the lease fence decides. */
  private requeueOrphans(): void {
    try {
      for (const entry of this.deps.outbox.orphanedTerminals()) {
        if (this.leases.has(entry.report.leaseId)) continue
        this.deps.outbox.put(entry.report, this.deps.clock.now())
        this.deps.log.info(`kanban: requeued recorded ${entry.report.outcome} for lease ${entry.report.leaseId}`)
      }
    } catch (err) {
      this.deps.log.warn(`kanban: terminal recovery failed (${String(err)})`)
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
    const report = this.buildReport(leaseId, lease)
    this.deps.outbox.put(report, this.deps.clock.now())
    this.leases.delete(leaseId)
    this.deps.log.info(`kanban: lease ${leaseId} ended (${report.outcome})`)
  }

  private buildReport(leaseId: string, lease: KanbanLease): KanbanReport {
    const d = lease.dispatch
    const terminal = lease.terminal
    const outcome: KanbanReportOutcome = terminal?.outcome ?? (lease.turnError ? 'failed' : 'protocol_violation')
    const reasonCode =
      terminal?.reasonCode ?? (terminal ? undefined : lease.turnError ? 'turn_error' : 'no_terminal_call')
    return {
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
