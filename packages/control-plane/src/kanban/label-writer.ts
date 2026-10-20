// Kanban label/close writer (issue #2 D3/D5): the only CP path that writes card metadata to GitHub, via the CP-only card token.
import { GithubApiError, githubRequest, githubRequestPage, type FetchLike, type GithubPage } from '../github/api.js'
import type { InstallationTokenService } from '../github/installation-token.service.js'
import type { LabelPlan, ObservedIssue } from './card-state.js'
import type { KanbanRepoRef, LabelWriteObserver } from './card-store.js'

export interface KanbanLabelWriterDeps {
  tokens: Pick<InstallationTokenService, 'mintKanbanCard'>
  fetchImpl?: FetchLike
  baseUrl?: string
  appSlug?: string
}

interface MarkedComment {
  body?: string
  user?: { login?: string; type?: string }
}

export class KanbanLabelWriter {
  constructor(private readonly deps: KanbanLabelWriterDeps) {}

  /** Per-label add/remove of only the managed diff, so a racing writer's other labels are never overwritten. */
  async apply(
    repo: KanbanRepoRef,
    issueNumber: number,
    _observed: ObservedIssue,
    plan: LabelPlan,
    onLabelAdded?: LabelWriteObserver
  ): Promise<void> {
    const labelsChanged = plan.addLabels.length > 0 || plan.removeLabels.length > 0
    if (!labelsChanged && !plan.issueState && !plan.comment) return
    const grant = await this.deps.tokens.mintKanbanCard(repo.installationId, repo.repoFullName, repo.repoId, 'write')
    const call = (path: string, method: 'PATCH' | 'POST' | 'DELETE', body?: unknown) =>
      githubRequest<unknown>(`/repositories/${repo.repoId}/issues/${issueNumber}${path}`, {
        method,
        auth: grant.token,
        body,
        fetchImpl: this.deps.fetchImpl,
        baseUrl: this.deps.baseUrl
      })

    // Add before remove so GitHub never shows zero status labels mid-write. The observer runs before the removal.
    for (const label of new Set(plan.addLabels)) {
      await call('/labels', 'POST', { labels: [label] })
      await onLabelAdded?.(label)
    }
    for (const label of new Set(plan.removeLabels)) {
      try {
        await call(`/labels/${encodeURIComponent(label)}`, 'DELETE')
      } catch (err) {
        if (!(err instanceof GithubApiError && err.status === 404)) throw err
      }
    }
    if (plan.issueState?.state === 'closed') {
      await call('', 'PATCH', { state: 'closed', state_reason: plan.issueState.reason })
    } else if (plan.issueState?.state === 'open') {
      await call('', 'PATCH', { state: 'open', state_reason: 'reopened' })
    }
    if (plan.comment) {
      const marker = plan.commentKey ? `<!-- agentconnect-kanban:${plan.commentKey} -->` : undefined
      if (marker && (await this.hasComment(repo, issueNumber, marker, grant.token))) return
      await call('/comments', 'POST', { body: marker ? `${plan.comment}\n\n${marker}` : plan.comment })
    }
  }

  // A failed or incomplete read never authorizes a POST; writes are never retried blind by githubRequest.
  private async hasComment(repo: KanbanRepoRef, issueNumber: number, marker: string, token: string): Promise<boolean> {
    if (!this.deps.appSlug) throw new Error('kanban: App identity required for comment recovery')
    let path: string | undefined = `/repositories/${repo.repoId}/issues/${issueNumber}/comments?per_page=100`
    for (let page = 0; path && page < 10; page++) {
      const result: GithubPage<MarkedComment[]> = await githubRequestPage<MarkedComment[]>(path, {
        auth: token,
        fetchImpl: this.deps.fetchImpl,
        baseUrl: this.deps.baseUrl
      })
      if (
        result.data.some(
          (comment) =>
            comment.user?.type === 'Bot' &&
            comment.user.login?.toLowerCase() === `${this.deps.appSlug}[bot]`.toLowerCase() &&
            comment.body?.split('\n').includes(marker)
        )
      )
        return true
      path = result.nextPath
    }
    if (path) throw new Error('kanban: comment recovery exceeded the page bound')
    return false
  }
}
