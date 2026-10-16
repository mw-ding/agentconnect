// Kanban label/close writer (issue #2 D3/D5): the only CP path that writes card metadata to GitHub, via the CP-only card token.
import { GithubApiError, githubRequest, type FetchLike } from '../github/api.js'
import type { InstallationTokenService } from '../github/installation-token.service.js'
import type { LabelPlan, ObservedIssue } from './card-state.js'
import type { KanbanRepoRef, LabelWriteObserver } from './card-store.js'

export interface KanbanLabelWriterDeps {
  tokens: Pick<InstallationTokenService, 'mintKanbanCard'>
  fetchImpl?: FetchLike
  baseUrl?: string
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
    let serverDate: Date | null = null
    const fetchImpl: FetchLike = async (url, init) => {
      const response = await (this.deps.fetchImpl ?? fetch)(url, init)
      const date = response.headers.get('date')
      serverDate = date && Number.isFinite(Date.parse(date)) ? new Date(date) : null
      return response
    }
    const call = (path: string, method: 'PATCH' | 'POST' | 'DELETE', body?: unknown) =>
      githubRequest<unknown>(`/repositories/${repo.repoId}/issues/${issueNumber}${path}`, {
        method,
        auth: grant.token,
        body,
        fetchImpl,
        baseUrl: this.deps.baseUrl
      })

    // Add before remove so GitHub never shows zero status labels mid-write. The observer runs before the removal.
    for (const label of new Set(plan.addLabels)) {
      await call('/labels', 'POST', { labels: [label] })
      await onLabelAdded?.(label, serverDate)
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
    if (plan.comment) await call('/comments', 'POST', { body: plan.comment })
  }
}
