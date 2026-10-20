// Role-gated orchestrator writes use CardStore for GitHub and the Lane 1 repo API for cards.
import {
  KANBAN_ORCHESTRATE_LIST_MAX_CARDS,
  kanbanOrchestrateCardKey,
  type KanbanOrchestrate,
  type KanbanOrchestrateOk,
  type KanbanOrchestrateRefusalCode
} from '@agentconnect.md/protocol'
import {
  statusLabel,
  planStatusWrite,
  isKanbanStatus,
  canTransition,
  type KanbanStatus,
  type LabelPlan
} from './card-state.js'
import { agentLabel, AGENT_LABEL_PREFIX } from './agent-label.js'
import { planReassign } from './reassign.js'
import { GithubApiError } from '../github/api.js'
import { InstallationTokenInvalidatedError } from '../github/installation-token.service.js'
import type { OrgId } from '../domain/ids.js'
import {
  KanbanCardUpsertError,
  type KanbanCardRepo,
  type KanbanCardUpsertErrorCode,
  type KanbanOrchestratorRepo,
  type GithubInstallationRepo
} from '../persistence/ports.js'
import type { CardStore, KanbanRepoRef, CardIssue, CardGraph } from './card-store.js'
import type { KanbanProjectHook } from './project-writer.js'

export interface KanbanOrchestratorDeps {
  cards: Pick<KanbanCardRepo, 'findByIdempotencyKey' | 'casStatus' | 'setAssignee' | 'resolveAgentSlug'>
  orchestrator: KanbanOrchestratorRepo
  store: Pick<
    CardStore,
    'readCard' | 'readGraph' | 'applyPlan' | 'addSubIssue' | 'addBlockedBy' | 'removeBlockedBy' | 'closeIssue'
  >
  installations: Pick<GithubInstallationRepo, 'liveByOrgAndAccount'>
  /** This deployment's App slug; absent (dev/E2E PAT seam) skips the issue-author fence and never closes an issue. */
  appSlug?: string
  /** Wake the board dispatcher after a reassign so the next claim opens the new run. */
  poke?: (boardId: string) => void
  log?: { warn(obj: unknown, msg?: string): void }
  // Queue committed statuses before fallible GitHub effects.
  project?: Pick<KanbanProjectHook, 'onStatusCommitted'>
}

type Op = KanbanOrchestrate['op']
type Board = { id: string; orgId: OrgId; repoId: bigint; repoFullName: string }

const refuse = (op: Op, code: KanbanOrchestrateRefusalCode): KanbanOrchestrateOk => ({ ok: false, op, code })

/** Every Lane 1 upsert refusal is an expected answer, never INTERNAL. */
const UPSERT_REFUSAL: Record<KanbanCardUpsertErrorCode, KanbanOrchestrateRefusalCode> = {
  board_not_found: 'board_not_found',
  repo_mismatch: 'repo_mismatch',
  agent_not_in_org: 'unknown_agent',
  agent_not_assignable: 'agent_not_assignable',
  invalid_status: 'status_not_allowed',
  status_not_allowed: 'status_not_allowed',
  key_conflict: 'key_conflict',
  issue_mismatch: 'issue_mismatch'
}

/** A GitHub read/write or token mint that failed; the caller maps it to unavailable or partial by what already committed. */
function isGithubFailure(err: unknown): boolean {
  return err instanceof GithubApiError || err instanceof InstallationTokenInvalidatedError
}

/** GitHub answers 422 for a duplicate edge, a cycle, and a cross-repo or over-limit dependency alike. */
const isUnprocessable = (err: unknown): boolean => err instanceof GithubApiError && err.status === 422

/** A refusal raised mid-op, after which the op answers `code` instead of continuing. */
class Refusal extends Error {
  constructor(readonly code: KanbanOrchestrateRefusalCode) {
    super(code)
  }
}

export class KanbanOrchestrator {
  constructor(private readonly deps: KanbanOrchestratorDeps) {}

  async orchestrate(orgId: OrgId, agentId: string, req: KanbanOrchestrate): Promise<KanbanOrchestrateOk> {
    try {
      switch (req.op) {
        case 'list':
          return await this.list(agentId, req)
        case 'prepare_create':
          return await this.prepareCreate(orgId, agentId, req)
        case 'commit_create':
          return await this.commitCreate(orgId, agentId, req)
        case 'link':
          return await this.link(orgId, agentId, req)
        case 'unblock':
          return await this.unblock(orgId, agentId, req)
        case 'assign':
          return await this.assign(orgId, agentId, req)
      }
    } catch (err) {
      // Expected failures are data; a DB or programming fault still surfaces as the handler's INTERNAL.
      if (err instanceof Refusal) return refuse(req.op, err.code)
      if (err instanceof KanbanCardUpsertError) return refuse(req.op, UPSERT_REFUSAL[err.code])
      if (isGithubFailure(err)) return refuse(req.op, 'github_unavailable')
      throw err
    }
  }

  /** The board repo this agent orchestrates in its org, for the daemon's issue-file grant; null when none matches. */
  orchestratorRepoId(agentId: string, orgId: string, repoFullName: string): Promise<bigint | null> {
    return this.deps.orchestrator.orchestratorRepoId(agentId, orgId, repoFullName)
  }

  private async list(agentId: string, req: Extract<KanbanOrchestrate, { op: 'list' }>): Promise<KanbanOrchestrateOk> {
    const { truncated, boards } = await this.deps.orchestrator.orchestratorBoards(
      agentId,
      req.boardId,
      isKanbanStatus(req.status ?? '') ? req.status : undefined,
      KANBAN_ORCHESTRATE_LIST_MAX_CARDS
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
    // B1 first: a re-plan of an already-filed card is answered before the epic or its budget is even looked at.
    const existing = await this.deps.cards.findByIdempotencyKey(req.boardId, kanbanOrchestrateCardKey(req))
    if (existing) {
      return {
        ok: true,
        op: 'prepare_create',
        verdict: 'existing',
        issueNumber: existing.issueNumber,
        appLogin: this.appLogin()
      }
    }
    if (req.epicIssueNumber !== undefined) {
      const budget = await this.deps.orchestrator.epicBudget(req.boardId, req.epicIssueNumber)
      if (budget === 'epic_not_found') return refuse('prepare_create', 'epic_not_found')
      if (budget === 'epic_budget_exhausted') {
        await this.moveEpicToTriage(board.board, req.epicIssueNumber)
        return refuse('prepare_create', 'epic_budget_exhausted')
      }
    }
    // Resolve the assignee slug up front so a bad one refuses before anything is filed.
    if (req.assignee !== undefined) await this.assigneeId(orgId, req.assignee)
    return { ok: true, op: 'prepare_create', verdict: 'proceed', appLogin: this.appLogin() }
  }

  private appLogin(): string | null {
    return this.deps.appSlug ? `${this.deps.appSlug}[bot]` : null
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
    // A crash orphan may already be closed; keep its state and the App author fence when adopting it.
    const issue = await this.deps.store.readCard(repo, req.issueNumber)
    if (!issue) return refuse('commit_create', 'issue_not_found')
    if (this.deps.appSlug && !this.authoredByApp(issue, this.deps.appSlug)) {
      return refuse('commit_create', 'issue_not_from_app')
    }
    // No App slug (dev/E2E PAT seam): the author fence is skipped — the PAT mints every token, so there is no bot actor.
    if ((req.blockedBy ?? []).includes(req.issueNumber)) return refuse('commit_create', 'invalid_link')
    const blockers = await this.resolveBlockers(req.boardId, req.blockedBy ?? [])
    if (blockers === 'card_not_found') return refuse('commit_create', 'card_not_found')
    const assigneeAgentId = req.assignee !== undefined ? await this.assigneeId(orgId, req.assignee) : null

    const result = await this.deps.orchestrator.createEpicChild({
      boardId: req.boardId,
      ...(req.epicIssueNumber !== undefined ? { epicIssueNumber: req.epicIssueNumber } : {}),
      upsert: {
        boardId: req.boardId,
        expectedRepoId: board.board.repoId,
        issueId: issue.issueId,
        issueNumber: req.issueNumber,
        issueNodeId: issue.nodeId,
        idempotencyKey: kanbanOrchestrateCardKey(req),
        status: req.status ?? 'todo',
        ...(assigneeAgentId ? { assigneeAgentId } : {}),
        ...(req.priority !== undefined ? { priority: req.priority } : {}),
        source: 'orchestrator',
        actorAgentId: agentId
      }
    })
    if (!result.ok) {
      // B2 tripped at commit (or the epic vanished): close the issue this create filed and move the epic to triage.
      await this.closeFiledOrphan(repo, req.boardId, issue)
      if (result.reason === 'epic_budget_exhausted' && req.epicIssueNumber !== undefined) {
        await this.moveEpicToTriage(board.board, req.epicIssueNumber)
      }
      return refuse('commit_create', result.reason)
    }
    const card = result.card
    if (result.created) this.deps.project?.onStatusCommitted({ boardId: req.boardId, issueNumber: card.issueNumber })
    if (result.matchedBy === 'idempotency_key' && card.issueNumber !== req.issueNumber) {
      // A concurrent create won the key; close our duplicate and return the winner.
      await this.closeFiledOrphan(repo, req.boardId, issue)
      return { ok: true, op: 'commit_create', cardId: card.id, issueNumber: card.issueNumber }
    }
    try {
      await this.applyCreateLabels(repo, issue, req.status ?? 'todo', req.assignee, assigneeAgentId)
      const parent =
        req.epicIssueNumber !== undefined
          ? await this.deps.orchestrator.cardByIssueNumber(req.boardId, req.epicIssueNumber)
          : undefined
      await this.writeEdges(repo, req.issueNumber, issue.issueId, parent ?? undefined, blockers)
    } catch (err) {
      if (err instanceof Refusal) return refuse('commit_create', err.code)
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
    if ((req.blockedBy ?? []).includes(req.issueNumber)) return refuse('link', 'invalid_link')
    const targets = await this.resolveBlockers(req.boardId, req.blockedBy ?? [])
    if (targets === 'card_not_found') return refuse('link', 'card_not_found')
    let parent: { issueNumber: number } | undefined
    if (req.parentIssueNumber !== undefined) {
      if (req.parentIssueNumber === req.issueNumber) return refuse('link', 'invalid_link')
      const epic = await this.deps.orchestrator.cardByIssueNumber(req.boardId, req.parentIssueNumber)
      if (!epic) return refuse('link', 'card_not_found')
      // Self-parents, cycles, and re-parents are refused under the board's epic-link lock by a bounded chain walk.
      const adopted = await this.deps.orchestrator.adoptEpic({
        cardId: card.cardId,
        epicIssueNumber: req.parentIssueNumber
      })
      if (!adopted.ok) {
        if (adopted.reason === 'epic_budget_exhausted') await this.moveEpicToTriage(board.board, req.parentIssueNumber)
        return refuse('link', adopted.reason)
      }
      parent = epic
    }
    try {
      // The DB epic link alone is invisible on GitHub; mirror it as a native sub-issue.
      await this.writeEdges(repo, req.issueNumber, card.issueId, parent, targets)
    } catch (err) {
      if (err instanceof Refusal) return refuse('link', err.code)
      this.deps.log?.warn({ err, boardId: req.boardId, issueNumber: req.issueNumber }, 'kanban: link github partial')
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
    const graph = await this.deps.store.readGraph(repo, req.issueNumber)
    const named = req.blockers ? new Set(req.blockers) : null
    const blockers = named ? graph.blockedBy.filter((edge) => named.has(edge.number)) : graph.blockedBy
    // A named blocker past a truncated page is still addressable through its card row.
    if (named && graph.truncated) {
      for (const number of named) {
        if (blockers.some((edge) => edge.number === number)) continue
        const other = await this.deps.orchestrator.cardByIssueNumber(req.boardId, number)
        if (other) blockers.push({ issueId: other.issueId, number, repoId: null, state: 'open', stateReason: null })
      }
    }
    try {
      for (const blocker of blockers) {
        await this.deps.store.removeBlockedBy(repo, req.issueNumber, blocker.issueId).catch((err) => {
          // A concurrent unblock already removed it.
          if (!(err instanceof GithubApiError && err.status === 404)) throw err
        })
      }
    } catch {
      return refuse('unblock', 'github_partial')
    }
    // An unread page may still hold blockers, so the card keeps its status and the reply says to call again.
    const truncated = named === null && graph.truncated
    // A blocked card that nobody holds moves back to todo; promotion past todo stays with the reconciler/humans.
    let status: KanbanStatus = card.status
    if (!truncated && card.status === 'blocked' && !card.leased) {
      if (await this.deps.cards.casStatus(card.cardId, card.stateRevision, 'todo')) {
        status = 'todo'
        this.deps.project?.onStatusCommitted({ boardId: req.boardId, issueNumber: req.issueNumber })
        try {
          const observed = await this.deps.store.readCard(repo, req.issueNumber)
          if (observed) {
            await this.deps.store.applyPlan(repo, req.issueNumber, observed, planStatusWrite('todo', observed))
          }
        } catch {
          return refuse('unblock', 'github_partial')
        }
      }
    }
    return { ok: true, op: 'unblock', status, ...(truncated ? { truncated: true } : {}) }
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
    const targetAgentId = req.assignee === null ? null : await this.assigneeId(orgId, req.assignee)
    const result = await this.deps.cards.setAssignee({
      cardId: card.cardId,
      agentId: targetAgentId,
      onLease: 'revoke',
      now: new Date(),
      source: 'orchestrator',
      actorAgentId: agentId
    })
    if (!result.ok) {
      if (result.reason === 'agent_not_assignable') return refuse('assign', 'agent_not_assignable')
      if (result.reason === 'agent_not_in_org') return refuse('assign', 'unknown_agent')
      if (result.reason === 'not_found') return refuse('assign', 'card_not_found')
      // stale / leased: the card moved under us (a revoke never answers leased, but stay total).
      return refuse('assign', 'card_conflict')
    }
    if (!result.changed) return { ok: true, op: 'assign', assigned: result.card.assigneeAgentId !== null }
    if (result.card.status !== card.status) {
      this.deps.project?.onStatusCommitted({ boardId: req.boardId, issueNumber: req.issueNumber })
    }
    // The reassign already committed; the poke must not wait on (or be lost to) a GitHub label failure.
    if (result.revokedLease) this.deps.poke?.(req.boardId)
    try {
      const observed = await this.deps.store.readCard(repo, req.issueNumber)
      if (observed) {
        const keep = req.assignee ? agentLabel(req.assignee) : null
        // A revoked running card restarted as ready, so its status label moves with the assignee label.
        const moved = result.card.status !== card.status ? planStatusWrite(result.card.status, observed) : null
        const plan: LabelPlan = {
          outcome: 'accepted',
          status: result.card.status,
          releaseLease: false,
          addLabels: [...(moved?.addLabels ?? []), ...(keep ? [keep] : [])],
          removeLabels: [
            ...(moved?.removeLabels ?? []),
            ...observed.labels.filter(
              (l) => l.toLowerCase().startsWith(AGENT_LABEL_PREFIX) && l.toLowerCase() !== keep?.toLowerCase()
            )
          ]
        }
        if (result.revokedLease) {
          plan.comment = this.reassignComment(repo, card, result.revokedLease, targetAgentId, req.assignee)
        }
        await this.deps.store.applyPlan(repo, req.issueNumber, observed, plan)
      }
    } catch (err) {
      if (!isGithubFailure(err)) throw err
      return refuse('assign', 'github_partial')
    }
    return { ok: true, op: 'assign', assigned: targetAgentId !== null }
  }

  /** The Lane 1 recipe's fixed reassign comment, rendered by planReassign; names are agent slugs, never agent text. */
  private reassignComment(
    repo: KanbanRepoRef,
    card: { cardId: string; status: KanbanStatus; issueNumber: number; assigneeSlug: string | null },
    lease: { leaseId: string; agentId: string; daemonId: string; dispatchRevision: bigint },
    toAgentId: string | null,
    toSlug: string | null
  ): string | undefined {
    const plan = planReassign(
      {
        cardId: card.cardId,
        status: card.status,
        dispatchRevision: lease.dispatchRevision,
        sessionKey: `github:${repo.repoId}#${card.issueNumber}`,
        lease
      },
      // The restart is placed by the next claim, so no target daemon is known here; '' never equals a lease's.
      { agentId: toAgentId ?? '', daemonId: '' },
      { fromName: card.assigneeSlug ?? 'nobody', toName: toSlug ?? 'nobody' }
    )
    const step = plan.steps.find((s) => s.kind === 'post_comment')
    return step?.kind === 'post_comment' ? step.body : undefined
  }

  /** Add the sub-issue and blocked_by edges the live graph lacks; a 422 is invalid_link unless a re-read shows the edge. */
  private async writeEdges(
    repo: KanbanRepoRef,
    issueNumber: number,
    issueId: bigint,
    parent: { issueNumber: number } | undefined,
    blockers: Array<{ issueNumber: number; issueId: bigint }>
  ): Promise<void> {
    if (!parent && blockers.length === 0) return
    let graph = await this.deps.store.readGraph(repo, issueNumber)
    const hasParent = (g: CardGraph) => g.parent?.number === parent?.issueNumber
    const hasBlocker = (g: CardGraph, id: bigint) => g.blockedBy.some((edge) => edge.issueId === id)
    if (parent && !hasParent(graph)) {
      // A different GitHub parent is a re-parent this surface never does (the DB refused it the same way).
      if (graph.parent) throw new Refusal('invalid_link')
      try {
        await this.deps.store.addSubIssue(repo, parent.issueNumber, issueId)
      } catch (err) {
        if (!isUnprocessable(err)) throw err
        graph = await this.deps.store.readGraph(repo, issueNumber)
        if (!hasParent(graph)) throw new Refusal('invalid_link')
      }
    }
    for (const blocker of blockers) {
      if (hasBlocker(graph, blocker.issueId)) continue
      try {
        await this.deps.store.addBlockedBy(repo, issueNumber, blocker.issueId)
      } catch (err) {
        if (!isUnprocessable(err)) throw err
        // The edge may have landed concurrently; otherwise GitHub refused it (a cycle, say).
        graph = await this.deps.store.readGraph(repo, issueNumber)
        if (!hasBlocker(graph, blocker.issueId)) throw new Refusal('invalid_link')
      }
    }
  }

  private authoredByApp(issue: CardIssue, appSlug: string): boolean {
    return issue.authorType === 'Bot' && issue.authorLogin?.toLowerCase() === `${appSlug}[bot]`.toLowerCase()
  }

  /** Close an issue only when this create path filed it: the App authored it and no card on the board claims it. */
  private async closeFiledOrphan(repo: KanbanRepoRef, boardId: string, issue: CardIssue): Promise<void> {
    // Without an App slug (the PAT seam) authorship is unprovable, so nothing is ever closed.
    if (!this.deps.appSlug || !this.authoredByApp(issue, this.deps.appSlug)) return
    if (await this.deps.orchestrator.cardByIssueNumber(boardId, issue.number)) return
    await this.deps.store.closeIssue(repo, issue.number).catch((err) => {
      this.deps.log?.warn({ err, boardId, issueNumber: issue.number }, 'kanban: orphan issue close failed')
    })
  }

  /** Blockers must be cards on this board (same repo), deduped; their numeric issue ids feed the dependency writes. */
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

  /** The Lane 1 assignee policy (`resolveAgentSlug`); a null answer is explained as unknown vs restricted. */
  private async assigneeId(orgId: OrgId, slug: string): Promise<string> {
    const agentId = await this.deps.cards.resolveAgentSlug(orgId, slug)
    if (agentId) return agentId
    throw new Refusal(await this.deps.orchestrator.unassignableReason(orgId, slug))
  }

  private async repoRef(board: Board): Promise<KanbanRepoRef | null> {
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

  /** B2 exhausted: move the epic to triage if it is unleased and the move is allowed; a leased epic is only refused. */
  private async moveEpicToTriage(board: Board, epicIssueNumber: number): Promise<void> {
    const epic = await this.deps.orchestrator.cardByIssueNumber(board.id, epicIssueNumber)
    if (!epic || epic.leased || epic.status === 'triage' || !canTransition(epic.status, 'triage')) return
    if (!(await this.deps.cards.casStatus(epic.cardId, epic.stateRevision, 'triage'))) return
    this.deps.project?.onStatusCommitted({ boardId: board.id, issueNumber: epicIssueNumber })
    // The refusal is the answer; a label mirror lost here is repaired by the graph reconciler.
    try {
      const repo = await this.repoRef(board)
      if (!repo) return
      const observed = await this.deps.store.readCard(repo, epicIssueNumber)
      if (observed) {
        await this.deps.store.applyPlan(repo, epicIssueNumber, observed, planStatusWrite('triage', observed))
      }
    } catch (err) {
      if (!isGithubFailure(err)) throw err
      this.deps.log?.warn({ err, boardId: board.id, epicIssueNumber }, 'kanban: epic triage label write failed')
    }
  }
}
