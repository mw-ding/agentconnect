// Kanban CardStore (issue #2 M1): where cards live; the GitHub store reads body-free issue facts and the dependency graph.
import { GithubApiError, githubRequest, type FetchLike } from '../github/api.js'
import type { InstallationTokenService } from '../github/installation-token.service.js'
import {
  STATUS_LABEL_PREFIX,
  statusLabel,
  type KanbanStatus,
  type LabelPlan,
  type ObservedIssue
} from './card-state.js'
import { KanbanLabelWriter } from './label-writer.js'

/** The repository a board watches; installationId is resolved live by the caller, never trusted from a webhook. */
export interface KanbanRepoRef {
  installationId: bigint
  repoId: bigint
  repoFullName: string
}

/** Body-free issue facts: no title, body, or comments ever cross into the CP. */
export interface CardIssue extends ObservedIssue {
  issueId: bigint
  nodeId: string
  number: number
  authorLogin?: string | null
}

export interface CardLink {
  issueId: bigint
  number: number
  /** Null when GitHub did not say which repository the linked issue lives in. */
  repoId: bigint | null
  state: 'open' | 'closed'
  stateReason: string | null
}

export interface CardGraph {
  parent: CardLink | null
  subIssues: CardLink[]
  blockedBy: CardLink[]
  /** Issues this one blocks (its dependents). */
  blocking: CardLink[]
  /** A list hit the one-page bound, so the graph may be incomplete. */
  truncated: boolean
}

export interface CardStore {
  /** Null when the number is missing, transferred away, or a pull request. */
  readCard(repo: KanbanRepoRef, issueNumber: number): Promise<CardIssue | null>
  managedEdits(repo: KanbanRepoRef, issueNumber: number): Promise<ManagedEdits>
  readGraph(repo: KanbanRepoRef, issueNumber: number): Promise<CardGraph>
  /** True only when a human `User` added `status` and made the latest status-label change; unknown history is false. */
  statusSetByHuman(repo: KanbanRepoRef, issueNumber: number, status: KanbanStatus): Promise<boolean>
  /** Body-free issue events, oldest first; throws when the history runs past the page bound, so callers fail closed. */
  readLabelEvents(repo: KanbanRepoRef, issueNumber: number): Promise<LabelEvent[]>
  /** The newest visible issue-event id (0 for none): the pre-POST cursor bounding which events can be our write. */
  lastEventId(repo: KanbanRepoRef, issueNumber: number): Promise<number>
  /** Judge a pending promotion from the events after `cursor`; an unreadable window is inconclusive. */
  promotionVerdict(
    repo: KanbanRepoRef,
    issueNumber: number,
    cursor: number,
    postAccepted: boolean
  ): Promise<PromotionVerdict>
  /** Write a reconcile plan's labels, issue state, and comment; a no-op plan makes no GitHub call. */
  applyPlan(
    repo: KanbanRepoRef,
    issueNumber: number,
    observed: ObservedIssue,
    plan: LabelPlan,
    onLabelAdded?: LabelWriteObserver
  ): Promise<void>
}

/** Called after a label POST returns success, before any later write in the same plan. */
export type LabelWriteObserver = (label: string) => void | Promise<void>

export const WRITE_MODE_LABEL = 'ac/mode:write'
const PAGE = 100
const MAX_EVENT_PAGES = 10

/** Body-free issue event metadata: the event kind, label name, and actor attribution only. */
export interface LabelEvent {
  id: number
  event: string
  created_at?: string
  label?: { name?: string }
  actor?: { type?: string; login?: string } | null
  performed_via_github_app?: unknown
}

export interface ManagedEdits {
  status: LabelEvent | null
  assignee: LabelEvent | null
  cursor: number
}

// Preserve the latest actor, including bots and unknown actors, so an earlier human edit cannot authorize a later write.
export function latestManagedEdits(events: readonly LabelEvent[]): ManagedEdits {
  const result: ManagedEdits = { status: null, assignee: null, cursor: 0 }
  for (const event of events) {
    result.cursor = Math.max(result.cursor, event.id)
    const labelEdit = event.event === 'labeled' || event.event === 'unlabeled'
    const status =
      event.event === 'closed' ||
      event.event === 'reopened' ||
      (labelEdit && event.label?.name?.startsWith(STATUS_LABEL_PREFIX))
    const assignee = labelEdit && event.label?.name?.toLowerCase().startsWith('ac/agent:')
    if (status && (!result.status || result.status.id < event.id)) result.status = event
    if (assignee && (!result.assignee || result.assignee.id < event.id)) result.assignee = event
  }
  return result
}

/** A person acting directly: not a bot account, not an App, and not an App acting on a user's behalf. */
export function isHumanActor(event: Pick<LabelEvent, 'actor' | 'performed_via_github_app'>): boolean {
  const actor = event.actor
  return actor?.type === 'User' && !!actor.login && !actor.login.endsWith('[bot]') && !event.performed_via_github_app
}

/** This deployment's App bot, the actor of every installation-token write (the CP's and its agents' alike). */
export function isAppActor(event: Pick<LabelEvent, 'actor'>, appSlug: string | undefined): boolean {
  const login = event.actor?.login?.toLowerCase()
  return !!appSlug && event.actor?.type === 'Bot' && login === `${appSlug}[bot]`.toLowerCase()
}

/** What the events after a promotion's pre-POST cursor prove: ours (or a human's) to adopt, not ours, or not yet visible. */
export type PromotionVerdict = 'adopt' | 'reject' | 'inconclusive'

/** Managed-label adds and removals plus issue close/reopen: every event that can change what a card means. */
function isManagedEvent(event: LabelEvent): boolean {
  if (event.event === 'closed' || event.event === 'reopened') return true
  return (event.event === 'labeled' || event.event === 'unlabeled') && !!event.label?.name?.startsWith('ac/')
}

// The App identity is shared with agents, so an App ready-add is ours only after an acknowledged POST and with no other App ac/* write.
export function judgePromotion(
  events: readonly LabelEvent[],
  appSlug: string | undefined,
  cursor: number,
  postAccepted: boolean
): PromotionVerdict {
  const window = events.filter((event) => event.id > cursor && isManagedEvent(event)).sort((a, b) => a.id - b.id)
  const app: LabelEvent[] = []
  let latestAdd: LabelEvent | undefined
  for (const event of window) {
    const human = isHumanActor(event)
    if (!human && !isAppActor(event, appSlug)) return 'reject'
    if (!human) app.push(event)
    if (event.event === 'labeled' && event.label?.name === statusLabel('ready')) latestAdd = event
  }
  if (!latestAdd) return 'inconclusive'
  if (isHumanActor(latestAdd)) return 'adopt'
  if (!postAccepted) return 'reject'
  // Our write is exactly one ready add, then at most its own todo removal.
  const [add, removal, ...rest] = app
  const ownRemoval = !removal || (removal.event === 'unlabeled' && removal.label?.name === statusLabel('todo'))
  return add === latestAdd && ownRemoval && rest.length === 0 ? 'adopt' : 'reject'
}

/** The page number GitHub's `Link: <…>; rel="last"` names, or null on a single page. */
export function lastPageFromLink(link: string | null): number | null {
  const url = link?.match(/<([^>]+)>;\s*rel="last"/)?.[1]
  if (!url) return null
  const page = Number(new URL(url, 'https://api.github.com').searchParams.get('page'))
  return Number.isInteger(page) && page > 1 ? page : null
}

interface GhIssue {
  id: number
  node_id: string
  number: number
  state: 'open' | 'closed'
  state_reason?: string | null
  labels?: Array<string | { name?: string }>
  repository_url?: string
  repository?: { id?: number }
  pull_request?: unknown
  user?: { login?: string } | null
}

export interface GithubCardStoreDeps {
  tokens: Pick<InstallationTokenService, 'mintKanbanCard'>
  /** This deployment's App slug; without it no App write is ever attributed to us. */
  appSlug?: string
  fetchImpl?: FetchLike
  baseUrl?: string
}

export class GithubCardStore implements CardStore {
  private readonly writer: KanbanLabelWriter

  constructor(private readonly deps: GithubCardStoreDeps) {
    this.writer = new KanbanLabelWriter(deps)
  }

  async readCard(repo: KanbanRepoRef, issueNumber: number): Promise<CardIssue | null> {
    let issue: GhIssue
    try {
      issue = await this.get<GhIssue>(repo, `/issues/${issueNumber}`)
    } catch (err) {
      if (err instanceof GithubApiError && (err.status === 404 || err.status === 410)) return null
      throw err
    }
    if (issue.pull_request !== undefined) return null
    const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean)
    return {
      issueId: BigInt(issue.id),
      nodeId: issue.node_id,
      number: issue.number,
      state: issue.state,
      stateReason: issue.state_reason ?? null,
      labels,
      ...(issue.user !== undefined ? { authorLogin: issue.user?.login ?? null } : {})
    }
  }

  async readGraph(repo: KanbanRepoRef, issueNumber: number): Promise<CardGraph> {
    const [parent, subIssues, blockedBy, blocking] = await Promise.all([
      this.get<GhIssue>(repo, `/issues/${issueNumber}/parent`).catch((err: unknown) => {
        if (err instanceof GithubApiError && err.status === 404) return null
        throw err
      }),
      this.get<GhIssue[]>(repo, `/issues/${issueNumber}/sub_issues?per_page=${PAGE}`),
      this.get<GhIssue[]>(repo, `/issues/${issueNumber}/dependencies/blocked_by?per_page=${PAGE}`),
      this.get<GhIssue[]>(repo, `/issues/${issueNumber}/dependencies/blocking?per_page=${PAGE}`)
    ])
    return {
      parent: parent ? toLink(parent, repo) : null,
      subIssues: subIssues.map((issue) => toLink(issue, repo)),
      blockedBy: blockedBy.map((issue) => toLink(issue, repo)),
      blocking: blocking.map((issue) => toLink(issue, repo)),
      truncated: subIssues.length >= PAGE || blockedBy.length >= PAGE || blocking.length >= PAGE
    }
  }

  async managedEdits(repo: KanbanRepoRef, issueNumber: number): Promise<ManagedEdits> {
    const events = await this.recentEvents(repo, issueNumber, (seen) => {
      const latest = latestManagedEdits(seen)
      return latest.status !== null && latest.assignee !== null
    })
    if (!events) throw new Error('kanban: managed edit attribution exceeded the issue-event page bound')
    return latestManagedEdits(events)
  }

  async statusSetByHuman(repo: KanbanRepoRef, issueNumber: number, status: KanbanStatus): Promise<boolean> {
    const target = statusLabel(status)
    const isStatus = (event: LabelEvent) =>
      !!event.label?.name?.startsWith(STATUS_LABEL_PREFIX) && ['labeled', 'unlabeled'].includes(event.event)
    const isTargetAdd = (event: LabelEvent) => event.event === 'labeled' && event.label?.name === target
    // Newest pages first, so a long history still finds the latest status change.
    const events = await this.recentEvents(repo, issueNumber, (seen) => seen.some(isStatus) && seen.some(isTargetAdd))
    if (!events) return false
    let latest: LabelEvent | undefined
    let latestAdd: LabelEvent | undefined
    for (const event of events) {
      if (!isStatus(event)) continue
      if (!latest || event.id > latest.id) latest = event
      if (isTargetAdd(event) && (!latestAdd || event.id > latestAdd.id)) latestAdd = event
    }
    return !!latest && !!latestAdd && isHumanActor(latest) && isHumanActor(latestAdd)
  }

  async readLabelEvents(repo: KanbanRepoRef, issueNumber: number): Promise<LabelEvent[]> {
    const events = await this.recentEvents(repo, issueNumber, () => false)
    if (!events) throw new Error('kanban: issue events run past the page bound')
    // Keep attribution fields only: a `renamed` event would otherwise carry the issue title.
    return events
      .map((e) => ({
        id: e.id,
        event: e.event,
        ...(e.created_at !== undefined ? { created_at: e.created_at } : {}),
        ...(e.label?.name !== undefined ? { label: { name: e.label.name } } : {}),
        actor: e.actor ? { type: e.actor.type, login: e.actor.login } : null,
        ...(e.performed_via_github_app ? { performed_via_github_app: true } : {})
      }))
      .sort((a, b) => a.id - b.id)
  }

  async lastEventId(repo: KanbanRepoRef, issueNumber: number): Promise<number> {
    // An empty `rel="last"` page walks back to the newest non-empty one; cursor 0 would admit every older App write.
    const events = await this.recentEvents(repo, issueNumber, (seen) => seen.length > 0)
    if (!events) throw new Error('kanban: no issue event within the page bound to anchor the promotion cursor')
    return events.reduce((max, event) => Math.max(max, event.id), 0)
  }

  async promotionVerdict(
    repo: KanbanRepoRef,
    issueNumber: number,
    cursor: number,
    postAccepted: boolean
  ): Promise<PromotionVerdict> {
    const events = await this.recentEvents(repo, issueNumber, (seen) => seen.some((event) => event.id <= cursor))
    return events ? judgePromotion(events, this.deps.appSlug, cursor, postAccepted) : 'inconclusive'
  }

  // Pages newest first (Link rel="last", then backward) until `enough` or page 1; null past the page bound.
  private async recentEvents(
    repo: KanbanRepoRef,
    issueNumber: number,
    enough: (seen: readonly LabelEvent[]) => boolean
  ): Promise<LabelEvent[] | null> {
    const first = await this.eventsPage(repo, issueNumber, 1)
    const seen: LabelEvent[] = []
    let reads = 1
    for (let page = first.last ?? 1; page >= 1; page--) {
      if (page > 1 && ++reads > MAX_EVENT_PAGES) return null
      seen.push(...(page > 1 ? (await this.eventsPage(repo, issueNumber, page)).events : first.events))
      if (enough(seen)) return seen
    }
    return seen
  }

  private async eventsPage(
    repo: KanbanRepoRef,
    issueNumber: number,
    page: number
  ): Promise<{ events: LabelEvent[]; last: number | null }> {
    let link: string | null = null
    const fetchImpl: FetchLike = async (url, init) => {
      const response = await (this.deps.fetchImpl ?? fetch)(url, init)
      link = response.headers.get('link')
      return response
    }
    const path = `/issues/${issueNumber}/events?per_page=${PAGE}&page=${page}`
    const events = await this.get<LabelEvent[]>(repo, path, fetchImpl)
    return { events, last: lastPageFromLink(link) }
  }

  applyPlan(
    repo: KanbanRepoRef,
    issueNumber: number,
    observed: ObservedIssue,
    plan: LabelPlan,
    onLabelAdded?: LabelWriteObserver
  ): Promise<void> {
    return this.writer.apply(repo, issueNumber, observed, plan, onLabelAdded)
  }

  private async get<T>(repo: KanbanRepoRef, path: string, fetchImpl = this.deps.fetchImpl): Promise<T> {
    const grant = await this.deps.tokens.mintKanbanCard(repo.installationId, repo.repoFullName, repo.repoId, 'read')
    return githubRequest<T>(`/repositories/${repo.repoId}${path}`, {
      auth: grant.token,
      fetchImpl,
      baseUrl: this.deps.baseUrl
    })
  }
}

function toLink(issue: GhIssue, repo: KanbanRepoRef): CardLink {
  return {
    issueId: BigInt(issue.id),
    number: issue.number,
    repoId:
      issue.repository?.id !== undefined
        ? BigInt(issue.repository.id)
        : issue.repository_url?.toLowerCase() === `https://api.github.com/repos/${repo.repoFullName}`.toLowerCase()
          ? repo.repoId
          : null,
    state: issue.state,
    stateReason: issue.state_reason ?? null
  }
}
