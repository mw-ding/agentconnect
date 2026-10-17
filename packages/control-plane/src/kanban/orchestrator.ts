// Kanban orchestrator service (issue #2 M3, Lane 2b): the role-gated create/link/unblock/assign surface for the
// orchestrator agent. Every GitHub write goes through CardStore; every card write through the Lane 1 repo API.
import type { KanbanOrchestrate, KanbanOrchestrateOk, KanbanOrchestrateRefusalCode } from '@agentconnect.md/protocol'
import { cardIdempotencyKey } from './card-key.js'
import {
  statusLabel,
  planStatusWrite,
  isKanbanStatus,
  canTransition,
  type KanbanStatus,
  type LabelPlan
} from './card-state.js'
import { agentLabel, AGENT_LABEL_PREFIX } from './agent-label.js'
import { GithubApiError } from '../github/api.js'
import type { OrgId } from '../domain/ids.js'
import type { KanbanCardRepo, KanbanOrchestratorRepo, GithubInstallationRepo } from '../persistence/ports.js'
import type { CardStore, KanbanRepoRef, CardIssue } from './card-store.js'

export interface KanbanOrchestratorDeps {
  cards: KanbanCardRepo
  orchestrator: KanbanOrchestratorRepo
  store: Pick<
    CardStore,
    'readCard' | 'readGraph' | 'applyPlan' | 'addSubIssue' | 'addBlockedBy' | 'removeBlockedBy' | 'closeIssue'
  >
  installations: Pick<GithubInstallationRepo, 'liveByOrgAndAccount'>
  /** This deployment's App slug; absent (dev/E2E PAT seam) skips the issue-author fence. */
  appSlug?: string
  /** Wake the board dispatcher after a reassign so the next claim opens the new run. */
  poke?: (boardId: string) => void
  log?: { warn(obj: unknown, msg?: string): void }
}

const refuse = (op: KanbanOrchestrate['op'], code: KanbanOrchestrateRefusalCode): KanbanOrchestrateOk => ({
  ok: false,
  op,
  code
})

/** GitHub 422 means the link already exists; that is success, not a conflict. */
function isDuplicate(err: unknown): boolean {
  return err instanceof GithubApiError && err.status === 422
}

export class KanbanOrchestrator {
  constructor(private readonly deps: KanbanOrchestratorDeps) {}

  orchestrate(orgId: OrgId, agentId: string, req: KanbanOrchestrate): Promise<KanbanOrchestrateOk> {
    switch (req.op) {
      case 'list':
        return this.list(agentId, req)
      case 'prepare_create':
        return this.prepareCreate(orgId, agentId, req)
      case 'commit_create':
        return this.commitCreate(orgId, agentId, req)
      case 'link':
        return this.link(orgId, agentId, req)
      case 'unblock':
        return this.unblock(orgId, agentId, req)
      case 'assign':
        return this.assign(orgId, agentId, req)
    }
  }

  /** The board repo this agent orchestrates, for the daemon's issue-file grant; null when no enabled board matches. */
  orchestratorRepoId(agentId: string, repoFullName: string): Promise<bigint | null> {
    return this.deps.orchestrator.orchestratorRepoId(agentId, repoFullName)
  }

  private async list(agentId: string, req: Extract<KanbanOrchestrate, { op: 'list' }>): Promise<KanbanOrchestrateOk> {
    const { truncated, boards } = await this.deps.orchestrator.orchestratorBoards(
      agentId,
      req.boardId,
      isKanbanStatus(req.status ?? '') ? req.status : undefined,
      200
    )
    return { ok: true, op: 'list', truncated, boards }
  }

  private async prepareCreate(
    orgId: OrgId,
    agentId: string,
    req: Extract<KanbanOrchestrate, { op: 'prepare_create' }>
  ): Promise<KanbanOrchestrateOk> {
    const board = await this.deps.orchestrator.boardForOrchestrator(agentId, orgId, req.boardId)
    if (!board.ok) return refuse('prepare_create', board.reason)
    // Resolve the epic first: it must be a card on this board (existence, not the budget yet).
    if (req.epicIssueNumber !== undefined) {
      const epic = await this.deps.orchestrator.cardByIssueNumber(req.boardId, req.epicIssueNumber)
      if (!epic) return refuse('prepare_create', 'epic_not_found')
    }
    const key = cardIdempotencyKey({
      epic: String(req.epicIssueNumber ?? `board:${req.boardId}`),
      step: req.step,
      spec: req.specDigest
    })
    const existing = await this.deps.cards.findByIdempotencyKey(req.boardId, key)
    if (existing) {
      return { ok: true, op: 'prepare_create', verdict: 'existing', issueNumber: existing.issueNumber }
    }
    // B2 is checked before anything is filed; the epic's budget never blocks a replay of an existing key.
    if (req.epicIssueNumber !== undefined) {
      const budget = await this.deps.orchestrator.epicBudget(req.boardId, req.epicIssueNumber)
      if (budget === 'epic_not_found') return refuse('prepare_create', 'epic_not_found')
      if (budget === 'epic_budget_exhausted') {
        await this.moveEpicToTriage(board.board, req.epicIssueNumber)
        return refuse('prepare_create', 'epic_budget_exhausted')
      }
    }
    // Resolve the assignee slug up front so a bad one refuses before anything is filed.
    if (req.assignee !== undefined) {
      const resolved = await this.deps.orchestrator.resolveAssignee(orgId, req.assignee)
      if (!resolved.ok) return refuse('prepare_create', resolved.reason)
    }
    return { ok: true, op: 'prepare_create', verdict: 'proceed' }
  }

  private async commitCreate(
    orgId: OrgId,
    agentId: string,
    req: Extract<KanbanOrchestrate, { op: 'commit_create' }>
  ): Promise<KanbanOrchestrateOk> {
    const board = await this.deps.orchestrator.boardForOrchestrator(agentId, orgId, req.boardId)
    if (!board.ok) return refuse('commit_create', board.reason)
    const repo = await this.repoRef(board.board)
    if (!repo) return refuse('commit_create', 'github_unavailable')
    // The issue must be real, open, and filed by the App bot (when an App slug is configured).
    const issue = await this.deps.store.readCard(repo, req.issueNumber)
    if (!issue) return refuse('commit_create', 'issue_not_found')
    if (issue.state !== 'open') return refuse('commit_create', 'issue_not_found')
    if (this.deps.appSlug && !this.authoredByApp(issue, this.deps.appSlug)) {
      return refuse('commit_create', 'issue_not_from_app')
    }
    // No App slug (dev/E2E PAT seam): the author fence is skipped — the PAT mints every token, so there is no bot actor.
    if ((req.blockedBy ?? []).includes(req.issueNumber)) return refuse('commit_create', 'invalid_link')
    const blockers = await this.resolveBlockers(req.boardId, req.blockedBy ?? [])
    if (blockers === 'card_not_found') return refuse('commit_create', 'card_not_found')
    // GitHub's sub-issue and dependency writes take the epic's numeric issue id, so resolve it before the DB write.
    const epicIssueId =
      req.epicIssueNumber !== undefined
        ? (await this.deps.orchestrator.cardByIssueNumber(req.boardId, req.epicIssueNumber))?.issueId
        : undefined
    const assigneeAgentId = req.assignee !== undefined ? await this.assigneeId(orgId, req.assignee) : null
    if (assigneeAgentId === 'unknown_agent') return refuse('commit_create', 'unknown_agent')
    if (assigneeAgentId === 'agent_not_assignable') return refuse('commit_create', 'agent_not_assignable')

    const result = await this.deps.orchestrator.createEpicChild({
      boardId: req.boardId,
      ...(req.epicIssueNumber !== undefined ? { epicIssueNumber: req.epicIssueNumber } : {}),
      upsert: {
        boardId: req.boardId,
        expectedRepoId: board.board.repoId,
        issueId: issue.issueId,
        issueNumber: req.issueNumber,
        issueNodeId: issue.nodeId,
        idempotencyKey: cardIdempotencyKey({
          epic: String(req.epicIssueNumber ?? `board:${req.boardId}`),
          step: req.step,
          spec: req.specDigest
        }),
        status: req.status ?? 'todo',
        ...(assigneeAgentId ? { assigneeAgentId } : {}),
        ...(req.priority !== undefined ? { priority: req.priority } : {}),
        source: 'orchestrator',
        actorAgentId: agentId
      }
    })
    if (!result.ok) {
      // B2 tripped at commit: the issue was already filed, so close it and move the epic to triage.
      await this.deps.store.closeIssue(repo, req.issueNumber).catch(() => undefined)
      if (result.reason === 'epic_budget_exhausted' && req.epicIssueNumber !== undefined) {
        await this.moveEpicToTriage(board.board, req.epicIssueNumber)
      }
      return refuse('commit_create', result.reason)
    }
    const card = result.card
    if (result.matchedBy === 'idempotency_key' && card.issueNumber !== req.issueNumber) {
      // A concurrent create won the key; close our duplicate and return the winner.
      await this.deps.store.closeIssue(repo, req.issueNumber).catch(() => undefined)
      return { ok: true, op: 'commit_create', cardId: card.id, issueNumber: card.issueNumber }
    }
    try {
      await this.applyCreateLabels(repo, issue, req.status ?? 'todo', req.assignee, assigneeAgentId)
      if (req.epicIssueNumber !== undefined) {
        if (epicIssueId === undefined) throw new Error('epic card vanished after commit')
        await this.deps.store.addSubIssue(repo, req.epicIssueNumber, issue.issueId).catch((err) => {
          if (!isDuplicate(err)) throw err
        })
      }
      for (const blocker of blockers) {
        await this.deps.store.addBlockedBy(repo, req.issueNumber, blocker.issueId).catch((err) => {
          if (!isDuplicate(err)) throw err
        })
      }
    } catch (err) {
      // The DB write committed; GitHub lag is a partial success, safe to retry.
      this.deps.log?.warn(
        { err, boardId: req.boardId, issueNumber: req.issueNumber },
        'kanban: commit_create github partial'
      )
      return refuse('commit_create', 'github_partial')
    }
    return { ok: true, op: 'commit_create', cardId: card.id, issueNumber: req.issueNumber }
  }

  private async link(
    orgId: OrgId,
    agentId: string,
    req: Extract<KanbanOrchestrate, { op: 'link' }>
  ): Promise<KanbanOrchestrateOk> {
    const board = await this.deps.orchestrator.boardForOrchestrator(agentId, orgId, req.boardId)
    if (!board.ok) return refuse('link', board.reason)
    const repo = await this.repoRef(board.board)
    if (!repo) return refuse('link', 'github_unavailable')
    const card = await this.deps.orchestrator.cardByIssueNumber(req.boardId, req.issueNumber)
    if (!card) return refuse('link', 'card_not_found')
    const targets: Array<{ issueNumber: number; issueId: bigint }> = []
    for (const blocker of new Set(req.blockedBy ?? [])) {
      if (blocker === req.issueNumber) return refuse('link', 'invalid_link')
      const target = await this.deps.orchestrator.cardByIssueNumber(req.boardId, blocker)
      if (!target) return refuse('link', 'card_not_found')
      targets.push({ issueNumber: target.issueNumber, issueId: target.issueId })
    }
    let parentNumber: number | undefined
    if (req.parentIssueNumber !== undefined) {
      if (req.parentIssueNumber === req.issueNumber) return refuse('link', 'invalid_link')
      const parent = await this.deps.orchestrator.cardByIssueNumber(req.boardId, req.parentIssueNumber)
      if (!parent) return refuse('link', 'card_not_found')
      // A card cannot adopt its own descendant (cycle); the parent chain is checked one hop, best-effort.
      if (parent.epicIssueNumber === req.issueNumber || parent.cardId === card.cardId)
        return refuse('link', 'invalid_link')
      const adopted = await this.deps.orchestrator.adoptEpic({
        cardId: card.cardId,
        epicIssueNumber: req.parentIssueNumber
      })
      if (!adopted.ok) return refuse('link', adopted.reason)
      parentNumber = parent.issueNumber
    }
    try {
      // The DB epic link alone is invisible on GitHub; mirror it as a native sub-issue.
      if (parentNumber !== undefined) {
        await this.deps.store.addSubIssue(repo, parentNumber, card.issueId).catch((err) => {
          if (!isDuplicate(err)) throw err
        })
      }
      for (const target of targets) {
        await this.deps.store.addBlockedBy(repo, req.issueNumber, target.issueId).catch((err) => {
          if (!isDuplicate(err)) throw err
        })
      }
    } catch (err) {
      return refuse('link', 'github_partial')
    }
    return { ok: true, op: 'link' }
  }

  private async unblock(
    orgId: OrgId,
    agentId: string,
    req: Extract<KanbanOrchestrate, { op: 'unblock' }>
  ): Promise<KanbanOrchestrateOk> {
    const board = await this.deps.orchestrator.boardForOrchestrator(agentId, orgId, req.boardId)
    if (!board.ok) return refuse('unblock', board.reason)
    const repo = await this.repoRef(board.board)
    if (!repo) return refuse('unblock', 'github_unavailable')
    const card = await this.deps.orchestrator.cardByIssueNumber(req.boardId, req.issueNumber)
    if (!card) return refuse('unblock', 'card_not_found')
    // Omitted blockers removes every blocked_by edge; named ones remove exactly those.
    // Dependency deletes are addressed by the blocker's numeric issue id, which the live graph read supplies.
    let edges: Array<{ issueId: bigint; number: number }>
    try {
      edges = (await this.deps.store.readGraph(repo, req.issueNumber)).blockedBy
    } catch {
      return refuse('unblock', 'github_unavailable')
    }
    const named = req.blockers ? new Set(req.blockers) : null
    const blockers = named ? edges.filter((edge) => named.has(edge.number)) : edges
    try {
      for (const blocker of blockers) {
        await this.deps.store.removeBlockedBy(repo, req.issueNumber, blocker.issueId).catch((err) => {
          if (!isDuplicate(err) && !(err instanceof GithubApiError && err.status === 404)) throw err
        })
      }
    } catch {
      return refuse('unblock', 'github_partial')
    }
    // A blocked card that nobody holds moves back to todo; promotion past todo stays with the reconciler/humans.
    let status: KanbanStatus = card.status
    if (card.status === 'blocked' && !card.leased) {
      if (await this.deps.cards.casStatus(card.cardId, card.stateRevision, 'todo')) {
        status = 'todo'
        const observed = await this.deps.store.readCard(repo, req.issueNumber)
        if (observed)
          await this.deps.store.applyPlan(repo, req.issueNumber, observed, planStatusWrite('todo', observed))
      }
    }
    return { ok: true, op: 'unblock', status }
  }

  private async assign(
    orgId: OrgId,
    agentId: string,
    req: Extract<KanbanOrchestrate, { op: 'assign' }>
  ): Promise<KanbanOrchestrateOk> {
    const board = await this.deps.orchestrator.boardForOrchestrator(agentId, orgId, req.boardId)
    if (!board.ok) return refuse('assign', board.reason)
    const repo = await this.repoRef(board.board)
    if (!repo) return refuse('assign', 'github_unavailable')
    const card = await this.deps.orchestrator.cardByIssueNumber(req.boardId, req.issueNumber)
    if (!card) return refuse('assign', 'card_not_found')
    const targetAgentId =
      req.assignee === null ? null : await this.deps.orchestrator.resolveAssignee(orgId, req.assignee)
    if (targetAgentId && !targetAgentId.ok) return refuse('assign', targetAgentId.reason)
    const result = await this.deps.cards.setAssignee({
      cardId: card.cardId,
      agentId: targetAgentId === null ? null : targetAgentId.agentId,
      onLease: 'revoke',
      now: new Date(),
      source: 'orchestrator',
      actorAgentId: agentId
    })
    if (!result.ok) {
      if (result.reason === 'agent_not_assignable') return refuse('assign', 'agent_not_assignable')
      if (result.reason === 'agent_not_in_org') return refuse('assign', 'unknown_agent')
      return refuse('assign', 'card_not_found')
    }
    if (!result.changed) return { ok: true, op: 'assign', assigned: result.card.assigneeAgentId !== null }
    const observed = await this.deps.store.readCard(repo, req.issueNumber)
    if (observed) {
      const toSlug = req.assignee
      const keep = toSlug ? agentLabel(toSlug) : null
      const plan: LabelPlan = {
        outcome: 'accepted',
        status: card.status,
        releaseLease: false,
        addLabels: keep ? [keep] : [],
        removeLabels: observed.labels.filter(
          (l) => l.toLowerCase().startsWith(AGENT_LABEL_PREFIX) && l.toLowerCase() !== keep?.toLowerCase()
        )
      }
      if (result.revokedLease) {
        plan.comment = `AgentConnect Kanban: reassigned from ${card.assigneeSlug ?? 'nobody'} to ${toSlug ?? 'nobody'}; restarting in a new session.`
      }
      await this.deps.store.applyPlan(repo, req.issueNumber, observed, plan)
    }
    if (result.revokedLease) this.deps.poke?.(req.boardId)
    return { ok: true, op: 'assign', assigned: targetAgentId !== null }
  }

  private authoredByApp(issue: CardIssue, appSlug: string): boolean {
    return issue.authorType === 'Bot' && issue.authorLogin?.toLowerCase() === `${appSlug}[bot]`.toLowerCase()
  }

  /** Blockers must be cards on this board (same repo); their numeric issue ids feed the dependency writes. */
  private async resolveBlockers(
    boardId: string,
    blockers: number[]
  ): Promise<Array<{ issueNumber: number; issueId: bigint }> | 'card_not_found'> {
    const resolved: Array<{ issueNumber: number; issueId: bigint }> = []
    for (const blocker of new Set(blockers)) {
      const card = await this.deps.orchestrator.cardByIssueNumber(boardId, blocker)
      if (!card) return 'card_not_found'
      resolved.push({ issueNumber: card.issueNumber, issueId: card.issueId })
    }
    return resolved
  }

  private async assigneeId(orgId: OrgId, slug: string): Promise<string | 'unknown_agent' | 'agent_not_assignable'> {
    const resolved = await this.deps.orchestrator.resolveAssignee(orgId, slug)
    return resolved.ok ? resolved.agentId : resolved.reason
  }

  private async repoRef(board: { orgId: OrgId; repoId: bigint; repoFullName: string }): Promise<KanbanRepoRef | null> {
    const owner = board.repoFullName.split('/', 1)[0]
    if (!owner) return null
    const installation = await this.deps.installations.liveByOrgAndAccount(board.orgId, owner)
    if (!installation || installation.revokedAt || installation.suspendedAt) return null
    return { installationId: installation.installationId, repoId: board.repoId, repoFullName: board.repoFullName }
  }

  private async applyCreateLabels(
    repo: KanbanRepoRef,
    issue: CardIssue,
    status: KanbanStatus,
    assigneeSlug: string | undefined,
    assigneeAgentId: string | null
  ): Promise<void> {
    const plan: LabelPlan = {
      outcome: 'accepted',
      status,
      releaseLease: false,
      addLabels:
        assigneeAgentId && assigneeSlug ? [statusLabel(status), agentLabel(assigneeSlug)] : [statusLabel(status)],
      removeLabels: []
    }
    await this.deps.store.applyPlan(repo, issue.number, issue, plan)
  }

  /** B2 exhausted: move the epic to triage (todo→triage is allowed) if it is unleased; promotion stays with humans. */
  private async moveEpicToTriage(
    board: { id: string; orgId: OrgId; repoId: bigint; repoFullName: string },
    epicIssueNumber: number
  ): Promise<void> {
    const epic = await this.deps.orchestrator.cardByIssueNumber(board.id, epicIssueNumber)
    if (!epic || epic.leased || !canTransition(epic.status, 'triage')) return
    if (!(await this.deps.cards.casStatus(epic.cardId, epic.stateRevision, 'triage'))) return
    const repo = await this.repoRef(board)
    if (!repo) return
    const observed = await this.deps.store.readCard(repo, epicIssueNumber)
    if (observed) await this.deps.store.applyPlan(repo, epicIssueNumber, observed, planStatusWrite('triage', observed))
  }
}
