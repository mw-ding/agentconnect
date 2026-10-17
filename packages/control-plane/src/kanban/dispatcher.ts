// Central claims enforce caps and fence every run; the daemon executes with body-free grants and derives its own liveness.
import type {
  KanbanCardShow,
  KanbanCardShowOk,
  KanbanDispatch,
  KanbanDispatchOk,
  KanbanDispatchRefusal,
  KanbanLeaseBeat,
  KanbanReport,
  KanbanReportOk
} from '@agentconnect.md/protocol'
import type { Clock, TimerHandle } from '../domain/clock.js'
import type {
  GithubInstallationRepo,
  KanbanBoardRef,
  KanbanClaimedLease,
  KanbanDispatchRepo,
  KanbanRecoveryDue,
  KanbanRunEndResult,
  KanbanRunOutcomeValue
} from '../persistence/ports.js'
import {
  isStatusLabel,
  statusLabel,
  isDispatchableIssue,
  isPromotionResidue,
  observedCardStatus,
  parseStatusLabels,
  planRecovery,
  planStatusWrite,
  type KanbanStatus,
  type LabelPlan,
  type ObservedIssue
} from './card-state.js'
import type { CardIssue, CardStore, KanbanRepoRef } from './card-store.js'
import { planGraphPromotion } from './graph-reconciler.js'
import type { RepoPermissionLookup } from '../github/repo-permission.js'
import { authorizeHumanKanbanAction } from './human-action.js'
import { labelAdder } from './label-attribution.js'
import { planRunEnd, staleLeaseReason, type KanbanRunEnd } from './run-accounting.js'

export { WRITE_MODE_LABEL } from './card-store.js'

/** Refusals that will not fix themselves on retry: route to triage as a capability block. */
const CAPABILITY_REFUSALS: ReadonlySet<KanbanDispatchRefusal> = new Set(['no_agent', 'write_needs_worktree'])

export interface KanbanDispatcherLog {
  debug(obj: unknown, msg?: string): void
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
}

export interface KanbanDispatcherDeps {
  repo: KanbanDispatchRepo
  installations: Pick<GithubInstallationRepo, 'liveByOrgAndAccount'>
  store: Pick<
    CardStore,
    'readCard' | 'readGraph' | 'applyPlan' | 'statusSetByHuman' | 'promotionVerdict' | 'readLabelEvents'
  >
  /** Live write check for the human whose status label un-parks a card (the comment-command gate); the container always wires it. */
  humanAuthz?: { permissions: RepoPermissionLookup; appSlug: string | undefined }
  /** The daemon's live control connection; throws when it is gone. */
  send(daemonId: string, d: KanbanDispatch): Promise<KanbanDispatchOk>
  isDaemonLive(daemonId: string): boolean
  clock: Clock
  log: KanbanDispatcherLog
  /** Reconciler period when no doorbell rings (design §4: 60s). */
  tickMs?: number
  unackedGraceMs?: number
  epochGraceMs?: number
}

const DEFAULT_TICK_MS = 60_000
const DEFAULT_UNACKED_GRACE_MS = 2 * 60_000
const DEFAULT_EPOCH_GRACE_MS = 3 * 60_000
const REAP_BATCH = 500
/** Mismatch-parked cards re-read per board per tick; per-card backoff keeps the steady rate far lower. */
const RECOVERY_BATCH = 25
/** A pending promotion still unresolved after this many reads, or this long, escalates to a human. */
export const MAX_PROMOTION_CHECKS = 12
export const MAX_PROMOTION_AGE_MS = 6 * 60 * 60_000

/** Why recovery gave a pending promotion up to a human. */
export type PromotionAttention = 'unattributed' | 'unexpected_labels' | 'blockers_reopened' | 'unresolved'

/** How a pending promotion stands after one read: adopt it, clear it, leave it, or hand it to a human. */
type PendingOutcome = 'adopt' | 'clear' | 'inconclusive' | PromotionAttention

/** Body-free comment for an escalated card: it names only labels and the reason code. */
export function attentionComment(reason: PromotionAttention): string {
  return (
    `AgentConnect Kanban: this card's automatic promotion to \`ac/status:ready\` could not be confirmed ` +
    `(${reason}), so it was not dispatched. Remove and re-add \`ac/status:ready\` yourself (even if it is ` +
    `already present), or set another status, to continue.`
  )
}

/** The cap counts reads already deferred plus `pending` more; either the count or the intent's age ends retries. */
function promotionExhausted(card: KanbanRecoveryDue, now: Date, pending: number): boolean {
  if (card.promotionChecks + pending >= MAX_PROMOTION_CHECKS) return true
  return !!card.promotionStartedAt && now.getTime() - card.promotionStartedAt.getTime() >= MAX_PROMOTION_AGE_MS
}

/** A rolled-back or crashed promotion whose POST never returned is still watched for a late landing. */
function watching(card: KanbanRecoveryDue, now: Date): boolean {
  return !card.promotionPostAccepted && !!card.promotionWatchUntil && now.getTime() < card.promotionWatchUntil.getTime()
}

/** One recovery re-read: whether the card moved, and the fingerprint of what GitHub showed when it was read. */
interface RecoveryRead {
  moved: boolean
  observed?: string
}

/** What recovery compares between reads, so a GitHub change restarts the backoff: issue state and status labels only. */
export function recoveryFingerprint(issue: ObservedIssue | null): string {
  if (!issue) return 'missing'
  const statuses = issue.labels.filter((l) => isStatusLabel(l)).sort()
  return JSON.stringify([issue.state, issue.stateReason ?? null, statuses])
}

export class KanbanDispatcher {
  private timer: TimerHandle | undefined
  private stopped = false
  private readonly running = new Map<string, Promise<void>>()
  private readonly rerun = new Set<string>()
  private readonly recoveryDue = new Set<string>()
  private readonly background = new Set<Promise<unknown>>()
  private readonly statusWrites = new Map<string, Promise<void>>()

  constructor(private readonly deps: KanbanDispatcherDeps) {}

  start(): void {
    this.stopped = false
    this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Await in-flight reconciles and label writes (tests and shutdown). */
  async settle(): Promise<void> {
    while (this.running.size > 0 || this.background.size > 0) {
      await Promise.allSettled([...this.running.values(), ...this.background])
    }
  }

  /** Doorbell: reconcile one board now, single-flight with one trailing rerun. */
  poke(boardId: string): void {
    if (this.stopped) return
    if (this.running.has(boardId)) {
      this.rerun.add(boardId)
      return
    }
    const run = async (): Promise<void> => {
      do {
        this.rerun.delete(boardId)
        await this.reconcileBoard(boardId)
      } while (this.rerun.has(boardId) && !this.stopped)
    }
    const pending = run()
      .catch((err: unknown) => this.deps.log.warn({ err, boardId }, 'kanban: board reconcile failed'))
      .finally(() => this.running.delete(boardId))
    this.running.set(boardId, pending)
  }

  /** One reconciler pass: reap stale leases first so their slots are claimable, then claim every board. */
  async tick(): Promise<void> {
    await this.reap()
    for (const boardId of await this.deps.repo.listEnabledBoardIds()) {
      this.recoveryDue.add(boardId)
      this.poke(boardId)
    }
    await Promise.allSettled([...this.running.values()])
  }

  /** Reclaim every stale open lease to `ready`, counting no failure; returns how many were reclaimed. */
  async reap(): Promise<number> {
    const now = await this.deps.repo.now()
    const opts = {
      unackedGraceMs: this.deps.unackedGraceMs ?? DEFAULT_UNACKED_GRACE_MS,
      epochGraceMs: this.deps.epochGraceMs ?? DEFAULT_EPOCH_GRACE_MS
    }
    let reclaimed = 0
    let afterLeaseId: string | undefined
    for (;;) {
      const leases = await this.deps.repo.listOpenLeases(REAP_BATCH, afterLeaseId)
      for (const lease of leases) {
        const reason = staleLeaseReason(lease, now, opts)
        if (!reason) continue
        const result = await this.endRun(lease.leaseId, { outcome: 'reclaimed' }, `reclaimed:${reason}`, {
          reclaimIf: (current) => staleLeaseReason(current, now, opts) !== null
        })
        if (result.accepted) {
          reclaimed += 1
          this.deps.log.info({ leaseId: lease.leaseId, reason }, 'kanban: reclaimed stale lease')
        }
      }
      if (leases.length < REAP_BATCH) break
      afterLeaseId = leases.at(-1)!.leaseId
    }
    return reclaimed
  }

  async reconcileBoard(boardId: string): Promise<void> {
    // Recovery reads GitHub, so only the periodic tick runs it, never a doorbell or report poke.
    if (this.recoveryDue.delete(boardId)) await this.recoverMismatches(boardId)
    const leases = await this.deps.repo.claim(boardId, {
      now: await this.deps.repo.now(),
      isDaemonLive: (id) => this.deps.isDaemonLive(id)
    })
    await Promise.allSettled(leases.map((lease) => this.dispatchLease(lease)))
  }

  private async recoverMismatches(boardId: string): Promise<void> {
    const now = await this.deps.repo.now()
    for (const card of await this.deps.repo.listRecoveryDue(boardId, now, RECOVERY_BATCH)) {
      let read: RecoveryRead = { moved: false }
      try {
        read = card.promotion
          ? await this.recoverPromotion(boardId, card)
          : await this.ingest(boardId, card.issueNumber)
      } catch (err) {
        this.deps.log.warn({ err, boardId, issueNumber: card.issueNumber }, 'kanban: mismatch recovery read failed')
      }
      if (!read.moved) await this.deps.repo.deferRecovery(card.cardId, now, read.observed)
    }
  }

  /** A GitHub change to this card. A human doorbell reads now; a graph doorbell leaves a pending promotion on its backoff. */
  async onCardChanged(boardId: string, issueNumber: number, source: 'human' | 'graph' = 'graph'): Promise<boolean> {
    const pending = await this.deps.repo.getPendingPromotion(boardId, issueNumber)
    if (pending && source !== 'human') {
      const now = await this.deps.repo.now()
      if (pending.recoveryCheckAt && pending.recoveryCheckAt.getTime() > now.getTime()) return false
    } else {
      await this.deps.repo.resetRecovery(boardId, issueNumber)
    }
    if (!pending) return this.ingestCard(boardId, issueNumber)
    const now = await this.deps.repo.now()
    let read: RecoveryRead = { moved: false }
    try {
      read = await this.recoverPromotion(boardId, pending)
      return read.moved
    } finally {
      if (!read.moved) await this.deps.repo.deferRecovery(pending.cardId, now, read.observed)
    }
  }

  /** Body-free ingest shared by the doorbells and tick recovery; only a human's status edit un-parks a card. */
  async ingestCard(boardId: string, issueNumber: number): Promise<boolean> {
    return (await this.ingest(boardId, issueNumber)).moved
  }

  private async ingest(boardId: string, issueNumber: number): Promise<RecoveryRead> {
    const from = await this.deps.repo.getParkedStatus(boardId, issueNumber)
    if (!from) return { moved: false }
    const repo = await this.boardRepoRef(boardId)
    if (!repo) return { moved: false }
    const issue = await this.deps.store.readCard(repo, issueNumber)
    const observed = recoveryFingerprint(issue)
    const plan = planRecovery(from, issue)
    if (plan.kind === 'illegal') {
      this.deps.log.info(
        { boardId, issueNumber, from, requested: plan.requested },
        'kanban: recovery ignored a status move the state machine does not allow'
      )
      return { moved: false, observed }
    }
    if (plan.kind === 'none') return { moved: false, observed }
    // Agents write labels as the App bot, so an unattributed or non-human change never un-parks a card.
    if (!(await this.deps.store.statusSetByHuman(repo, issueNumber, plan.to))) {
      this.deps.log.info(
        { boardId, issueNumber, from, to: plan.to },
        'kanban: recovery ignored a non-human status label'
      )
      return { moved: false, observed }
    }
    if (!(await this.labelWriterAuthorized(repo, issueNumber, plan.to))) {
      this.deps.log.info(
        { boardId, issueNumber, from, to: plan.to },
        'kanban: recovery ignored a non-writer status label'
      )
      return { moved: false, observed }
    }
    return { moved: await this.deps.repo.ingestStatus(boardId, issueNumber, from, plan.to), observed }
  }

  // The human who added the status label must hold live write access, as a comment command's sender must; fail closed.
  private async labelWriterAuthorized(repo: KanbanRepoRef, issueNumber: number, to: KanbanStatus): Promise<boolean> {
    const authz = this.deps.humanAuthz
    if (!authz) return true
    const login = labelAdder(await this.deps.store.readLabelEvents(repo, issueNumber), statusLabel(to), authz.appSlug)
    if (!login) return false
    const verdict = await authorizeHumanKanbanAction({
      repo,
      actor: { login, type: 'User' },
      appSlug: authz.appSlug,
      permissions: authz.permissions
    })
    if (!verdict.ok && verdict.reason === 'lookup_failed') throw verdict.error
    return verdict.ok
  }

  // A failed promotion is adopted on proof, cleared once no ready label landed by its watch's end, else retried or escalated.
  private async recoverPromotion(boardId: string, card: KanbanRecoveryDue): Promise<RecoveryRead> {
    const now = await this.deps.repo.now()
    // Reads that keep throwing never reach a verdict, so the cap is checked before reading too.
    if (promotionExhausted(card, now, 0)) return this.escalatePromotion(boardId, card, 'unresolved')
    const repo = await this.boardRepoRef(boardId)
    if (!repo) return { moved: false }
    const issue = await this.deps.store.readCard(repo, card.issueNumber)
    const observed = recoveryFingerprint(issue)
    const outcome = await this.judgePending(repo, card, issue)
    if (outcome === 'inconclusive') {
      if (!promotionExhausted(card, now, 1)) return { moved: false, observed }
      return { ...(await this.escalatePromotion(boardId, card, 'unresolved', repo, issue)), observed }
    }
    if (outcome === 'adopt') {
      if (!(await this.deps.repo.settlePromotion(card.cardId, true))) return { moved: false, observed }
      // Residue is dispatchable as is, and the running write clears both labels.
      this.deps.log.info({ boardId, issueNumber: card.issueNumber }, 'kanban: adopted a half-landed graph promotion')
      return { moved: true }
    }
    if (outcome === 'clear') {
      // An unacknowledged POST may still land, so no ready label only clears once its watch has passed.
      if (watching(card, now)) return { moved: false, observed }
      await this.deps.repo.settlePromotion(card.cardId, false)
      return { moved: false, observed }
    }
    return { ...(await this.escalatePromotion(boardId, card, outcome, repo, issue)), observed }
  }

  // Adopt needs our acknowledged write (or a human's add) in the cursor window, the expected shape, and closed blockers.
  private async judgePending(
    repo: KanbanRepoRef,
    card: KanbanRecoveryDue,
    issue: CardIssue | null
  ): Promise<PendingOutcome> {
    // No ready label on an open issue: nothing landed (yet), or a human moved it; the caller watches or clears.
    if (!issue || issue.state !== 'open' || !issue.labels.includes(statusLabel('ready'))) return 'clear'
    const { statuses, malformed } = parseStatusLabels(issue.labels)
    const readyOnly = statuses.length === 1 && malformed.length === 0
    if (!readyOnly && !isPromotionResidue(issue)) return 'unexpected_labels'
    // A missing cursor (an intent from before cursors existed) admits only a human ready-add.
    const cursor = card.promotionEventCursor == null ? null : Number(card.promotionEventCursor)
    const verdict = await this.deps.store.promotionVerdict(
      repo,
      card.issueNumber,
      cursor ?? 0,
      cursor != null && card.promotionPostAccepted
    )
    if (verdict === 'inconclusive') return 'inconclusive'
    if (verdict === 'reject') return 'unattributed'
    const graph = await this.deps.store.readGraph(repo, card.issueNumber)
    if (graph.truncated) return 'inconclusive'
    return planGraphPromotion('todo', graph) === 'promote' ? 'adopt' : 'blockers_reopened'
  }

  // Back to todo with the attention flag, a warn log, and a best-effort issue comment so the board shows it.
  private async escalatePromotion(
    boardId: string,
    card: KanbanRecoveryDue,
    reason: PromotionAttention,
    repo?: KanbanRepoRef,
    issue?: CardIssue | null
  ): Promise<RecoveryRead> {
    const { issueNumber } = card
    if (!(await this.deps.repo.escalatePromotion(card.cardId, reason))) return { moved: false }
    this.deps.log.warn(
      { boardId, issueNumber, reason, checks: card.promotionChecks },
      'kanban: pending promotion needs human attention'
    )
    try {
      const target = repo ?? (await this.boardRepoRef(boardId))
      const plan: LabelPlan = {
        outcome: 'noop',
        status: 'todo',
        releaseLease: false,
        addLabels: [],
        removeLabels: [],
        comment: attentionComment(reason)
      }
      if (target) await this.deps.store.applyPlan(target, issueNumber, issue ?? { labels: [], state: 'open' }, plan)
    } catch (err) {
      this.deps.log.warn({ err, boardId, issueNumber }, 'kanban: attention comment failed')
    }
    return { moved: false }
  }

  /** Repo a daemon may post this accepted run's summary to. Null until the report has committed, and for any other daemon or repo. */
  commentGrant(
    daemonId: string,
    agentId: string,
    leaseId: string,
    repoFullName: string
  ): Promise<{ repoId: bigint } | null> {
    return this.deps.repo.kanbanCommentGrant(daemonId, agentId, leaseId, repoFullName)
  }

  /** Progress-note grant: the lease must still be open and current on this daemon and epoch. Falls back to the final-comment grant. */
  async liveCommentGrant(
    daemonId: string,
    epoch: number,
    agentId: string,
    leaseId: string,
    repoFullName: string
  ): Promise<{ repoId: bigint } | null> {
    return this.deps.repo.kanbanLiveCommentGrant(daemonId, BigInt(epoch), agentId, leaseId, repoFullName)
  }

  /** `kanban/card`: body-free metadata for the worker's own open lease; a stale one is answered as data. */
  async onCardShow(daemonId: string, epoch: number, req: KanbanCardShow): Promise<KanbanCardShowOk> {
    const card = await this.deps.repo.kanbanCardView(daemonId, BigInt(epoch), {
      boardId: req.boardId,
      cardId: req.cardId,
      leaseId: req.leaseId,
      dispatchRevision: BigInt(req.dispatchRevision)
    })
    return card
      ? { leaseId: req.leaseId, accepted: true, card }
      : { leaseId: req.leaseId, accepted: false, reason: 'superseded' }
  }

  /** `kanban/lease-heartbeat` from the daemon that holds these leases; returns the ones it must drop. */
  async onHeartbeat(daemonId: string, epoch: number, beats: KanbanLeaseBeat[]): Promise<string[]> {
    return this.deps.repo.heartbeat(
      daemonId,
      BigInt(epoch),
      beats.map((b) => ({
        leaseId: b.leaseId,
        cardId: b.cardId,
        dispatchRevision: BigInt(b.dispatchRevision),
        ...(b.sessionId ? { sessionId: b.sessionId } : {})
      })),
      await this.deps.repo.now()
    )
  }

  /** `kanban/report`: one fenced write; a superseded run is answered as data so the daemon drops its outbox row. */
  async onReport(daemonId: string, epoch: number, report: KanbanReport): Promise<KanbanReportOk> {
    const end: KanbanRunEnd =
      report.outcome === 'blocked'
        ? { outcome: 'blocked', blockKind: report.blockKind ?? 'transient' }
        : report.outcome === 'transient'
          ? { outcome: 'transient', provider: report.reasonCode?.startsWith('provider_') === true }
          : { outcome: report.outcome }
    const result = await this.endRun(report.leaseId, end, report.reasonCode ?? null, {
      fence: {
        daemonId,
        daemonEpoch: BigInt(epoch),
        cardId: report.cardId,
        boardId: report.boardId,
        agentId: report.agentId,
        attempt: report.attempt,
        dispatchRevision: BigInt(report.dispatchRevision)
      },
      ...(report.sessionId ? { sessionId: report.sessionId } : {}),
      ...(report.prNumber !== undefined ? { prNumber: report.prNumber } : {})
    })
    if (!result.accepted) {
      // The transition committed and the ack was lost, or the CP restarted. Replay does not write again.
      if (await this.deps.repo.isIdempotentReport(daemonId, report)) return { leaseId: report.leaseId, accepted: true }
      return { leaseId: report.leaseId, accepted: false, reason: 'superseded' }
    }
    this.deps.log.info(
      { leaseId: report.leaseId, outcome: report.outcome, to: result.card.to, tripped: result.plan.tripped },
      'kanban: run reported'
    )
    // The slot is free again.
    this.poke(result.card.boardId)
    return { leaseId: report.leaseId, accepted: true }
  }

  private async dispatchLease(lease: KanbanClaimedLease): Promise<void> {
    const repo = await this.repoRef(lease)
    if (!repo) {
      await this.endRun(lease.leaseId, { outcome: 'transient' }, 'github_installation_unavailable')
      return
    }
    let observed: CardIssue | null
    try {
      observed = await this.deps.store.readCard(repo, lease.issueNumber)
    } catch (err) {
      this.deps.log.warn({ err, leaseId: lease.leaseId }, 'kanban: card read failed before dispatch')
      await this.endRun(lease.leaseId, { outcome: 'transient' }, 'github_read_failed')
      return
    }
    // Preserve human changes in GitHub and release the DB card into its observed status; promotion residue is ready.
    if (!observed || !(isDispatchableIssue(observed) || isPromotionResidue(observed))) {
      await this.deps.repo.endRun({
        leaseId: lease.leaseId,
        outcome: 'transient',
        reasonCode: 'github_state_mismatch',
        now: await this.deps.repo.now(),
        plan: (card) => ({
          ...card,
          status: observedCardStatus(observed),
          cooldownUntil: null,
          blockKind: null,
          countsAsFailure: false
        })
      })
      return
    }
    const mode = lease.mode
    if (!(await this.deps.repo.isCurrentLease(lease.leaseId, mode, lease.daemonEpoch))) return
    let reply: KanbanDispatchOk
    try {
      reply = await this.deps.send(lease.daemonId, {
        boardId: lease.boardId,
        cardId: lease.cardId,
        agentId: lease.agentId,
        repoId: lease.repoId.toString(),
        repoFullName: lease.repoFullName,
        issueNumber: lease.issueNumber,
        leaseId: lease.leaseId,
        attempt: lease.attempt,
        dispatchRevision: lease.dispatchRevision.toString(),
        sessionKeyPrefix: lease.sessionKeyPrefix,
        mode
      })
    } catch (err) {
      // Nack or timeout → ready with a cooldown; if the daemon did start, the fence rejects that run's writes.
      this.deps.log.warn({ err, leaseId: lease.leaseId }, 'kanban: dispatch failed')
      await this.endRun(lease.leaseId, { outcome: 'transient' }, 'dispatch_failed')
      return
    }
    if (!reply.accepted) {
      const end: KanbanRunEnd = CAPABILITY_REFUSALS.has(reply.reason)
        ? { outcome: 'blocked', blockKind: 'capability' }
        : { outcome: 'transient' }
      this.deps.log.info({ leaseId: lease.leaseId, reason: reply.reason }, 'kanban: dispatch refused')
      await this.endRun(lease.leaseId, end, `dispatch_refused:${reply.reason}`)
      return
    }
    if (!(await this.deps.repo.markAcked(lease.leaseId, mode, await this.deps.repo.now(), lease.daemonEpoch))) return
    this.writeStatus(lease, repo, 'running', observed)
  }

  private async endRun(
    leaseId: string,
    end: KanbanRunEnd,
    reasonCode: string | null,
    extra: Pick<Parameters<KanbanDispatchRepo['endRun']>[0], 'fence' | 'sessionId' | 'prNumber' | 'reclaimIf'> = {}
  ): Promise<KanbanRunEndResult> {
    const now = await this.deps.repo.now()
    const outcome: KanbanRunOutcomeValue = end.outcome
    const result = await this.deps.repo.endRun({
      leaseId,
      outcome,
      reasonCode,
      now,
      ...extra,
      ...(end.outcome === 'blocked' ? { reportedBlockKind: end.blockKind } : {}),
      plan: (card, board, ctx) => planRunEnd(card, board, end, now, ctx)
    })
    if (result.accepted && result.card.from !== result.card.to) {
      const repo = await this.repoRef(result.card)
      if (repo) this.writeStatus(result.card, repo, result.card.to)
    }
    return result
  }

  /** Best-effort label write after the CP state committed; a failure leaves drift for the reconciler to repair. */
  private writeStatus(
    card: { issueNumber: number; cardId: string },
    repo: KanbanRepoRef,
    status: KanbanStatus,
    observed?: ObservedIssue
  ): void {
    const task = (this.statusWrites.get(card.cardId) ?? Promise.resolve())
      .then(async () => {
        const current = observed ?? (await this.deps.store.readCard(repo, card.issueNumber))
        if (!current) return
        await this.deps.store.applyPlan(repo, card.issueNumber, current, planStatusWrite(status, current))
      })
      .catch((err: unknown) =>
        this.deps.log.warn({ err, cardId: card.cardId, status }, 'kanban: status label write failed')
      )
      .finally(() => {
        this.background.delete(task)
        if (this.statusWrites.get(card.cardId) === task) this.statusWrites.delete(card.cardId)
      })
    this.statusWrites.set(card.cardId, task)
    this.background.add(task)
  }

  private async boardRepoRef(boardId: string): Promise<KanbanRepoRef | null> {
    const ref = await this.deps.repo.getBoardRef(boardId)
    return ref ? this.repoRef(ref) : null
  }

  /** The installation is resolved live from the board's org and repo owner, never trusted from a frame. */
  private async repoRef(board: KanbanBoardRef): Promise<KanbanRepoRef | null> {
    const owner = board.repoFullName.split('/', 1)[0]
    if (!owner) return null
    const installation = await this.deps.installations.liveByOrgAndAccount(board.orgId, owner)
    if (!installation || installation.revokedAt || installation.suspendedAt) return null
    return { installationId: installation.installationId, repoId: board.repoId, repoFullName: board.repoFullName }
  }

  private arm(): void {
    if (this.stopped) return
    this.timer = this.deps.clock.setTimeout(() => {
      void this.tick()
        .catch((err: unknown) => this.deps.log.warn({ err }, 'kanban: reconciler tick failed'))
        .finally(() => this.arm())
    }, this.deps.tickMs ?? DEFAULT_TICK_MS)
  }
}
