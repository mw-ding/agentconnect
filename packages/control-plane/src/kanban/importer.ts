// Import only status-labeled issues; author permission is read live and unknown authority stays in triage.
import { checkWriteAccess, type RepoPermissionLookup } from '../github/repo-permission.js'
import type { KanbanBoardRecord, KanbanCardRepo, KanbanInitialStatus } from '../persistence/ports.js'
import { parseAgentLabel } from './agent-label.js'
import { observedCardStatus, planStatusWrite, STATUS_LABEL_PREFIX } from './card-state.js'
import type { CardStore, KanbanRepoRef } from './card-store.js'

export interface KanbanImporterDeps {
  cards: Pick<KanbanCardRepo, 'findByIssueNumber' | 'upsertCard' | 'resolveAgentSlug'>
  store: Pick<CardStore, 'readCard' | 'applyPlan'>
  permissions: RepoPermissionLookup
}

export class KanbanImporter {
  constructor(private readonly deps: KanbanImporterDeps) {}

  // Returns true when this delivery imported a candidate, including a concurrent create winner.
  async import(board: KanbanBoardRecord, repo: KanbanRepoRef, issueNumber: number): Promise<boolean> {
    if (await this.deps.cards.findByIssueNumber(board.id, issueNumber)) return false
    const issue = await this.deps.store.readCard(repo, issueNumber)
    if (!issue || !issue.labels.some((label) => label.startsWith(STATUS_LABEL_PREFIX))) return false
    const access = await checkWriteAccess(this.deps.permissions, repo, issue.authorLogin ?? '')
    const observed = observedCardStatus(issue)
    const status: KanbanInitialStatus = access.write && observed !== 'running' ? observed : 'triage'
    const agentLabel = parseAgentLabel(issue.labels)
    const assigneeAgentId =
      agentLabel.kind === 'agent' ? await this.deps.cards.resolveAgentSlug(board.orgId, agentLabel.slug) : null
    // A failed triage write must leave no importable DB row whose next delivery could adopt the original ready label.
    await this.deps.store.applyPlan(repo, issueNumber, issue, planStatusWrite(status, issue))
    await this.deps.cards.upsertCard({
      boardId: board.id,
      issueId: issue.issueId,
      issueNumber,
      issueNodeId: issue.nodeId,
      status,
      assigneeAgentId,
      source: 'import'
    })
    return true
  }
}
