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
  /** Write a reconcile plan's labels, issue state, and comment; a no-op plan makes no GitHub call. */
  applyPlan(repo: KanbanRepoRef, issueNumber: number, observed: ObservedIssue, plan: LabelPlan): Promise<void>
}

export const WRITE_MODE_LABEL = 'ac/mode:write'
const PAGE = 100
const MAX_EVENT_PAGES = 10

/** Body-free issue event metadata: the event kind, label name, and actor attribution only. */
interface LabelEvent {
  id: number
  event: string
  label?: { name?: string }
  actor?: { type?: string; login?: string } | null
  performed_via_github_app?: unknown
}

/** A person acting directly: not a bot account, not an App, and not an App acting on a user's behalf. */
export function isHumanActor(event: Pick<LabelEvent, 'actor' | 'performed_via_github_app'>): boolean {
  const actor = event.actor
  return actor?.type === 'User' && !!actor.login && !actor.login.endsWith('[bot]') && !event.performed_via_github_app
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
    const target = statusLabel(status)
    let latest: LabelEvent | undefined
    let latestAdd: LabelEvent | undefined
    for (let page = 1; page <= MAX_EVENT_PAGES; page++) {
      const events = await this.get<LabelEvent[]>(repo, `/issues/${issueNumber}/events?per_page=${PAGE}&page=${page}`)
      for (const event of events) {
        const name = event.label?.name
        if (!name?.startsWith(STATUS_LABEL_PREFIX) || !['labeled', 'unlabeled'].includes(event.event)) continue
        if (!latest || event.id > latest.id) latest = event
        if (event.event === 'labeled' && name === target && (!latestAdd || event.id > latestAdd.id)) latestAdd = event
      }
      if (events.length < PAGE) return !!latest && !!latestAdd && isHumanActor(latest) && isHumanActor(latestAdd)
    }
    return false
  }

  applyPlan(repo: KanbanRepoRef, issueNumber: number, observed: ObservedIssue, plan: LabelPlan): Promise<void> {
    return this.writer.apply(repo, issueNumber, observed, plan)
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
