// Kanban label/close writer (issue #2 D3/D5): the only CP path that writes card metadata to GitHub, via the CP-only card token.
import { githubRequest, type FetchLike } from '../github/api.js'
import type { InstallationTokenService } from '../github/installation-token.service.js'
import type { LabelPlan, ObservedIssue } from './card-state.js'
import type { KanbanRepoRef } from './card-store.js'

export interface KanbanLabelWriterDeps {
  tokens: Pick<InstallationTokenService, 'mintKanbanCard'>
  fetchImpl?: FetchLike
  baseUrl?: string
}

export class KanbanLabelWriter {
  constructor(private readonly deps: KanbanLabelWriterDeps) {}

  /** One PATCH replaces labels and issue state together, so GitHub never shows zero or two status labels mid-write. */
  async apply(repo: KanbanRepoRef, issueNumber: number, observed: ObservedIssue, plan: LabelPlan): Promise<void> {
    const labelsChanged = plan.addLabels.length > 0 || plan.removeLabels.length > 0
    if (!labelsChanged && !plan.issueState && !plan.comment) return
    const grant = await this.deps.tokens.mintKanbanCard(repo.installationId, repo.repoFullName, repo.repoId, 'write')
    const call = (path: string, method: 'PATCH' | 'POST', body: unknown) =>
      githubRequest<unknown>(`/repositories/${repo.repoId}/issues/${issueNumber}${path}`, {
        method,
        auth: grant.token,
        body,
        fetchImpl: this.deps.fetchImpl,
        baseUrl: this.deps.baseUrl
      })

    const patch: Record<string, unknown> = {}
    if (labelsChanged) {
      const removed = new Set(plan.removeLabels)
      patch.labels = [...new Set([...observed.labels.filter((l) => !removed.has(l)), ...plan.addLabels])]
    }
    if (plan.issueState?.state === 'closed') {
      patch.state = 'closed'
      patch.state_reason = plan.issueState.reason
    } else if (plan.issueState?.state === 'open') {
      patch.state = 'open'
      patch.state_reason = 'reopened'
    }
    if (Object.keys(patch).length > 0) await call('', 'PATCH', patch)
    if (plan.comment) await call('/comments', 'POST', { body: plan.comment })
  }
}
