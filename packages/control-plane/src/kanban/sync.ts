// Human edits are attributed from GitHub events; periodic repair projects committed state after failed label writes.
import type { KanbanCardRepo, KanbanLeaseRef } from '../persistence/ports.js'
import {
  isAppActor,
  isHumanActor,
  latestManagedEdits,
  type CardStore,
  type KanbanRepoRef,
  type LabelEvent
} from './card-store.js'
import { checkWriteAccess, type RepoPermissionLookup } from '../github/repo-permission.js'
import { parseAgentLabel, agentLabel } from './agent-label.js'
import {
  attributeLabel,
  judgeLabelAdd,
  liveManagedLabels,
  replayManagedLabels,
  setsEqual,
  type LabelVerdict
} from './label-attribution.js'
import {
  permissionRefusalComment,
  planLabelReconcile,
  planStatusWrite,
  parseStatusLabels,
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
  /** Fail a card closed: flag it for a human and clear the deferral bound. */
  failClosed(card: SyncCard): Promise<boolean>
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
/** How many deferred passes (or how long) an unattributed edit may stay deferred before it fails closed. */
const MAX_DEFERRALS = 10
const DEFERRAL_TIMEOUT_MS = 10 * 60_000

type EditVerdict = 'accept' | 'refuse' | 'ignore'

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

  onCardChanged(boardId: string, issueNumber: number, humanDoorbell = false): Promise<boolean> {
    return this.enqueue(boardId, issueNumber, () => this.reconcile(boardId, issueNumber, humanDoorbell))
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

  // The verdict for the one status label (or close/reopen) sync would adopt, judged on the event that produced it.
  private async statusVerdict(opts: {
    card: SyncCard
    edits: { status: LabelEvent | null }
    issue: { labels: readonly string[]; state: 'open' | 'closed' }
    events: readonly LabelEvent[]
    repo: KanbanRepoRef
    writers: Map<string, Promise<boolean>>
  }): Promise<EditVerdict | 'pending'> {
    const { card, edits, issue, events, repo, writers } = opts
    const statusEvent = edits.status
    const newStatus = !!statusEvent && BigInt(statusEvent.id) > card.syncEventCursor
    if (statusEvent?.event === 'closed' || statusEvent?.event === 'reopened') {
      return newStatus ? this.judgeEvent(repo, statusEvent, writers) : 'ignore'
    }
    const requested = planLabelReconcile({ status: card.status, leased: card.lease !== null }, issue).requested
    if (requested === undefined) return 'ignore'
    const attribution = attributeLabel(events, statusLabel(requested))
    if (attribution.kind !== 'add') return 'pending'
    if (BigInt(attribution.event.id) <= card.syncEventCursor) return 'ignore'
    const verdict = await judgeLabelAdd(attribution, {
      repo,
      permissions: this.deps.permissions,
      appSlug: this.deps.appSlug,
      writers,
      warn: (err, repoId) => this.deps.log.warn({ err, repoId }, 'kanban: permission lookup failed')
    })
    return labelVerdictToEdit(verdict)
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
      const attribution = attributeLabel(events, agentLabel(parsed.slug))
      const verdict = await judgeLabelAdd(attribution, {
        repo,
        permissions: this.deps.permissions,
        appSlug: this.deps.appSlug,
        writers,
        warn: (err, repoId) => this.deps.log.warn({ err, repoId }, 'kanban: permission lookup failed')
      })
      return labelVerdictToEdit(verdict)
    }
    return this.judgeEvent(repo, assigneeEvent, writers)
  }

  private async reconcile(boardId: string, issueNumber: number, humanDoorbell: boolean): Promise<boolean> {
    let card = await this.deps.repo.get(boardId, issueNumber)
    if (!card || card.promotionPending) return false
    const repo = await this.deps.repoRef(boardId)
    if (!repo) return false
    const issue = await this.deps.store.readCard(repo, issueNumber)
    if (!issue) return false
    // Visible history oldest-first; a read past the page bound throws and this pass fails closed.
    const events = await this.deps.store.readLabelEvents(repo, issueNumber)
    const edits = latestManagedEdits(events)
    const cursor = BigInt(edits.status?.id ?? 0)
    const agentCursor = BigInt(edits.assignee?.id ?? 0)

    // Event lag: the visible events must reproduce the live managed labels, or nothing here can be attributed.
    if (!setsEqual(replayManagedLabels(events), liveManagedLabels(issue))) {
      return this.defer(card, repo, issue, boardId, issueNumber)
    }

    const writers = new Map<string, Promise<boolean>>()
    const parsed = parseAgentLabel(issue.labels)
    const newAgent = !!edits.assignee && BigInt(edits.assignee.id) > card.syncAgentCursor
    const agentVerdict: EditVerdict = newAgent
      ? await this.agentVerdict(repo, parsed, edits.assignee!, events, writers)
      : 'ignore'
    const statusVerdict = await this.statusVerdict({ card, edits, issue, events, repo, writers })

    // A fail-closed card is human-only: only a fresh, cleanly-attributed human writer edit moves it again.
    if (card.needsAttention && statusVerdict !== 'accept' && agentVerdict !== 'accept') return false

    let changed = false
    let acceptStatus = statusVerdict === 'accept'

    if (agentVerdict === 'accept') {
      const target =
        parsed.kind === 'agent'
          ? await this.deps.cards.resolveAgentSlug(card.orgId, parsed.slug)
          : parsed.kind === 'none'
            ? null
            : undefined
      // Unknown or ambiguous slugs preserve the current assignee.
      if (target !== undefined && (parsed.kind !== 'agent' || target !== null)) {
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
        if (!result.ok) return false
        changed = result.changed
        if (result.changed && result.revokedLease) acceptStatus = false
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
        // A reassignment changed the card under us: re-read everything before planning labels.
        if (result.changed || result.revokedLease) {
          return this.reconcile(boardId, issueNumber, humanDoorbell)
        }
        card = await this.deps.repo.get(boardId, issueNumber)
        if (!card || card.promotionPending) return changed
      }
    }

    // A close/reopen is a status request only when its own event is newer than every status-label edit.
    const observed =
      acceptStatus && edits.status?.event === 'closed'
        ? {
            ...issue,
            labels: [
              ...issue.labels.filter((label) => !label.startsWith('ac/status:')),
              `ac/status:${issue.stateReason === 'not_planned' ? 'archived' : 'done'}`
            ]
          }
        : issue
    const proposed = planLabelReconcile({ status: card.status, leased: card.lease !== null }, observed)
    const plan = acceptStatus ? proposed : planStatusWrite(card.status, issue)
    const shape = parseStatusLabels(issue.labels)
    if (!acceptStatus && !plan.comment && (shape.statuses.length > 1 || shape.malformed.length > 0)) {
      plan.comment = `AgentConnect Kanban: a card carries exactly one status label. Restored \`${statusLabel(card.status)}\`.`
    }
    // A refused ac/agent edit is undone before its cursor advances, so a failed undo is retried next pass.
    const agentCursorCommit = agentVerdict === 'refuse' ? card.syncAgentCursor : agentCursor
    const actor =
      statusVerdict === 'accept' || statusVerdict === 'refuse' ? statusEditActor(card, issue, events, edits) : undefined
    const result = await this.deps.repo.apply(card, plan, cursor, acceptStatus, agentCursorCommit, actor)
    if (!result) return changed
    if (result.revoked) await this.deps.revoke(result.revoked, card.id)
    changed ||= result.changed
    const current = await this.deps.repo.get(boardId, issueNumber)
    if (!current) return changed
    const projection = planStatusWrite(current.status, issue)
    const undo = agentVerdict === 'refuse' ? undoLabelEdit(edits.assignee!, issue.labels) : { add: [], remove: [] }
    projection.addLabels.push(...undo.add)
    projection.removeLabels.push(...undo.remove)
    const reverted = projection.addLabels.length > 0 || projection.removeLabels.length > 0 || !!projection.issueState
    const refused = statusVerdict === 'refuse' || agentVerdict === 'refuse'
    const comment = plan.comment ?? (refused && reverted ? permissionRefusalComment(current.status) : undefined)
    await this.deps.store.applyPlan(repo, issueNumber, issue, { ...projection, ...(comment ? { comment } : {}) })
    const finalAgentCursor = agentVerdict === 'refuse' ? agentCursor : current.syncAgentCursor
    if (!(await this.deps.repo.ack(current, cursor, finalAgentCursor))) return changed
    if (current.status === 'todo') await this.deps.promote(boardId, repo, issueNumber)
    return changed
  }

  // An unattributed edit is deferred, not acked or reverted; after the bound it fails closed for a human.
  private async defer(
    card: SyncCard,
    repo: KanbanRepoRef,
    issue: { labels: readonly string[]; state: 'open' | 'closed' },
    boardId: string,
    issueNumber: number
  ): Promise<boolean> {
    const refreshed = await this.deps.repo.defer(card, this.now())
    if (!refreshed) return false
    const overdue =
      refreshed.syncDeferralCount >= MAX_DEFERRALS ||
      (refreshed.syncDeferredAt !== null &&
        this.now().getTime() - refreshed.syncDeferredAt.getTime() >= DEFERRAL_TIMEOUT_MS)
    if (!overdue) return false
    const plan = planStatusWrite(refreshed.status, issue)
    plan.comment = `AgentConnect Kanban: this card's status label could not be attributed within the retry window, so \`${statusLabel(refreshed.status)}\` was kept. Remove and re-add the label to retry.`
    try {
      await this.deps.store.applyPlan(repo, issueNumber, issue, plan)
    } catch (err) {
      this.deps.log.warn({ err, boardId, issueNumber }, 'kanban: fail-closed revert write failed')
    }
    await this.deps.repo.failClosed(refreshed)
    return false
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

function statusEditActor(
  card: SyncCard,
  issue: { labels: readonly string[]; state: 'open' | 'closed' },
  events: readonly LabelEvent[],
  edits: { status: LabelEvent | null }
): GitHubActor | undefined {
  const statusEvent = edits.status
  if (statusEvent?.event === 'closed' || statusEvent?.event === 'reopened') return actorFrom(statusEvent)
  const requested = planLabelReconcile({ status: card.status, leased: card.lease !== null }, issue).requested
  if (requested === undefined) return undefined
  const attribution = attributeLabel(events, statusLabel(requested))
  return attribution.kind === 'add' ? actorFrom(attribution.event) : undefined
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
