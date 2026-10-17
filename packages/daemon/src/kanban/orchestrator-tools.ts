// Daemon-side Kanban orchestrator tools (issue #2 M3, Lane 2b): the daemon files the issue body directly with a
// purpose-bound token, then asks the CP to register it; the CP writes only metadata. Caller identity is the trusted ctx.
import { createHash } from 'node:crypto'
import type { KanbanOrchestrate, KanbanOrchestrateOk, KanbanOrchestrateRefusalCode } from '@agentconnect.md/protocol'

export interface KanbanOrchestratorToolsDeps {
  /** D→C `kanban/orchestrate`; rejects when the CP is unreachable. */
  orchestrate(payload: KanbanOrchestrate): Promise<KanbanOrchestrateOk>
  /** Resolves a board id to `owner/repo` (via list), or returns the string as-is when it is already `owner/repo`. */
  repoFullNameFor(agentId: string, board: string): Promise<string | null>
  /** Files the issue with the orchestrator's issues-only token; returns the new issue number. */
  fileIssue(agentId: string, repoFullName: string, title: string, body: string): Promise<number>
  /** Monotonic clock for token expiry notes, injectable for tests. */
  now?: () => number
}

type OkOf<O extends string> = Extract<KanbanOrchestrateOk, { ok: true; op: O }>

export interface KanbanCreateReq {
  agentId: string
  board: string
  title: string
  body: string
  epic?: number
  step?: string
  assignee?: string
  priority?: number
  status?: 'triage' | 'todo'
  blockedBy?: number[]
}

const REFUSAL_TEXT: Record<KanbanOrchestrateRefusalCode, string> = {
  not_orchestrator: 'this agent is not the orchestrator of that board',
  board_not_found: 'no such board (or it belongs to another organization)',
  board_disabled: 'that board is disabled',
  epic_not_found: 'the epic is not a card on this board',
  epic_budget_exhausted: 'the epic has reached its card budget',
  card_not_found: 'no card on this board has that issue number',
  issue_not_found: 'the issue was not found on GitHub (or is a pull request / closed)',
  issue_not_from_app: "the issue was not filed by this deployment's App",
  unknown_agent: 'the assignee slug does not name an agent in this organization',
  agent_not_assignable: 'the assignee is a restricted agent and cannot be assigned',
  key_conflict: 'the card already carries a different idempotency key',
  issue_mismatch: 'the issue number belongs to a different GitHub issue',
  invalid_link: 'that link would be a self-link or a cycle',
  cross_repo: "that blocker is not a card on this board's repository",
  github_unavailable: 'GitHub is unavailable right now',
  github_partial: 'the card was registered but some GitHub metadata writes failed (safe to retry)'
}

const refusalText = (code: KanbanOrchestrateRefusalCode): string => REFUSAL_TEXT[code] ?? code

/** sha256 over the masked title and body; the CP keys the B1 idempotency record on this, so no spec text crosses. */
export function orchestratorSpecDigest(title: string, body: string): string {
  return createHash('sha256').update(`${title}\n${body}`).digest('hex')
}

export class KanbanOrchestratorTools {
  /** A retry after a failed commit re-commits the same issue instead of filing a second one. */
  private readonly pending = new Map<string, number>()

  constructor(private readonly deps: KanbanOrchestratorToolsDeps) {}

  async list(req: { agentId: string; board?: string; status?: string }): Promise<unknown> {
    const reply = await this.deps.orchestrate({
      op: 'list',
      agentId: req.agentId,
      ...(req.board ? { boardId: req.board } : {}),
      ...(req.status ? { status: req.status } : {})
    })
    if (!reply.ok) return { refused: refusalText(reply.code) }
    const list = reply as OkOf<'list'>
    const boards = list.boards.map((board) => ({
      boardId: board.boardId,
      repoFullName: board.repoFullName,
      cards: board.cards.map((card) => ({
        issue: card.issueNumber,
        status: card.status,
        assignee: card.assigneeSlug ?? null,
        priority: card.priority,
        blockKind: card.blockKind,
        epic: card.epicIssueNumber,
        leased: card.leased
      }))
    }))
    return { truncated: list.truncated, boards }
  }

  async create(req: KanbanCreateReq): Promise<unknown> {
    const specDigest = orchestratorSpecDigest(req.title, req.body)
    const prepare = await this.deps.orchestrate({
      op: 'prepare_create',
      agentId: req.agentId,
      boardId: req.board,
      step: req.step ?? 'default',
      specDigest,
      ...(req.epic !== undefined ? { epicIssueNumber: req.epic } : {}),
      ...(req.assignee !== undefined ? { assignee: req.assignee } : {}),
      ...(req.priority !== undefined ? { priority: req.priority } : {}),
      ...(req.status !== undefined ? { status: req.status } : {})
    })
    if (!prepare.ok) return { refused: refusalText(prepare.code) }
    const prepared = prepare as OkOf<'prepare_create'>
    if (prepared.verdict === 'existing') {
      return { existing: true, issueNumber: prepared.issueNumber }
    }
    const repoFullName = await this.deps.repoFullNameFor(req.agentId, req.board)
    if (!repoFullName) return { refused: 'could not resolve the board repository' }
    const mapKey = `${req.board}\u0000${req.step ?? 'default'}\u0000${specDigest}`
    let issueNumber = this.pending.get(mapKey)
    if (issueNumber === undefined) {
      issueNumber = await this.deps.fileIssue(req.agentId, repoFullName, req.title, req.body)
      this.pending.set(mapKey, issueNumber)
    }
    try {
      const commit = (await this.deps.orchestrate({
        op: 'commit_create',
        agentId: req.agentId,
        boardId: req.board,
        step: req.step ?? 'default',
        specDigest,
        issueNumber,
        ...(req.epic !== undefined ? { epicIssueNumber: req.epic } : {}),
        ...(req.assignee !== undefined ? { assignee: req.assignee } : {}),
        ...(req.priority !== undefined ? { priority: req.priority } : {}),
        ...(req.status !== undefined ? { status: req.status } : {}),
        ...(req.blockedBy !== undefined && req.blockedBy.length > 0 ? { blockedBy: req.blockedBy } : {})
      })) as OkOf<'commit_create'> | Extract<KanbanOrchestrateOk, { ok: false }>
      if (commit.ok) {
        this.pending.delete(mapKey)
        return { created: true, cardId: commit.cardId, issueNumber: commit.issueNumber, repoFullName }
      }
      // github_partial is safe to retry: the card exists, so keep the pending map for the next commit.
      if (commit.code === 'github_partial') {
        return { created: true, issueNumber, repoFullName, partial: true, retryable: true }
      }
      this.pending.delete(mapKey)
      return { refused: refusalText(commit.code) }
    } catch {
      // The CP went away after the file; the pending map keeps the issue for a retry.
      return { filed: true, issueNumber, repoFullName, retryable: true }
    }
  }

  async link(req: {
    agentId: string
    board: string
    issue: number
    blockedBy?: number[]
    parent?: number
  }): Promise<unknown> {
    const reply = await this.deps.orchestrate({
      op: 'link',
      agentId: req.agentId,
      boardId: req.board,
      issueNumber: req.issue,
      ...(req.blockedBy !== undefined && req.blockedBy.length > 0 ? { blockedBy: req.blockedBy } : {}),
      ...(req.parent !== undefined ? { parentIssueNumber: req.parent } : {})
    })
    return reply.ok ? { linked: true } : { refused: refusalText(reply.code) }
  }

  async unblock(req: { agentId: string; board: string; issue: number; blockers?: number[] }): Promise<unknown> {
    const reply = await this.deps.orchestrate({
      op: 'unblock',
      agentId: req.agentId,
      boardId: req.board,
      issueNumber: req.issue,
      ...(req.blockers !== undefined ? { blockers: req.blockers } : {})
    })
    return reply.ok
      ? { unblocked: true, status: (reply as OkOf<'unblock'>).status }
      : { refused: refusalText(reply.code) }
  }

  async assign(req: { agentId: string; board: string; issue: number; assignee: string | null }): Promise<unknown> {
    const reply = await this.deps.orchestrate({
      op: 'assign',
      agentId: req.agentId,
      boardId: req.board,
      issueNumber: req.issue,
      assignee: req.assignee
    })
    return reply.ok ? { assigned: (reply as OkOf<'assign'>).assigned } : { refused: refusalText(reply.code) }
  }
}
