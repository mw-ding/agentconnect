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
  readGraph(repo: KanbanRepoRef, issueNumber: number): Promise<CardGraph>
  /** True only when a human `User` added `status` and made the latest status-label change; unknown history is false. */
  statusSetByHuman(repo: KanbanRepoRef, issueNumber: number, status: KanbanStatus): Promise<boolean>
  // Null means the bounded event history cannot yet establish attribution; retry without settling the promotion.
  promotionAttributed(repo: KanbanRepoRef, issueNumber: number, readyAddedAt: Date | null): Promise<boolean | null>
  /** Write a reconcile plan's labels, issue state, and comment; a no-op plan makes no GitHub call. */
  applyPlan(
    repo: KanbanRepoRef,
    issueNumber: number,
    observed: ObservedIssue,
    plan: LabelPlan,
    onLabelAdded?: LabelWriteObserver
  ): Promise<void>
}

// GitHub's server timestamp returned by a successful label POST, captured before any later write can fail.
export type LabelWriteObserver = (label: string, addedAt: Date | null) => void

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

const PROMOTABLE_LABELS: ReadonlySet<string> = new Set([statusLabel('todo'), statusLabel('ready')])

// Replay the complete history; an App ready-add must uniquely match the receipt of our pending write.
export function promotionAttributed(
  events: readonly LabelEvent[],
  appSlug: string | undefined,
  readyAddedAt: Date | null
): boolean | null {
  const receipt = readyAddedAt?.toISOString()
  const matchesReceipt = (e: LabelEvent) =>
    !!receipt && !!e.created_at && Date.parse(e.created_at) === Date.parse(receipt) && isAppActor(e, appSlug)
  const readyAdds = events.filter((e) => e.event === 'labeled' && e.label?.name === statusLabel('ready'))
  const matchingAdds = readyAdds.filter(matchesReceipt)
  let latestReady: LabelEvent | undefined
  const labels = new Set<string>()
  let open = true
  let trusted = true
  let readyAddTrusted = false
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    const name = event.label?.name
    if (event.event === 'labeled' || event.event === 'unlabeled') {
      if (!name?.startsWith(STATUS_LABEL_PREFIX)) continue
      if (event.event === 'labeled') labels.add(name)
      else labels.delete(name)
    } else if (event.event === 'closed' || event.event === 'reopened') {
      open = event.event === 'reopened'
    } else {
      continue
    }
    const human = isHumanActor(event)
    const known = human || isAppActor(event, appSlug)
    if (event.event === 'labeled' && name === statusLabel('ready')) {
      latestReady = event
      readyAddTrusted = human || (matchingAdds.length === 1 && matchesReceipt(event))
    }
    // A human park (another status, or closed) stands until a human undoes it; any unknown writer forfeits trust.
    if (human) trusted = open && labels.size > 0 && [...labels].every((l) => PROMOTABLE_LABELS.has(l))
    else if (!known) trusted = false
    // Removing ready revokes the old promotion, even if todo remains or the server clock crosses a second.
    if (event.event === 'unlabeled' && name === statusLabel('ready')) trusted = false
  }
  if (!trusted) return false
  if (!latestReady || (readyAddedAt && latestReady.created_at && new Date(latestReady.created_at) < readyAddedAt))
    return null
  return readyAddTrusted
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
      labels
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
      parent: parent ? toLink(parent) : null,
      subIssues: subIssues.map(toLink),
      blockedBy: blockedBy.map(toLink),
      blocking: blocking.map(toLink),
      truncated: subIssues.length >= PAGE || blockedBy.length >= PAGE || blocking.length >= PAGE
    }
  }

  async statusSetByHuman(repo: KanbanRepoRef, issueNumber: number, status: KanbanStatus): Promise<boolean> {
    const events = await this.issueEvents(repo, issueNumber)
    if (!events) return false
    const target = statusLabel(status)
    let latest: LabelEvent | undefined
    let latestAdd: LabelEvent | undefined
    for (const event of events) {
      const name = event.label?.name
      if (!name?.startsWith(STATUS_LABEL_PREFIX) || !['labeled', 'unlabeled'].includes(event.event)) continue
      if (!latest || event.id > latest.id) latest = event
      if (event.event === 'labeled' && name === target && (!latestAdd || event.id > latestAdd.id)) latestAdd = event
    }
    return !!latest && !!latestAdd && isHumanActor(latest) && isHumanActor(latestAdd)
  }

  async promotionAttributed(
    repo: KanbanRepoRef,
    issueNumber: number,
    readyAddedAt: Date | null
  ): Promise<boolean | null> {
    const events = await this.issueEvents(repo, issueNumber)
    return events ? promotionAttributed(events, this.deps.appSlug, readyAddedAt) : null
  }

  /** The issue's whole event history, or null past the page bound so callers fail closed. */
  private async issueEvents(repo: KanbanRepoRef, issueNumber: number): Promise<LabelEvent[] | null> {
    const all: LabelEvent[] = []
    for (let page = 1; page <= MAX_EVENT_PAGES; page++) {
      const events = await this.get<LabelEvent[]>(repo, `/issues/${issueNumber}/events?per_page=${PAGE}&page=${page}`)
      all.push(...events)
      if (events.length < PAGE) return all
    }
    return null
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

  private async get<T>(repo: KanbanRepoRef, path: string): Promise<T> {
    const grant = await this.deps.tokens.mintKanbanCard(repo.installationId, repo.repoFullName, repo.repoId, 'read')
    return githubRequest<T>(`/repositories/${repo.repoId}${path}`, {
      auth: grant.token,
      fetchImpl: this.deps.fetchImpl,
      baseUrl: this.deps.baseUrl
    })
  }
}

function toLink(issue: GhIssue): CardLink {
  return {
    issueId: BigInt(issue.id),
    number: issue.number,
    repoId: issue.repository?.id !== undefined ? BigInt(issue.repository.id) : null,
    state: issue.state,
    stateReason: issue.state_reason ?? null
  }
}
