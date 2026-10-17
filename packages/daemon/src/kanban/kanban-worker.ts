// Kanban worker (issue #2 M2): owns this daemon's card leases; liveness comes from turn and background-task state, never the model.
import {
  KANBAN_MAX_LEASES_PER_BEAT,
  KANBAN_REASON_NO_TERMINAL_AFTER_NUDGE,
  KANBAN_REASON_NO_TERMINAL_CALL,
  KANBAN_REASON_NUDGE_DEFERRED,
  KANBAN_REASON_NUDGE_UNAVAILABLE,
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
import { classifyProviderError, type ProviderErrorClass } from './provider-error.js'

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
/** Progress notes one lease may post; the final summary comment is separate and never counted. */
export const KANBAN_PROGRESS_NOTE_CAP = 10

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
  /** Classified once when the turn errored; transient reports `transient`, everything else a counted `failed`. */
  turnErrorClass?: ProviderErrorClass
  /** The one protocol-violation nudge was spent (or refused); a lease is never nudged twice. The flag is in memory, so a restart falls to the CP reaper instead of re-nudging. */
  nudged: boolean
  /** Progress notes posted or in flight under this lease, against {@link KANBAN_PROGRESS_NOTE_CAP}. */
  progressNotes: number
  /** The turn was interrupted by the operator; that is reported as it ended, never nudged. */
  interrupted?: boolean
  /** The nudge could not be started, so the violation is reported at once. */
  nudgeRefused?: boolean
  /** Why the nudge was refused; paused/draining defer (transient) instead of charging a protocol violation. */
  nudgeRefusalReason?: KanbanDispatchRefusal
  terminal?: KanbanTerminal
}

/** What the daemon can observe about a lease's session right now. */
export interface KanbanLivenessProbe {
  turnActive(sessionKey: string): boolean
  liveBackgroundTasks(agentId: string, sessionId: string, sessionKey: string): number | Promise<number>
}

export type KanbanStartResult =
  | { accepted: true; sessionKey: string; done: Promise<string | null> }
  | { accepted: false; reason: KanbanDispatchRefusal }

/** Durable report outbox: a terminal report survives CP outages and daemon restarts until the CP answers. */
export interface KanbanReportOutbox {
  has(leaseId: string): Promise<boolean>
  reserve(leaseId: string, queuedAt: number): Promise<void>
  release(leaseId: string): Promise<void>
  put(report: KanbanReport, queuedAt: number): Promise<void>
  list(limit: number): Promise<KanbanReport[]>
  remove(leaseId: string): Promise<void>
  /** Claim the lease's single terminal outcome; false when one is already recorded. */
  recordTerminal(entry: KanbanTerminalEntry, at: number): Promise<boolean>
  /** Recorded terminals whose report was never queued (the daemon stopped mid-run). */
  orphanedTerminals(): Promise<KanbanTerminalEntry[]>
  /** The CP answered the report: accepted queues the final comment, superseded drops it. */
  settleTerminal(leaseId: string, accepted: boolean): Promise<void>
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
  /** Admission gates (agent present, paused, draining, write worktree). */
  gate(d: KanbanDispatch): Promise<KanbanDispatchRefusal | undefined>
  /** Admit the turn; resolves once the serial gate settles admission. `onSessionReady` fires once the ACP session exists. */
  start(d: KanbanDispatch, onSessionReady: (sessionId: string) => void): Promise<KanbanStartResult>
  /** Run one more turn in the lease's session with the fixed nudge prompt; same admission machinery as `start`. */
  nudge(d: KanbanDispatch): Promise<KanbanStartResult>
  cancel(lease: KanbanLease): void | Promise<void>
  /** Forget the session for a revoked lease even when the lease has already finalized; the next dispatch opens fresh. */
  forget(agentId: string, sessionKey: string): Promise<void>
  probe: KanbanLivenessProbe
  comments?: KanbanFinalComments
  heartbeatMs?: number
  /** A lease was admitted or dropped. The git-credential cache drops that repo's grants. */
  onLeaseChanged?(dispatch: KanbanDispatch): void
}

export const KANBAN_HEARTBEAT_MS = 60_000
const FLUSH_BATCH = 50

export class KanbanWorker {
  private readonly leases = new Map<string, KanbanLease>()
  // A CP retry of an in-flight admission joins it instead of racing the outbox reservation.
  private readonly admitting = new Map<string, Promise<KanbanDispatchOk>>()
  // Last known session key per lease, kept after finalize so a late revoke forgets exactly the addressed session.
  private readonly sessionsByLease = new Map<string, { agentId: string; sessionKey: string }>()
  private timer: TimerHandle | undefined
  private stopped = true
  // Set only by stop(), so a worker that was never started still nudges (the daemon always starts it).
  private halted = false
  private flushing = false
  private beating = false

  constructor(private readonly deps: KanbanWorkerDeps) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.halted = false
    // Comments recorded before a restart are already due; don't wait a heartbeat to post them.
    void this.requeueOrphans().then(() => this.drainComments())
    this.arm()
  }

  stop(): void {
    this.stopped = true
    this.halted = true
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Read-only view for diagnostics and tests. */
  get(leaseId: string): Readonly<KanbanLease> | undefined {
    return this.leases.get(leaseId)
  }

  /** `kanban/dispatch` REQ: admit the card's turn into its GitHub thread session, or refuse with a typed reason. */
  dispatch(d: KanbanDispatch): Promise<KanbanDispatchOk> {
    const inFlight = this.admitting.get(d.leaseId)
    if (inFlight) return inFlight
    const admission = this.admit(d).finally(() => this.admitting.delete(d.leaseId))
    this.admitting.set(d.leaseId, admission)
    return admission
  }

  async revoke(leaseId: string, cardId: string): Promise<void> {
    await this.admitting.get(leaseId)?.catch(() => undefined)
    const lease = this.leases.get(leaseId)
    if (lease && lease.dispatch.cardId === cardId) {
      await this.deps.cancel(lease)
      this.leases.delete(leaseId)
      this.deps.onLeaseChanged?.(lease.dispatch)
      await this.deps.outbox.release(leaseId)
      this.sessionsByLease.delete(leaseId)
      return
    }
    const remembered = this.sessionsByLease.get(leaseId)
    if (remembered) {
      await this.deps.forget(remembered.agentId, remembered.sessionKey)
      this.sessionsByLease.delete(leaseId)
    }
  }

  private async admit(d: KanbanDispatch): Promise<KanbanDispatchOk> {
    if (this.leases.has(d.leaseId)) return { leaseId: d.leaseId, accepted: true }
    try {
      if (await this.deps.outbox.has(d.leaseId)) return { leaseId: d.leaseId, accepted: true }
    } catch {
      return { leaseId: d.leaseId, accepted: false, reason: 'durability' }
    }
    const refusal = await this.deps.gate(d)
    if (refusal) return { leaseId: d.leaseId, accepted: false, reason: refusal }
    try {
      await this.deps.outbox.reserve(d.leaseId, this.deps.clock.now())
    } catch {
      return { leaseId: d.leaseId, accepted: false, reason: 'durability' }
    }
    let readySessionId: string | undefined
    let started: KanbanStartResult
    try {
      started = await this.deps.start(d, (sessionId) => {
        readySessionId = sessionId
        const lease = this.leases.get(d.leaseId)
        if (lease) lease.sessionId = sessionId
      })
    } catch {
      started = { accepted: false, reason: 'busy' }
    }
    if (!started.accepted) {
      await this.deps.outbox.release(d.leaseId).catch(() => undefined)
      return { leaseId: d.leaseId, accepted: false, reason: started.reason }
    }
    // The CP mints a new lease for a card only after ending the old one, so an older local lease is already superseded.
    for (const [id, lease] of this.leases) {
      if (lease.dispatch.cardId !== d.cardId) continue
      this.leases.delete(id)
      this.deps.onLeaseChanged?.(lease.dispatch)
    }
    const lease: KanbanLease = {
      dispatch: d,
      sessionKey: started.sessionKey,
      sessionId: readySessionId,
      turnSettled: false,
      nudged: false,
      progressNotes: 0
    }
    this.leases.set(d.leaseId, lease)
    this.sessionsByLease.set(d.leaseId, { agentId: d.agentId, sessionKey: started.sessionKey })
    this.deps.onLeaseChanged?.(d)
    this.watchTurn(d.leaseId, started.done)
    return { leaseId: d.leaseId, accepted: true }
  }

  forSession(sessionKey: string): KanbanDispatch | undefined {
    for (const lease of this.leases.values()) if (lease.sessionKey === sessionKey) return lease.dispatch
    return undefined
  }

  /** Open runs, so the git-credential cache can key a helper grant by lease and mode. */
  credentialScopes(): Array<{
    agentId: string
    repoFullName: string
    leaseId: string
    mode: 'read' | 'write'
  }> {
    return [...this.leases.values()].map((lease) => ({
      agentId: lease.dispatch.agentId,
      repoFullName: lease.dispatch.repoFullName,
      leaseId: lease.dispatch.leaseId,
      mode: lease.dispatch.mode
    }))
  }

  /** The live lease a session's terminal tool binds to; the agent never names it. */
  leaseForSession(sessionKey: string): string | undefined {
    for (const [id, lease] of this.leases) if (lease.sessionKey === sessionKey) return id
    return undefined
  }

  /** The live lease a worker tool binds to; none once the run reported its outcome, since the card then belongs to AgentConnect. */
  toolLease(
    sessionKey: string
  ): { ok: true; lease: Readonly<KanbanLease> } | { ok: false; reason: 'no_lease' | 'already_reported' } {
    for (const lease of this.leases.values()) {
      if (lease.sessionKey !== sessionKey) continue
      return lease.terminal ? { ok: false, reason: 'already_reported' } : { ok: true, lease }
    }
    return { ok: false, reason: 'no_lease' }
  }

  /** Claim the next progress-note number synchronously, so concurrent calls cannot pass the cap together; undefined when refused. */
  reserveProgressNote(leaseId: string): number | undefined {
    const lease = this.leases.get(leaseId)
    if (!lease || lease.terminal || lease.progressNotes >= KANBAN_PROGRESS_NOTE_CAP) return undefined
    return ++lease.progressNotes
  }

  /** Give the slot back when the note did not post. */
  releaseProgressNote(leaseId: string): void {
    const lease = this.leases.get(leaseId)
    if (lease && lease.progressNotes > 0) lease.progressNotes -= 1
  }

  /** Record the run's one outcome durably; the report is sent once the session goes idle, so the turn can finish. */
  async recordTerminal(leaseId: string, terminal: KanbanTerminal): Promise<KanbanTerminalResult> {
    const lease = this.leases.get(leaseId)
    if (!lease) return { recorded: false, reason: 'no_lease' }
    if (lease.terminal) return { recorded: false, reason: 'already_reported' }
    const d = lease.dispatch
    let fresh: boolean
    try {
      fresh = await this.deps.outbox.recordTerminal(
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
  async liveness(lease: KanbanLease): Promise<KanbanLeaseBeat['liveness'] | null> {
    if (this.deps.probe.turnActive(lease.sessionKey)) return 'turn'
    if (
      lease.sessionId &&
      (await this.deps.probe.liveBackgroundTasks(lease.dispatch.agentId, lease.sessionId, lease.sessionKey)) > 0
    )
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
        const live = await this.liveness(lease)
        if (this.leases.get(leaseId) !== lease) continue
        if (live === null) {
          if (lease.turnSettled) await this.conclude(leaseId, lease)
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
                await this.deps.cancel(lease)
                this.deps.onLeaseChanged?.(lease.dispatch)
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
      for (const report of await this.deps.outbox.list(FLUSH_BATCH)) {
        try {
          const reply = await cp.report(report)
          if (!reply.accepted) this.deps.log.info(`kanban: report for lease ${report.leaseId} superseded`)
          // Settle before the ACK: a crash between the two resends the report, and the CP answers a replay idempotently.
          await this.deps.outbox.settleTerminal(report.leaseId, reply.accepted)
          await this.deps.outbox.remove(report.leaseId)
          if (reply.accepted) accepted = true
        } catch (err) {
          if (err instanceof WireError && !err.retryable) {
            this.deps.log.warn(`kanban: dead-lettering report for lease ${report.leaseId} (${err.code})`)
            await this.deps.outbox.settleTerminal(report.leaseId, false)
            await this.deps.outbox.remove(report.leaseId)
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
  private async requeueOrphans(): Promise<void> {
    try {
      for (const entry of await this.deps.outbox.orphanedTerminals()) {
        if (this.leases.has(entry.report.leaseId)) continue
        await this.deps.outbox.put(entry.report, this.deps.clock.now())
        this.deps.log.info(`kanban: requeued recorded ${entry.report.outcome} for lease ${entry.report.leaseId}`)
      }
    } catch (err) {
      this.deps.log.warn(`kanban: terminal recovery failed (${String(err)})`)
    }
  }

  private watchTurn(leaseId: string, done: Promise<string | null>): void {
    done.then(
      // A null session id is an operator interrupt, which is not a forgotten terminal call.
      (sessionId) => this.settleTurn(leaseId, sessionId ?? undefined, undefined, sessionId === null),
      (err: unknown) => this.settleTurn(leaseId, undefined, err, false, true)
    )
  }

  private settleTurn(leaseId: string, sessionId?: string, error?: unknown, interrupted = false, failed = false): void {
    const lease = this.leases.get(leaseId)
    if (!lease) return
    lease.turnSettled = true
    if (sessionId) lease.sessionId ??= sessionId
    if (failed || error !== undefined) {
      lease.turnError = error instanceof Error ? error.message : String(error)
      lease.turnErrorClass = classifyProviderError(error)
      this.deps.log.warn(`kanban: lease ${leaseId} turn failed (${lease.turnError})`)
    }
    // An interrupted turn is the operator's call, so it is reported as it ended rather than nudged.
    if (interrupted) lease.interrupted = true
    // The dispatch bookkeeping clears just after the turn promise settles, so re-check on the next timer turn.
    this.deps.clock.setTimeout(() => {
      const current = this.leases.get(leaseId)
      if (!current) return
      void this.liveness(current)
        .then(async (live) => {
          if (live !== null || this.leases.get(leaseId) !== current || !current.turnSettled) return
          await this.conclude(leaseId, current)
          await this.flush()
        })
        .catch((err: unknown) =>
          this.deps.log.warn(`kanban: report persistence failed for ${leaseId} (${String(err)})`)
        )
    }, 0)
  }

  /** A settled, idle lease ends here: with no terminal call and no error it gets its one nudge turn first. */
  private async conclude(leaseId: string, lease: KanbanLease): Promise<void> {
    if (lease.terminal || lease.turnErrorClass || lease.interrupted || lease.nudged || this.halted)
      return this.finalize(leaseId, lease)
    // Claimed before any await so the tick and the settle timer cannot both nudge.
    lease.nudged = true
    lease.turnSettled = false
    let started: KanbanStartResult | undefined
    try {
      started = await this.deps.nudge(lease.dispatch)
    } catch (err) {
      this.deps.log.warn(`kanban: nudge for lease ${leaseId} failed to start (${String(err)})`)
    }
    // A supersede during admission drops the lease; its report must not be written.
    if (this.leases.get(leaseId) !== lease) return
    if (!started?.accepted) {
      lease.nudgeRefused = true
      lease.nudgeRefusalReason = started?.reason
      lease.turnSettled = true
      return this.finalize(leaseId, lease)
    }
    this.deps.log.info(`kanban: lease ${leaseId} ended its turn without a terminal call; nudged once`)
    this.watchTurn(leaseId, started.done)
  }

  private async finalize(leaseId: string, lease: KanbanLease): Promise<void> {
    const report = this.buildReport(leaseId, lease)
    await this.deps.outbox.put(report, this.deps.clock.now())
    this.leases.delete(leaseId)
    this.deps.onLeaseChanged?.(lease.dispatch)
    this.deps.log.info(`kanban: lease ${leaseId} ended (${report.outcome})`)
  }

  private buildReport(leaseId: string, lease: KanbanLease): KanbanReport {
    const d = lease.dispatch
    const terminal = lease.terminal
    const errorClass = lease.turnErrorClass
    // A nudge refused because the agent is paused or the daemon is draining is not the card's fault: a non-provider transient (fixed cooldown), not a counted protocol violation.
    const nudgeDeferred =
      lease.nudgeRefused && (lease.nudgeRefusalReason === 'paused' || lease.nudgeRefusalReason === 'draining')
    const outcome: KanbanReportOutcome =
      terminal?.outcome ??
      (errorClass
        ? errorClass.kind === 'transient'
          ? 'transient'
          : 'failed'
        : nudgeDeferred
          ? 'transient'
          : 'protocol_violation')
    const reasonCode =
      terminal?.reasonCode ??
      (terminal
        ? undefined
        : (errorClass?.reasonCode ??
          (lease.nudgeRefused
            ? nudgeDeferred
              ? KANBAN_REASON_NUDGE_DEFERRED
              : KANBAN_REASON_NUDGE_UNAVAILABLE
            : lease.nudged
              ? KANBAN_REASON_NO_TERMINAL_AFTER_NUDGE
              : KANBAN_REASON_NO_TERMINAL_CALL)))
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
