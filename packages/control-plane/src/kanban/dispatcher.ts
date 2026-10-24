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
  KanbanRunOutcomeValue,
  KanbanSelfVerifyFlag
} from '../persistence/ports.js'
import {
  isStatusLabel,
  statusLabel,
  isDispatchableIssue,
  isPromotionResidue,
  isReviewDispatchableIssue,
  observedCardStatus,
  parseStatusLabels,
  planRecovery,
  planStatusWrite,
  type KanbanStatus,
  type LabelPlan,
  type ObservedIssue
} from './card-state.js'
import type { CardIssue, CardStore, KanbanRepoRef } from './card-store.js'
import type { KanbanProjectHook } from './project-writer.js'
import type { KanbanSync } from './sync.js'
import type { KanbanIssueDoorbell } from './graph-doorbell.js'
import { planGraphPromotion } from './graph-reconciler.js'
import type { RepoPermissionLookup } from '../github/repo-permission.js'
import { authorizeHumanKanbanAction } from './human-action.js'
import { labelAdder } from './label-attribution.js'
import { planRunEnd, staleLeaseReason, type KanbanRunEnd } from './run-accounting.js'
import { isSupersededCardPr } from './controls.js'
import type { PrReader } from './pr-reader.js'

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
  /** PR completion contracts: the tick's sweep, and a run end's re-check in review or after a move out of it to ready/triage. */
  contracts?: {
    sweep(boardId: string): Promise<void>
    onReview(cardId: string): Promise<unknown>
    onLeftReview?(cardId: string): Promise<unknown>
  }
  /** The read-only PR reader: a write run's claim re-validates the card branch's open PR, which a restart may have dropped. */
  prs?: Pick<PrReader, 'listOpenPullRequestsByHead'>
  /** The daemon's live control connection; throws when it is gone. */
  send(daemonId: string, d: KanbanDispatch): Promise<KanbanDispatchOk>
  isDaemonLive(daemonId: string): boolean
  clock: Clock
  log: KanbanDispatcherLog
  // Post-commit Projects writes run on their own per-card queue.
  project?: Pick<KanbanProjectHook, 'onStatusCommitted'>
  // Drain the notification outbox written inside each transition transaction.
  notify?: { drain(): Promise<void> }
  /** Reconciler period when no doorbell rings (design §4: 60s). */
  sync?: Pick<KanbanSync, 'onCardChanged' | 'reconcileBoard' | 'projectStatus'>
  tickMs?: number
  unackedGraceMs?: number
  epochGraceMs?: number
  /** Per-daemon open-run cap across all boards (audit 2.2). */
  maxPerDaemon?: number
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
/** A pending run-end contract re-check holds its card's claim at most this long; its GitHub reads time out far sooner. */
export const RECHECK_HOLD_MS = 5 * 60_000

type RunEndCard = Pick<Extract<KanbanRunEndResult, { accepted: true }>['card'], 'cardId' | 'boardId' | 'from' | 'to'>
/** A run end's contract re-check, holding its card's claim in this process from before the end's commit until it settles. */
interface RecheckHold {
  card: RunEndCard
  leftReview: boolean
  since: number
}

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

/** Body-free comment for a self-approval guard (B8): the verifier is the worker, so review can never run. */
export function verifierIsWorkerComment(): string {
  return (
    'AgentConnect Kanban: this card is in review, but its configured verifier agent is also its worker, so it ' +
    'cannot review its own work. Configure a different verifier agent on the board, then move the card to another ' +
    'status (for example ready) to release it.'
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
  private readonly rechecks = new Map<string, RecheckHold>()
  private readonly recheckSkipped = new Set<string>()

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
    void this.deps.notify?.drain().catch(() => undefined)
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
    await this.deps.notify?.drain().catch(() => undefined)
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
    if (this.recoveryDue.delete(boardId)) {
      await this.recoverMismatches(boardId)
      await this.deps.sync?.reconcileBoard(boardId)
      await this.deps.contracts
        ?.sweep(boardId)
        .catch((err: unknown) => this.deps.log.warn({ err, boardId }, 'kanban: contract sweep failed'))
    }
    const result = await this.deps.repo.claim(boardId, {
      now: await this.deps.repo.now(),
      isDaemonLive: (id) => this.deps.isDaemonLive(id),
      skipCard: (cardId) => this.recheckHolds(cardId),
      ...(this.deps.maxPerDaemon !== undefined ? { maxPerDaemon: this.deps.maxPerDaemon } : {})
    })
    await Promise.allSettled([
      ...result.leases.map((lease) => this.dispatchLease(lease)),
      ...result.flaggedSelfVerify.map((card) => this.commentSelfVerify(card))
    ])
  }

  private async recoverMismatches(boardId: string): Promise<void> {
    const now = await this.deps.repo.now()
    for (const card of await this.deps.repo.listRecoveryDue(
      boardId,
      now,
      RECOVERY_BATCH,
      ...(this.deps.sync ? ([true] as const) : [])
    )) {
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
  async onCardChanged(
    boardId: string,
    issueNumber: number,
    source: 'human' | 'graph' = 'graph',
    doorbell?: KanbanIssueDoorbell
  ): Promise<boolean> {
    const pending = await this.deps.repo.getPendingPromotion(boardId, issueNumber)
    if (pending && source !== 'human') {
      const now = await this.deps.repo.now()
      if (pending.recoveryCheckAt && pending.recoveryCheckAt.getTime() > now.getTime()) return false
    } else {
      await this.deps.repo.resetRecovery(boardId, issueNumber)
    }
    if (!pending)
      return this.deps.sync
        ? this.deps.sync.onCardChanged(boardId, issueNumber, source === 'human', doorbell)
        : this.ingestCard(boardId, issueNumber)
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
    return this.deps.sync
      ? this.deps.sync.onCardChanged(boardId, issueNumber)
      : (await this.ingest(boardId, issueNumber)).moved
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
    const result = await this.deps.repo.ingestStatus(boardId, issueNumber, from, plan.to)
    if (result.moved) {
      this.projectCommitted(boardId, issueNumber, issue)
      void this.deps.notify?.drain().catch(() => undefined)
    }
    return { moved: result.moved, observed }
  }

  // The human who added the status label must hold live write access, as a comment command's sender must; fail closed.
  private async labelWriterAuthorized(repo: KanbanRepoRef, issueNumber: number, to: KanbanStatus): Promise<boolean> {
    const authz = this.deps.humanAuthz
    if (!authz) return false
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
      this.projectCommitted(boardId, card.issueNumber, issue)
      // Residue is dispatchable as is, and the running write clears both labels.
      this.deps.log.info({ boardId, issueNumber: card.issueNumber }, 'kanban: adopted a half-landed graph promotion')
      return { moved: true }
    }
    if (outcome === 'clear') {
      // An unacknowledged POST may still land, so no ready label only clears once its watch has passed.
      if (watching(card, now)) return { moved: false, observed }
      if (await this.deps.repo.settlePromotion(card.cardId, false))
        this.projectCommitted(boardId, card.issueNumber, issue)
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
    this.projectCommitted(boardId, issueNumber, issue)
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
    // Our own label write for the move that made this card claimable (running→review, review→ready) may still be in
    // flight; reading before it lands would see the previous status and park a valid claim as a GitHub mismatch.
    await this.statusWrites.get(lease.cardId)
    let observed: CardIssue | null
    try {
      observed = await this.deps.store.readCard(repo, lease.issueNumber)
    } catch (err) {
      this.deps.log.warn({ err, leaseId: lease.leaseId }, 'kanban: card read failed before dispatch')
      await this.endRun(lease.leaseId, { outcome: 'transient' }, 'github_read_failed')
      return
    }
    // Preserve human changes in GitHub and release the DB card into its observed status; promotion residue is ready.
    const dispatchable = (o: ObservedIssue): boolean =>
      lease.role === 'verify' ? isReviewDispatchableIssue(o) : isDispatchableIssue(o) || isPromotionResidue(o)
    if (!observed || !dispatchable(observed)) {
      const released = await this.deps.repo.endRun({
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
      if (released.accepted && released.card.from !== released.card.to) {
        this.projectCommitted(lease.boardId, lease.issueNumber, observed)
      }
      return
    }
    let supersededPrNumber = lease.supersededPrNumber
    if (lease.staleCardPrBefore && this.deps.prs) {
      try {
        supersededPrNumber = await this.staleCardPr(repo, lease.issueNumber, lease.staleCardPrBefore)
      } catch (err) {
        // Dispatching without the close target would strand the card at pr_unbound, so a failed read retries like the card read.
        this.deps.log.warn({ err, leaseId: lease.leaseId }, 'kanban: card-branch PR lookup failed before dispatch')
        await this.endRun(lease.leaseId, { outcome: 'transient' }, 'github_read_failed')
        return
      }
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
        mode,
        // Absent = work, so a verify role is the only addition and older daemons still read the frame.
        ...(lease.role === 'verify' ? { role: 'verify' as const } : {}),
        ...(supersededPrNumber !== undefined ? { supersededPrNumber } : {})
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
    // A verify run keeps the card in `review`; only a work run writes the `running` label.
    if (lease.role !== 'verify') this.writeStatus(lease, repo, 'running', observed)
  }

  // The one open card-branch PR of this repo created before the episode: it can never bind and blocks a new PR from the branch.
  private async staleCardPr(repo: KanbanRepoRef, issueNumber: number, before: Date): Promise<number | undefined> {
    const open = await this.deps.prs!.listOpenPullRequestsByHead(repo, `ac/card-${issueNumber}`)
    const stale = open.filter(
      (pr) =>
        isSupersededCardPr(pr, { prNumber: pr.number, issueNumber, repoId: repo.repoId }) &&
        pr.createdAt !== null &&
        pr.createdAt.getTime() < before.getTime()
    )
    if (stale.length > 1)
      this.deps.log.info({ issueNumber, count: stale.length }, 'kanban: several stale card-branch PRs; none named')
    return stale.length === 1 ? stale[0]!.number : undefined
  }

  /** B8 self-approval: post the one body-free comment for a newly flagged card; best-effort like the escalation comment. */
  private async commentSelfVerify(card: KanbanSelfVerifyFlag): Promise<void> {
    try {
      const repo = await this.repoRef(card)
      if (!repo) return
      const issue = await this.deps.store.readCard(repo, card.issueNumber)
      const plan: LabelPlan = {
        outcome: 'noop',
        status: 'review',
        releaseLease: false,
        addLabels: [],
        removeLabels: [],
        comment: verifierIsWorkerComment()
      }
      await this.deps.store.applyPlan(repo, card.issueNumber, issue ?? { labels: [], state: 'open' }, plan)
    } catch (err) {
      this.deps.log.warn(
        { err, cardId: card.cardId, issueNumber: card.issueNumber },
        'kanban: verifier_is_worker comment failed'
      )
    }
  }

  private async endRun(
    leaseId: string,
    end: KanbanRunEnd,
    reasonCode: string | null,
    extra: Pick<Parameters<KanbanDispatchRepo['endRun']>[0], 'fence' | 'sessionId' | 'prNumber' | 'reclaimIf'> = {}
  ): Promise<KanbanRunEndResult> {
    const now = await this.deps.repo.now()
    const outcome: KanbanRunOutcomeValue = end.outcome
    let held: RecheckHold | undefined
    let result: KanbanRunEndResult
    try {
      result = await this.deps.repo.endRun({
        leaseId,
        outcome,
        reasonCode,
        now,
        ...extra,
        ...(end.outcome === 'blocked' ? { reportedBlockKind: end.blockKind } : {}),
        plan: (card, board, ctx) => planRunEnd(card, board, end, now, ctx),
        // Held under the card's row lock, before the commit makes it claimable, so no claim here can take it first (#602).
        beforeCommit: (card) => {
          if (held) this.releaseHold(held)
          held = this.holdForRecheck(card)
        }
      })
    } catch (err) {
      if (held) this.releaseHold(held)
      throw err
    }
    if (!result.accepted) {
      if (held) this.releaseHold(held)
      return result
    }
    const { card } = result
    // A verifier's approval, or a worker whose PR already finished, completes the contract now rather than on the next event.
    // A repo that never called beforeCommit (a test double) still gets its hold here, after the commit.
    const recheck = this.recheckContract(card, held ?? this.holdForRecheck(card))
    if (card.from !== card.to) {
      const repo = await this.repoRef(card)
      // The status write also waits for the re-check, so its own ack never frees the card ahead of the flag (#602).
      if (repo) this.writeStatus(card, repo, card.to, undefined, recheck)
    }
    return result
  }

  // In review, or moved from review to ready/triage, where a verdict must not carry an unbound PR back to work unflagged.
  private holdForRecheck(card: RunEndCard): RecheckHold | undefined {
    const contracts = this.deps.contracts
    if (!contracts) return undefined
    const leftReview = card.from === 'review' && (card.to === 'ready' || card.to === 'triage')
    if (card.to !== 'review' && !(leftReview && contracts.onLeftReview)) return undefined
    const hold: RecheckHold = { card, leftReview, since: this.deps.clock.now() }
    this.rechecks.set(card.cardId, hold)
    return hold
  }

  private recheckContract(card: RunEndCard, hold: RecheckHold | undefined): Promise<unknown> | undefined {
    if (!hold) return undefined
    const contracts = this.deps.contracts!
    const { cardId } = card
    const task: Promise<unknown> = (hold.leftReview ? contracts.onLeftReview!(cardId) : contracts.onReview(cardId))
      .catch((err: unknown) => this.deps.log.warn({ err, cardId }, 'kanban: contract re-check failed'))
      .finally(() => {
        this.background.delete(task)
        this.releaseHold(hold)
      })
    this.background.add(task)
    return task
  }

  private releaseHold(hold: RecheckHold): void {
    const { cardId, boardId } = hold.card
    if (this.rechecks.get(cardId) === hold) this.rechecks.delete(cardId)
    // A claim skipped the card while it was held: retry it now rather than on the next event.
    if (this.recheckSkipped.delete(cardId)) this.poke(boardId)
  }

  private recheckHolds(cardId: string): boolean {
    const hold = this.rechecks.get(cardId)
    if (!hold || this.deps.clock.now() - hold.since >= RECHECK_HOLD_MS) return false
    this.recheckSkipped.add(cardId)
    return true
  }

  /** Best-effort label write after the CP state committed, once `after` settles; a failure leaves drift for the reconciler. */
  private writeStatus(
    card: { issueNumber: number; cardId: string; boardId: string },
    repo: KanbanRepoRef,
    status: KanbanStatus,
    observed?: ObservedIssue,
    after?: Promise<unknown>
  ): void {
    this.projectCommitted(card.boardId, card.issueNumber, observed)
    if (this.deps.sync) {
      // The sync projects the card's live status, so a contract settle during `after` is written, not overwritten.
      const task = Promise.resolve(after)
        .then(() => this.deps.sync!.projectStatus(card.boardId, card.issueNumber, status))
        .then(() => this.poke(card.boardId))
        .catch((err: unknown) => this.deps.log.warn({ err, cardId: card.cardId }, 'kanban: status projection failed'))
        .finally(() => this.background.delete(task))
      this.background.add(task)
      return
    }
    if (!after) return this.queueStatusWrite(card, repo, status, observed)
    // Queued once `after` settles, as a contract settle inside it holds this queue; a settle writes its own status.
    const deferred = after
      .then((outcome) => {
        if (outcome !== 'done' && outcome !== 'triage') this.queueStatusWrite(card, repo, status, observed)
      })
      .finally(() => this.background.delete(deferred))
    this.background.add(deferred)
  }

  private queueStatusWrite(
    card: { issueNumber: number; cardId: string; boardId: string },
    repo: KanbanRepoRef,
    status: KanbanStatus,
    observed?: ObservedIssue
  ): void {
    const task = (this.statusWrites.get(card.cardId) ?? Promise.resolve())
      .then(async () => {
        const current = observed ?? (await this.deps.store.readCard(repo, card.issueNumber))
        if (!current) return
        await this.deps.store.applyPlan(repo, card.issueNumber, current, planStatusWrite(status, current))
        // Without a sync no ack ever clears the owed write, and the claim skips a card that still owes one.
        await this.deps.repo.markStatusWritten(card.cardId, status)
        this.poke(card.boardId)
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

  /** Hold the card's status-write queue for an outside post-commit GitHub write; a claim reads GitHub only once `release` has run it. */
  holdStatusWrite(cardId: string): (write?: () => Promise<void>) => Promise<void> {
    let open!: (write: (() => Promise<void>) | undefined) => void
    const held = new Promise<(() => Promise<void>) | undefined>((resolve) => (open = resolve))
    const task = (this.statusWrites.get(cardId) ?? Promise.resolve())
      .then(() => held)
      .then((write) => write?.())
      .catch((err: unknown) => this.deps.log.warn({ err, cardId }, 'kanban: held status write failed'))
      .finally(() => {
        this.background.delete(task)
        if (this.statusWrites.get(cardId) === task) this.statusWrites.delete(cardId)
      })
    this.statusWrites.set(cardId, task)
    this.background.add(task)
    return (write) => {
      open(write)
      return task
    }
  }

  /** The board's repository with its installation resolved live; null when the board or installation is gone. */
  boardRepo(boardId: string): Promise<KanbanRepoRef | null> {
    return this.boardRepoRef(boardId)
  }

  /** Post-commit Projects v2 seam: queued apart from label writes, and a faulty hook can never fail the transition. */
  private projectCommitted(boardId: string, issueNumber: number, observed?: ObservedIssue | null): void {
    const issueNodeId = observed && 'nodeId' in observed && typeof observed.nodeId === 'string' ? observed.nodeId : null
    try {
      this.deps.project?.onStatusCommitted({ boardId, issueNumber, ...(issueNodeId ? { issueNodeId } : {}) })
    } catch {
      this.deps.log.warn({ boardId, issueNumber, reason: 'project_hook_failed' }, 'kanban: projection hook failed')
    }
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
