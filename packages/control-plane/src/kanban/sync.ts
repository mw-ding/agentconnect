// Human edits are attributed from GitHub events; periodic repair projects committed state after failed label writes.
import type { KanbanCardRepo, KanbanLeaseRef } from '../persistence/ports.js'
import {
  isAppActor,
  isHumanActor,
  latestManagedEdits,
  KanbanEventHistoryBoundError,
  type CardStore,
  type KanbanRepoRef,
  type LabelEvent
} from './card-store.js'
import { checkWriteAccess, type RepoPermissionLookup } from '../github/repo-permission.js'
import { AGENT_LABEL_PREFIX, parseAgentLabel, agentLabel } from './agent-label.js'
import {
  attributeLabel,
  doorbellAddVisible,
  doorbellSuperseded,
  judgeLabelAdd,
  type DoorbellSender,
  type LabelAttribution,
  type LabelVerdict
} from './label-attribution.js'
import type { KanbanIssueDoorbell } from './graph-doorbell.js'
import { liveManagedLabels, replayManagedLabels, setsEqual } from './label-sync.js'
import {
  permissionRefusalComment,
  planLabelReconcile,
  planStatusWrite,
  parseStatusLabels,
  isStatusLabel,
  statusLabel,
  type KanbanStatus,
  type LabelPlan
} from './card-state.js'
import { planReassign } from './reassign.js'

export interface SyncCard {
  id: string
  boardId: string
  orgId: string
  issueNumber: number
  status: KanbanStatus
  stateRevision: bigint
  dispatchRevision: bigint
  assigneeAgentId: string | null
  assigneeName?: string | null
  promotionPending: boolean
  labelWritePending: boolean
  syncEventCursor: bigint
  syncAgentCursor: bigint
  syncDeferredAt: Date | null
  syncDeferralCount: number
  needsAttention: boolean
  lease: KanbanLeaseRef | null
}

/** The GitHub actor of a label-driven edit, body-free: a login and optional numeric id, never anything else. */
export interface GitHubActor {
  login: string
  id?: number
}

export interface KanbanSyncRepo {
  get(boardId: string, issueNumber: number): Promise<SyncCard | null>
  list(boardId: string, limit: number): Promise<number[]>
  apply(
    card: SyncCard,
    plan: LabelPlan,
    cursor: bigint,
    human: boolean,
    agentCursor: bigint,
    actor?: GitHubActor
  ): Promise<{ changed: boolean; revoked: KanbanLeaseRef | null } | null>
  ack(card: SyncCard, cursor: bigint, agentCursor?: bigint): Promise<boolean>
  /** Record one deferred pass; returns the refreshed card, or null when the card vanished. */
  defer(card: SyncCard, now: Date): Promise<SyncCard | null>
  /** Fail a card closed: ready/running moves to triage (revoking its lease), it is flagged for a human, the bound clears. */
  failClosed(card: SyncCard): Promise<{ status: KanbanStatus; revoked: KanbanLeaseRef | null } | null>
}

export interface KanbanSyncDeps {
  repo: KanbanSyncRepo
  cards: Pick<KanbanCardRepo, 'resolveAgentSlug' | 'setAssignee'>
  store: Pick<CardStore, 'readCard' | 'applyPlan' | 'readLabelEvents'>
  /** Live lookup with caching off (`ttlMs: 0`): a revoked write grant must stop moving cards on the next edit. */
  permissions: RepoPermissionLookup
  /** The deployment App slug; its bot is the actor of every CP and agent write, since agents only hold App tokens. */
  appSlug?: string
  repoRef(boardId: string): Promise<KanbanRepoRef | null>
  revoke(lease: KanbanLeaseRef, cardId: string): Promise<void>
  promote(boardId: string, repo: KanbanRepoRef, issueNumber: number): Promise<void>
  log: { warn(obj: unknown, message: string): void }
  now?: () => Date
}

const BATCH = 25
/** How long an unattributed edit may stay deferred (from its first deferral) before it fails closed. */
const DEFERRAL_TIMEOUT_MS = 10 * 60_000
/** Fresh-read passes one reconcile may run while a reassignment keeps changing the card under it. */
const MAX_ROUNDS = 3

type EditVerdict = 'accept' | 'refuse' | 'revert' | 'ignore'
/** A verdict and the GitHub actor whose own event was judged for it, for the audit row. */
type Judged = { verdict: EditVerdict; actor?: GitHubActor }
type StatusJudgement = { verdict: EditVerdict | 'pending'; actor?: GitHubActor }

// Exactly undoes one refused `ac/agent:*` label edit against the labels the issue carries now.
function undoLabelEdit(event: NonNullable<LabelEvent>, labels: readonly string[]): { add: string[]; remove: string[] } {
  const name = event.label?.name
  if (!name) return { add: [], remove: [] }
  const present = labels.includes(name)
  if (event.event === 'labeled' && present) return { add: [], remove: [name] }
  if (event.event === 'unlabeled' && !present) return { add: [name], remove: [] }
  return { add: [], remove: [] }
}

export class KanbanSync {
  private readonly running = new Map<string, Promise<boolean>>()

  constructor(private readonly deps: KanbanSyncDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date()
  }

  // The database orders by oldest completed check so every card, including terminal cards, eventually gets a turn.
  async reconcileBoard(boardId: string): Promise<void> {
    for (const issueNumber of await this.deps.repo.list(boardId, BATCH)) {
      try {
        await this.onCardChanged(boardId, issueNumber)
      } catch (err) {
        this.deps.log.warn({ err, boardId, issueNumber }, 'kanban: drift repair failed')
      }
    }
  }

  // One card's passes are serialized: the reconciler tick, the human doorbell, and a CP projection never interleave.
  private enqueue(boardId: string, issueNumber: number, run: () => Promise<boolean>): Promise<boolean> {
    const key = `${boardId}:${issueNumber}`
    const previous = this.running.get(key) ?? Promise.resolve(false)
    const queued = previous.catch(() => false).then(run)
    this.running.set(key, queued)
    void queued
      .finally(() => {
        if (this.running.get(key) === queued) this.running.delete(key)
      })
      .catch(() => {})
    return queued
  }

  onCardChanged(
    boardId: string,
    issueNumber: number,
    humanDoorbell = false,
    doorbell?: KanbanIssueDoorbell
  ): Promise<boolean> {
    return this.enqueue(boardId, issueNumber, () => this.reconcile(boardId, issueNumber, humanDoorbell, doorbell))
  }

  // The dispatcher just committed a CP transition; project it through the same queue as a full reconcile, so a
  // human edit never gets acked without being processed and cursors only advance past the App's own writes.
  async projectStatus(boardId: string, issueNumber: number, _status: KanbanStatus): Promise<void> {
    await this.enqueue(boardId, issueNumber, () => this.reconcile(boardId, issueNumber, false))
  }

  // A human editor needs live write access, failing closed; bots, Apps, and unknown actors are ignored without a lookup.
  private async writeAccess(
    repo: KanbanRepoRef,
    login: string,
    writers: Map<string, Promise<boolean>>
  ): Promise<boolean> {
    const id = login.toLowerCase()
    let write = writers.get(id)
    if (!write) {
      write = checkWriteAccess(this.deps.permissions, repo, id).then((access) => {
        if (access.error)
          this.deps.log.warn({ err: access.error, repoId: repo.repoId }, 'kanban: permission lookup failed')
        return access.write
      })
      writers.set(id, write)
    }
    return write
  }

  private async judgeEvent(
    repo: KanbanRepoRef,
    event: LabelEvent,
    writers: Map<string, Promise<boolean>>
  ): Promise<EditVerdict> {
    if (isAppActor(event, this.deps.appSlug) || !isHumanActor(event)) return 'ignore'
    return (await this.writeAccess(repo, event.actor!.login!, writers)) ? 'accept' : 'refuse'
  }

  // One label's add, judged on its own adder: a live human writer accepts, any other human refuses, a bot is ignored.
  private async judgeAdd(
    attribution: LabelAttribution,
    repo: KanbanRepoRef,
    writers: Map<string, Promise<boolean>>
  ): Promise<Judged> {
    const verdict = await judgeLabelAdd(attribution, {
      repo,
      permissions: this.deps.permissions,
      appSlug: this.deps.appSlug,
      writers,
      warn: (err, repoId) => this.deps.log.warn({ err, repoId }, 'kanban: permission lookup failed')
    })
    const actor = attribution.kind === 'add' ? actorFrom(attribution.event) : undefined
    return { verdict: labelVerdictToEdit(verdict), ...(actor ? { actor } : {}) }
  }

  // The verdict for the status sync would adopt, with the actor it judged; events at or below `consumed` were handled.
  private async statusVerdict(opts: {
    card: SyncCard
    edits: { status: LabelEvent | null }
    issue: { labels: readonly string[]; state: 'open' | 'closed' }
    events: readonly LabelEvent[]
    repo: KanbanRepoRef
    writers: Map<string, Promise<boolean>>
    humanDoorbell: boolean
    consumed: bigint
  }): Promise<StatusJudgement> {
    const { card, edits, issue, events, repo, writers, humanDoorbell, consumed } = opts
    const ignore: StatusJudgement = { verdict: 'ignore' }
    const statusEvent = edits.status
    const requested = planLabelReconcile({ status: card.status, leased: card.lease !== null }, issue).requested
    // A fresh human edit while the CP's own label write is pending defers rather than being projected over and acked.
    const pending = (event: LabelEvent) =>
      !humanDoorbell &&
      !card.needsAttention &&
      card.labelWritePending &&
      isHumanActor(event) &&
      !isAppActor(event, this.deps.appSlug)
    if (statusEvent?.event === 'closed' || statusEvent?.event === 'reopened') {
      if (BigInt(statusEvent.id) <= consumed) return ignore
      const verdict = await this.judgeEvent(repo, statusEvent, writers)
      const actor = actorFrom(statusEvent)
      const own: StatusJudgement = { verdict, ...(actor ? { actor } : {}) }
      if (verdict !== 'accept' || statusEvent.event === 'closed' || requested === undefined) return own
      // A reopen adopts the live status label too, so that label is judged on its own add, never on the reopener's verdict.
      const attribution = attributeLabel(events, statusLabel(requested))
      if (attribution.kind !== 'add') return { verdict: 'pending' }
      const label = await this.judgeAdd(attribution, repo, writers)
      return label.verdict === 'accept' ? own : label
    }
    if (requested === undefined) {
      // The card already matches the live status, but a non-writer's later remove+re-add can still re-author that
      // label. A dispatchable card (ready/running) whose current status label is no longer writer-attributed reverts.
      if (card.status !== 'ready' && card.status !== 'running') return ignore
      const current = attributeLabel(events, statusLabel(card.status))
      if (current.kind !== 'add' || BigInt(current.event.id) <= consumed) return ignore
      if (pending(current.event)) return { verdict: 'pending' }
      if (!humanDoorbell && !card.needsAttention && card.labelWritePending) return ignore
      const judged = await this.judgeAdd(current, repo, writers)
      return judged.verdict === 'refuse' ? { ...judged, verdict: 'revert' } : ignore
    }
    const attribution = attributeLabel(events, statusLabel(requested))
    if (attribution.kind !== 'add') return { verdict: 'pending' }
    if (BigInt(attribution.event.id) <= consumed) return ignore
    // A failed CP status write leaves the replaced label live; a tick projects the committed status, not that old label.
    if (pending(attribution.event)) return { verdict: 'pending' }
    if (!humanDoorbell && !card.needsAttention && card.labelWritePending) return ignore
    return this.judgeAdd(attribution, repo, writers)
  }

  // The verdict for an ac/agent change: an add is judged on the label it produced; an unassign on the removal.
  private async agentVerdict(
    repo: KanbanRepoRef,
    parsed: ReturnType<typeof parseAgentLabel>,
    assigneeEvent: LabelEvent,
    events: readonly LabelEvent[],
    writers: Map<string, Promise<boolean>>
  ): Promise<EditVerdict> {
    if (parsed.kind === 'agent') {
      return (await this.judgeAdd(attributeLabel(events, agentLabel(parsed.slug)), repo, writers)).verdict
    }
    return this.judgeEvent(repo, assigneeEvent, writers)
  }

  // A `labeled` doorbell's own add must be the latest visible event for its live label before an older visible add may
  // attribute that label: a non-writer re-adding a dispatchable card's status label is refused now, any other lag defers.
  private async doorbellLag(
    card: SyncCard,
    issue: { labels: readonly string[] },
    events: readonly LabelEvent[],
    repo: KanbanRepoRef,
    writers: Map<string, Promise<boolean>>,
    doorbell: KanbanIssueDoorbell | undefined
  ): Promise<'none' | 'defer' | 'refuse'> {
    const sender = doorbell?.sender
    const label = doorbell?.label
    if (doorbell?.action !== 'labeled' || !sender || !label) return 'none'
    if (!isStatusLabel(label) && !label.toLowerCase().startsWith(AGENT_LABEL_PREFIX)) return 'none'
    if (!issue.labels.some((name) => name.toLowerCase() === label.toLowerCase())) return 'none'
    if (doorbellAddVisible(events, label, sender)) return 'none'
    // A late or redelivered doorbell is older than the label's newest visible event, which the normal path judges.
    if (doorbellSuperseded(events, label, doorbell.at)) return 'none'
    if (await this.writeAccess(repo, sender.login, writers)) return 'defer'
    const dispatchable = card.status === 'ready' || card.status === 'running'
    return dispatchable && label.toLowerCase() === statusLabel(card.status) ? 'refuse' : 'defer'
  }

  // A reassignment changes the card under the pass, so it re-runs from a fresh read with both verdicts recomputed.
  private async reconcile(
    boardId: string,
    issueNumber: number,
    humanDoorbell: boolean,
    doorbell?: KanbanIssueDoorbell
  ): Promise<boolean> {
    const writers = new Map<string, Promise<boolean>>()
    let changed = false
    let consumed = 0n
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const pass = await this.pass(boardId, issueNumber, humanDoorbell, round === 0 ? doorbell : undefined, {
        writers,
        consumed
      })
      changed ||= pass.changed
      if (pass.rerun === undefined) return changed
      consumed = pass.rerun
    }
    // Still being reassigned after the bound: nothing past the last judged snapshot was acked, so the next pass resumes.
    return changed
  }

  private async pass(
    boardId: string,
    issueNumber: number,
    humanDoorbell: boolean,
    doorbell: KanbanIssueDoorbell | undefined,
    round: { writers: Map<string, Promise<boolean>>; consumed: bigint }
  ): Promise<{ changed: boolean; rerun?: bigint }> {
    const { writers } = round
    const done = (changed: boolean) => ({ changed })
    const card = await this.deps.repo.get(boardId, issueNumber)
    if (!card || card.promotionPending) return done(false)
    const repo = await this.deps.repoRef(boardId)
    if (!repo) return done(false)
    const issue = await this.deps.store.readCard(repo, issueNumber)
    if (!issue) return done(false)
    let events: LabelEvent[]
    try {
      // Visible history oldest-first; one past the page bound can attribute nothing, so it defers toward fail-closed.
      events = await this.deps.store.readLabelEvents(repo, issueNumber)
    } catch (err) {
      if (!(err instanceof KanbanEventHistoryBoundError)) throw err
      return done(await this.defer(card, repo, issue, boardId, issueNumber))
    }
    const edits = latestManagedEdits(events)
    const cursor = BigInt(edits.status?.id ?? 0)
    const agentCursor = BigInt(edits.assignee?.id ?? 0)
    // Status events a revoking reassignment already superseded in an earlier round are consumed like acked ones.
    const consumed = card.syncEventCursor > round.consumed ? card.syncEventCursor : round.consumed

    const lag = await this.doorbellLag(card, issue, events, repo, writers, doorbell)
    if (lag === 'defer') return done(await this.defer(card, repo, issue, boardId, issueNumber))
    // The webhook names a non-writer's add the events API does not show yet: revert now, no visible edit is adopted.
    const doorbellRefusal: DoorbellSender | undefined = lag === 'refuse' ? doorbell!.sender : undefined

    // Event lag: the visible events must reproduce the live managed labels, or nothing here can be attributed.
    if (!doorbellRefusal && !setsEqual(replayManagedLabels(events), liveManagedLabels(issue))) {
      return done(await this.defer(card, repo, issue, boardId, issueNumber))
    }

    const parsed = parseAgentLabel(issue.labels)
    const newAgent = !doorbellRefusal && !!edits.assignee && BigInt(edits.assignee.id) > card.syncAgentCursor
    const agentVerdict: EditVerdict = newAgent
      ? await this.agentVerdict(repo, parsed, edits.assignee!, events, writers)
      : 'ignore'
    const status: StatusJudgement = doorbellRefusal
      ? { verdict: 'revert', actor: { login: doorbellRefusal.login, id: doorbellRefusal.id } }
      : await this.statusVerdict({ card, edits, issue, events, repo, writers, humanDoorbell, consumed })
    // An edit that cannot be judged yet is neither reverted nor acked: the pass defers, bounded like event lag.
    if (status.verdict === 'pending') return done(await this.defer(card, repo, issue, boardId, issueNumber))

    // A fail-closed card is human-only: only a fresh, cleanly-attributed human writer edit moves it again.
    if (card.needsAttention && !card.labelWritePending && status.verdict !== 'accept' && agentVerdict !== 'accept')
      return done(false)

    let changed = false
    if (agentVerdict === 'accept') {
      const target =
        parsed.kind === 'agent'
          ? await this.deps.cards.resolveAgentSlug(card.orgId, parsed.slug)
          : parsed.kind === 'none'
            ? null
            : undefined
      // Unknown or ambiguous slugs preserve the current assignee; the current one needs no write.
      if (target !== undefined && (parsed.kind !== 'agent' || target !== null) && target !== card.assigneeAgentId) {
        const actor = agentEditActor(parsed, edits.assignee!, events)
        const result = await this.deps.cards.setAssignee({
          cardId: card.id,
          agentId: target,
          expectedDispatchRevision: card.dispatchRevision,
          onLease: 'revoke',
          now: this.now(),
          source: 'label',
          ...(actor ? { actorLogin: actor.login, actorGitHubId: actor.id } : {})
        })
        if (!result.ok) return done(false)
        changed = result.changed
        if (result.revokedLease) {
          const planned = planReassign(
            {
              cardId: card.id,
              status: card.status,
              dispatchRevision: card.dispatchRevision,
              sessionKey: `github:${repo.repoId}#${issueNumber}`,
              lease: result.revokedLease
            },
            { agentId: target ?? 'unassigned', daemonId: '' },
            {
              fromName: card.assigneeName ?? card.assigneeAgentId ?? 'unassigned',
              toName: parsed.kind === 'agent' ? parsed.slug : 'unassigned'
            }
          )
          await this.deps.revoke(result.revokedLease, card.id)
          const comment = planned.steps.find((step) => step.kind === 'post_comment')
          if (comment?.kind === 'post_comment') {
            await this.deps.store.applyPlan(repo, issueNumber, issue, {
              outcome: 'noop',
              status: result.card.status,
              releaseLease: false,
              addLabels: [],
              removeLabels: [],
              comment: comment.body
            })
          }
        }
        // Re-run from a fresh read: a revoking reassignment already moved the card (running → ready), so the status
        // edits it saw are consumed and only later ones are judged; nothing in this stale snapshot is acked.
        if (result.changed || result.revokedLease) {
          return { changed, rerun: result.revokedLease && cursor > round.consumed ? cursor : round.consumed }
        }
      }
    }

    const acceptStatus = status.verdict === 'accept'
    const revertStatus = status.verdict === 'revert'
    // A close/reopen is a status request only when its own event is newer than every status-label edit.
    const observed =
      acceptStatus && edits.status?.event === 'closed'
        ? {
            ...issue,
            labels: [
              ...issue.labels.filter((label) => !isStatusLabel(label)),
              `ac/status:${issue.stateReason === 'not_planned' ? 'archived' : 'done'}`
            ]
          }
        : issue
    const proposed = planLabelReconcile({ status: card.status, leased: card.lease !== null }, observed)
    // A non-writer re-authoring a dispatchable card's status label reverts it to triage, the safe non-dispatch status.
    const plan = acceptStatus ? proposed : planStatusWrite(revertStatus ? 'triage' : card.status, issue)
    if (revertStatus && card.lease !== null) plan.releaseLease = true
    const shape = parseStatusLabels(issue.labels)
    if (!acceptStatus && !plan.comment && (shape.statuses.length > 1 || shape.malformed.length > 0)) {
      plan.comment = `AgentConnect Kanban: a card carries exactly one status label. Restored \`${statusLabel(card.status)}\`.`
    }
    // A refused ac/agent edit is undone before its cursor advances, so a failed undo is retried next pass.
    const agentCursorCommit = agentVerdict === 'refuse' ? card.syncAgentCursor : agentCursor
    const actor = status.verdict === 'ignore' ? undefined : status.actor
    const result = await this.deps.repo.apply(card, plan, cursor, acceptStatus, agentCursorCommit, actor)
    if (!result) return done(changed)
    if (result.revoked) await this.deps.revoke(result.revoked, card.id)
    changed ||= result.changed
    const current = await this.deps.repo.get(boardId, issueNumber)
    if (!current) return done(changed)
    const projection = planStatusWrite(current.status, issue)
    const undo = agentVerdict === 'refuse' ? undoLabelEdit(edits.assignee!, issue.labels) : { add: [], remove: [] }
    projection.addLabels.push(...undo.add)
    projection.removeLabels.push(...undo.remove)
    const reverted = projection.addLabels.length > 0 || projection.removeLabels.length > 0 || !!projection.issueState
    const refused = status.verdict === 'refuse' || revertStatus || agentVerdict === 'refuse'
    const comment = plan.comment ?? (refused && reverted ? permissionRefusalComment(current.status) : undefined)
    await this.deps.store.applyPlan(repo, issueNumber, issue, { ...projection, ...(comment ? { comment } : {}) })
    const finalAgentCursor = agentVerdict === 'refuse' ? agentCursor : current.syncAgentCursor
    if (!(await this.deps.repo.ack(current, cursor, finalAgentCursor))) return done(changed)
    if (current.status === 'todo') await this.deps.promote(boardId, repo, issueNumber)
    return done(changed)
  }

  // An unattributed edit is deferred, not acked or reverted; after the bound the card fails closed for a human.
  private async defer(
    card: SyncCard,
    repo: KanbanRepoRef,
    issue: { labels: readonly string[]; state: 'open' | 'closed' },
    boardId: string,
    issueNumber: number
  ): Promise<boolean> {
    const refreshed = await this.deps.repo.defer(card, this.now())
    if (!refreshed) return false
    // Wall-clock time since the first deferral, not a count: doorbells can re-run a pass far faster than the tick.
    const overdue =
      refreshed.syncDeferredAt !== null &&
      this.now().getTime() - refreshed.syncDeferredAt.getTime() >= DEFERRAL_TIMEOUT_MS
    if (!overdue) return false
    // A settled hold needs a fresh writer edit; a failed projection still retries without another timeout comment.
    if (refreshed.needsAttention && !refreshed.labelWritePending) return false
    const failed = await this.deps.repo.failClosed(refreshed)
    if (!failed) return false
    if (failed.revoked) await this.deps.revoke(failed.revoked, refreshed.id)
    const plan = planStatusWrite(failed.status, issue)
    if (!refreshed.needsAttention) {
      plan.comment = `AgentConnect Kanban: this card's status label could not be attributed within the retry window, so the card is held for a human at \`${statusLabel(failed.status)}\`. Remove and re-add the label to retry.`
    }
    try {
      await this.deps.store.applyPlan(repo, issueNumber, issue, plan)
      // Clear only this projection's pending flag; no unattributed event cursor is consumed by a fail-closed write.
      await this.deps.repo.ack(
        {
          ...refreshed,
          stateRevision: refreshed.stateRevision + (failed.status !== refreshed.status ? 1n : 0n),
          dispatchRevision: refreshed.dispatchRevision + (failed.revoked ? 1n : 0n)
        },
        refreshed.syncEventCursor,
        refreshed.syncAgentCursor
      )
    } catch (err) {
      this.deps.log.warn({ err, boardId, issueNumber }, 'kanban: fail-closed label write failed')
    }
    return failed.status !== card.status
  }
}

function labelVerdictToEdit(verdict: LabelVerdict): EditVerdict {
  if (verdict === 'writer') return 'accept'
  if (verdict === 'non_writer') return 'refuse'
  return 'ignore'
}

function actorFrom(event: LabelEvent): GitHubActor | undefined {
  const actor = event.actor
  if (!actor?.login) return undefined
  return actor.id !== undefined ? { login: actor.login, id: actor.id } : { login: actor.login }
}

function agentEditActor(
  parsed: ReturnType<typeof parseAgentLabel>,
  assigneeEvent: LabelEvent,
  events: readonly LabelEvent[]
): GitHubActor | undefined {
  if (parsed.kind === 'agent') {
    const attribution = attributeLabel(events, agentLabel(parsed.slug))
    return attribution.kind === 'add' ? actorFrom(attribution.event) : undefined
  }
  return actorFrom(assigneeEvent)
}
