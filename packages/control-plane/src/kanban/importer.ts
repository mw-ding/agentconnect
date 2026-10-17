// Import only status-labeled issues; the author and every label that carries authority are attributed live, else triage.
import { checkWriteAccess, type RepoPermissionLevel, type RepoPermissionLookup } from '../github/repo-permission.js'
import type {
  KanbanBoardRecord,
  KanbanBoardRepo,
  KanbanCardRepo,
  KanbanHumanAuthority,
  KanbanInitialStatus
} from '../persistence/ports.js'
import { AGENT_LABEL_PREFIX, parseAgentLabel } from './agent-label.js'
import { observedCardStatus, parseStatusLabels, planStatusWrite, isStatusLabel } from './card-state.js'
import { attestHumanAuthority } from './human-authority.js'
import { doorbellAddVisible, labelAddedByWriter, latestTransferEvent } from './label-attribution.js'
import type { KanbanIssueDoorbell } from './graph-doorbell.js'
import {
  isAppActor,
  isHumanActor,
  type CardIssue,
  type CardStore,
  type KanbanRepoRef,
  type LabelEvent
} from './card-store.js'

export interface KanbanImporterDeps {
  cards: Pick<KanbanCardRepo, 'findByIssueNumber' | 'upsertCard' | 'resolveAgentSlug'>
  /** Without it (or without the store's repository read) a renamed repository refuses imports, as before. */
  boards?: Pick<KanbanBoardRepo, 'refreshRepoFullName'>
  store: Pick<CardStore, 'readCard' | 'applyPlan' | 'readLabelEvents'> &
    Partial<Pick<CardStore, 'readRepositoryFullName'>>
  permissions: RepoPermissionLookup
  /** This deployment's App slug: its writes are the agents' too, so they never attribute a label. */
  appSlug?: string
  log?: { warn: (obj: unknown, msg?: string) => void }
  now?: () => Date
}

/** How long a live writer's not-yet-visible doorbell add keeps an import retrying before it imports as triage. */
const DOORBELL_LAG_TIMEOUT_MS = 10 * 60_000
/** Lagging-import memory bound (flush-at-cap, the landed-GUID precedent). */
const MAX_LAGGING = 5_000

/** The doorbell's own label add is not yet visible: the delivery stays un-landed so the redelivery sweep retries it. */
export class KanbanImportInconclusiveError extends Error {
  constructor() {
    super('kanban import: the doorbell label add is not yet visible in the issue events')
    this.name = 'KanbanImportInconclusiveError'
  }
}

type WriteCheck = { level: RepoPermissionLevel; write: boolean }

export class KanbanImporter {
  /** First inconclusive pass per `boardId#issueNumber`, so a lagging doorbell add fails closed after the bound. */
  private readonly lagging = new Map<string, number>()

  constructor(private readonly deps: KanbanImporterDeps) {}

  // Returns true when this delivery imported a candidate, including a concurrent create winner.
  async import(
    board: KanbanBoardRecord,
    boardRepo: KanbanRepoRef,
    issueNumber: number,
    options: KanbanIssueDoorbell = {}
  ): Promise<boolean> {
    if (await this.deps.cards.findByIssueNumber(board.id, issueNumber)) return false
    const issue = await this.deps.store.readCard(boardRepo, issueNumber)
    if (!issue || !issue.labels.some(isStatusLabel)) return false
    const repo = await this.boardRepository(board, boardRepo, issueNumber, issue)
    if (!repo) return false
    // TRD §7: an unattributed card is still imported, but as triage, which a claim never takes (it needs ready + assignee).
    const checks = new Map<string, Promise<WriteCheck>>()
    const writer = (login: string | null | undefined): Promise<WriteCheck> => {
      if (!login) return Promise.resolve({ level: 'none', write: false })
      const id = login.toLowerCase()
      if (!checks.has(id)) checks.set(id, this.check(board, repo, issueNumber, login))
      return checks.get(id)!
    }
    const authority = await this.attribute(board, repo, issueNumber, issue, options, writer)
    const observed = observedCardStatus(issue)
    const kept = authority !== null && observed !== 'running'
    const status: KanbanInitialStatus = kept ? observed : 'triage'
    const agentLabel = parseAgentLabel(issue.labels)
    const assigneeAgentId =
      kept && agentLabel.kind === 'agent' && (await this.agentLabelsAttributed(authority.events, issue.labels, writer))
        ? await this.deps.cards.resolveAgentSlug(board.orgId, agentLabel.slug)
        : null
    // A failed triage write must leave no importable DB row whose next delivery could adopt the original ready label.
    await this.deps.store.applyPlan(repo, issueNumber, issue, planStatusWrite(status, issue))
    await this.deps.cards.upsertCard({
      boardId: board.id,
      expectedRepoId: repo.repoId,
      issueId: issue.issueId,
      issueNumber,
      issueNodeId: issue.nodeId,
      status,
      assigneeAgentId,
      source: 'import',
      ...(kept ? { humanAuthority: authority.human } : {})
    })
    return true
  }

  // Import only from the board's repository by name too: a rename (same id, new name) refreshes the board, a redirect refuses.
  private async boardRepository(
    board: KanbanBoardRecord,
    repo: KanbanRepoRef,
    issueNumber: number,
    issue: CardIssue
  ): Promise<KanbanRepoRef | null> {
    const name = issue.repositoryFullName
    if (name === undefined || name?.toLowerCase() === repo.repoFullName.toLowerCase()) return repo
    const current =
      name && this.deps.boards && this.deps.store.readRepositoryFullName
        ? await this.deps.store.readRepositoryFullName(repo)
        : null
    if (!name || !current || current.toLowerCase() !== name.toLowerCase()) {
      this.deps.log?.warn(
        { boardId: board.id, issueNumber, reason: 'repository_mismatch' },
        'kanban import: issue read resolved outside the board repository; not importing'
      )
      return null
    }
    if (!(await this.deps.boards!.refreshRepoFullName(board.id, repo.repoId, current))) return null
    return { ...repo, repoFullName: current }
  }

  // The author, the latest transferrer, and the adder of the one current status label must all be live human writers.
  private async attribute(
    board: KanbanBoardRecord,
    repo: KanbanRepoRef,
    issueNumber: number,
    issue: CardIssue,
    doorbell: KanbanIssueDoorbell,
    writer: (login: string | null | undefined) => Promise<WriteCheck>
  ): Promise<{ human: KanbanHumanAuthority; events: LabelEvent[] } | null> {
    const author = {
      actor: { type: issue.authorType ?? undefined, login: issue.authorLogin ?? undefined },
      performed_via_github_app: issue.authorViaGithubApp
    }
    if (!(await this.humanWriter(author, writer))) return null
    const { labels } = issue
    // Exactly one well-formed status label to attribute; drift, a malformed value, or `running` never carries authority.
    const statusLabels = labels.filter(isStatusLabel)
    const { statuses, malformed } = parseStatusLabels(labels)
    if (statusLabels.length !== 1 || malformed.length > 0 || statuses[0] === 'running') return null
    let events: LabelEvent[]
    try {
      events = await this.deps.store.readLabelEvents(repo, issueNumber)
    } catch (err) {
      this.warn(board, issueNumber, 'events_unreadable', err)
      return null
    }
    if (!(await this.doorbellAddAttributable(board, issueNumber, issue, events, doorbell, writer))) return null
    const transfer = latestTransferEvent(events)
    if (doorbell.action === 'transferred' && !transfer) return null
    if (transfer && !(await this.humanWriter(transfer, writer))) return null
    const added = await labelAddedByWriter(events, statusLabels[0]!, this.deps.appSlug, writer)
    if (!added) return null
    return { human: attestHumanAuthority(added.login, added.level), events }
  }

  // A `labeled` doorbell's own add must be the latest visible event for its live label, or an older visible add would
  // attribute it: a non-writer sender imports as triage; a writer's lag retries (throws) until the bound, then triage.
  private async doorbellAddAttributable(
    board: KanbanBoardRecord,
    issueNumber: number,
    issue: CardIssue,
    events: readonly LabelEvent[],
    doorbell: KanbanIssueDoorbell,
    writer: (login: string | null | undefined) => Promise<WriteCheck>
  ): Promise<boolean> {
    const { sender, label } = doorbell
    if (doorbell.action !== 'labeled' || !sender || !label) return true
    const key = `${board.id}#${issueNumber}`
    const managed = isStatusLabel(label) || label.toLowerCase().startsWith(AGENT_LABEL_PREFIX)
    const live = issue.labels.some((name) => name.toLowerCase() === label.toLowerCase())
    if (!managed || !live || doorbellAddVisible(events, label, sender)) {
      this.lagging.delete(key)
      return true
    }
    if (!(await writer(sender.login)).write) {
      this.lagging.delete(key)
      return false
    }
    const now = (this.deps.now?.() ?? new Date()).getTime()
    const since = this.lagging.get(key) ?? now
    if (now - since >= DOORBELL_LAG_TIMEOUT_MS) {
      this.lagging.delete(key)
      this.warn(board, issueNumber, 'doorbell_add_not_visible', new KanbanImportInconclusiveError())
      return false
    }
    if (this.lagging.size >= MAX_LAGGING) this.lagging.clear()
    this.lagging.set(key, since)
    throw new KanbanImportInconclusiveError()
  }

  // Every current ac/agent:* label, not just the parsed one, so a second label cannot ride in unattributed.
  private async agentLabelsAttributed(
    events: readonly LabelEvent[],
    labels: readonly string[],
    writer: (login: string | null | undefined) => Promise<WriteCheck>
  ): Promise<boolean> {
    const agentLabels = labels.filter((label) => label.toLowerCase().startsWith(AGENT_LABEL_PREFIX))
    for (const label of agentLabels) {
      if (!(await labelAddedByWriter(events, label, this.deps.appSlug, writer))) return false
    }
    return true
  }

  private async humanWriter(
    event: Pick<LabelEvent, 'actor' | 'performed_via_github_app'>,
    writer: (login: string | null | undefined) => Promise<WriteCheck>
  ): Promise<boolean> {
    if (!isHumanActor(event) || isAppActor(event, this.deps.appSlug)) return false
    return (await writer(event.actor?.login)).write
  }

  private async check(
    board: KanbanBoardRecord,
    repo: KanbanRepoRef,
    issueNumber: number,
    login: string
  ): Promise<WriteCheck> {
    const result = await checkWriteAccess(this.deps.permissions, repo, login)
    if (result.error !== undefined) this.warn(board, issueNumber, 'permission_lookup_failed', result.error)
    return { level: result.level, write: result.write }
  }

  // Body-free: ids, a reason, and the error's class and HTTP status only, never its message.
  private warn(board: KanbanBoardRecord, issueNumber: number, reason: string, err: unknown): void {
    const status = (err as { status?: unknown } | null)?.status
    this.deps.log?.warn(
      {
        boardId: board.id,
        issueNumber,
        reason,
        errorName: err instanceof Error ? err.name : typeof err,
        ...(typeof status === 'number' ? { status } : {})
      },
      'kanban import: attribution failed; importing as triage'
    )
  }
}
