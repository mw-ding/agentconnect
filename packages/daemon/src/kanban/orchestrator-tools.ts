// The daemon files masked issue text directly; the CP only registers metadata under the trusted caller identity.
import { createHash } from 'node:crypto'
import {
  kanbanCardKeyMarker,
  kanbanOrchestrateCardKey,
  type KanbanOrchestrate,
  type KanbanOrchestrateOk,
  type KanbanOrchestrateRefusalCode
} from '@agentconnect.md/protocol'
import {
  loadPendingJournal,
  savePendingJournal,
  type PendingCreateMap,
  type PendingJournalLog
} from './pending-journal.js'

export interface KanbanOrchestratorToolsDeps {
  /** D→C `kanban/orchestrate`; rejects when the CP is unreachable. */
  orchestrate(payload: KanbanOrchestrate): Promise<KanbanOrchestrateOk>
  /** Resolves a board id to `owner/repo` (via list), or returns the string as-is when it is already `owner/repo`. */
  repoFullNameFor(agentId: string, board: string): Promise<string | null>
  // Look up a durable B1 marker on GitHub before creating another issue after a crash.
  findIssue(
    agentId: string,
    repoFullName: string,
    marker: string,
    appLogin?: string | null,
    rejected?: number[]
  ): Promise<number | null>
  invalidateToken?(agentId: string, repoFullName: string): void
  invalidateAllTokens?(agentId: string): void
  /** Files the issue with the orchestrator's issues-only token; returns the new issue number. */
  fileIssue(agentId: string, repoFullName: string, title: string, body: string): Promise<number>
  // Durable copy of the pending map; loaded at construction, saved on every mutation.
  journalPath?: string
  log?: PendingJournalLog
  // Clock for pending-create expiry, injectable for tests.
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

export const KANBAN_ORCHESTRATE_REFUSAL_TEXT: Record<KanbanOrchestrateRefusalCode, string> = {
  not_orchestrator: 'this agent is not the orchestrator of that board',
  board_not_found: 'no such board (or it belongs to another organization)',
  board_disabled: 'that board is disabled',
  epic_not_found: 'the epic is not a card on this board',
  epic_budget_exhausted: 'the epic has reached its card budget',
  card_not_found: 'no card on this board has that issue number',
  issue_not_found: 'the issue was not found on GitHub (or is a pull request)',
  issue_not_from_app: "the issue was not filed by this deployment's App",
  unknown_agent: 'the assignee slug does not name an agent in this organization',
  agent_not_assignable: 'the assignee is a restricted agent and cannot be assigned',
  key_conflict: 'the card already carries a different idempotency key',
  issue_mismatch: 'the issue number belongs to a different GitHub issue',
  invalid_link:
    'that link is a self-link, a cycle, a re-parent of a card that already has an epic, or GitHub refused it',
  cross_repo: "that blocker is not a card on this board's repository",
  repo_mismatch: 'the board now watches a different repository; list the board again',
  status_not_allowed: 'an orchestrator may only file a card into triage or todo',
  card_conflict: 'the card changed while this ran; read it again and retry',
  github_unavailable: 'GitHub is unavailable right now',
  github_partial: 'the card was registered but some GitHub metadata writes failed (safe to retry)'
}

// Entries older than this are pruned, so a journal lost longer ago can hide nothing.
const PENDING_TTL_MS = 60 * 60 * 1000
// GitHub's issue listing can trail a landed POST by this long.
const MARKER_LISTING_LAG_MS = 60_000

const refusalText = (code: KanbanOrchestrateRefusalCode): string => KANBAN_ORCHESTRATE_REFUSAL_TEXT[code] ?? code

/** sha256 over the masked title and body; the CP keys the B1 idempotency record on this, so no spec text crosses. */
export function orchestratorSpecDigest(title: string, body: string): string {
  return createHash('sha256').update(`${title}\n${body}`).digest('hex')
}

// Agent text cannot impersonate a daemon-issued trailing recovery marker.
export function neutralizeKanbanMarkers(text: string): string {
  return text.replace(/<!--\s*agentconnect\s*:\s*kanban-card-key\s*:/gi, '[agentconnect kanban-card-key:')
}

export class KanbanOrchestratorTools {
  // Retain filed issues briefly so a failed commit can retry without a second POST.
  private readonly pending: PendingCreateMap
  private readonly boardRepos = new Map<string, string>()
  // When a corrupt journal was loaded; any POST it hid landed before this.
  private lostJournalAt: number | undefined

  constructor(private readonly deps: KanbanOrchestratorToolsDeps) {
    // A restart rebuilds the toolset, so the journal restores the pending map first.
    this.pending = loadPendingJournal(deps.journalPath, deps.log, this.now())
    if (this.pending.unknown) this.lostJournalAt = this.now()
    this.prunePending()
  }

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
    this.prunePending()
    req = { ...req, title: neutralizeKanbanMarkers(req.title), body: neutralizeKanbanMarkers(req.body) }
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
    const mapKey = JSON.stringify([req.agentId, req.board, req.epic ?? null, req.step ?? 'default', specDigest])
    if (!prepare.ok) {
      this.revokeToken(req.agentId, req.board, prepare.code)
      if (prepare.code !== 'github_unavailable' && prepare.code !== 'github_partial') {
        this.pending.delete(mapKey)
        this.saveJournal()
      }
      return { refused: refusalText(prepare.code) }
    }
    const prepared = prepare as OkOf<'prepare_create'>
    if (prepared.verdict === 'existing' && this.pending.get(mapKey)?.issueNumber !== prepared.issueNumber) {
      return { existing: true, issueNumber: prepared.issueNumber }
    }
    const repoFullName = await this.deps.repoFullNameFor(req.agentId, req.board)
    if (!repoFullName) return { refused: 'could not resolve the board repository' }
    this.boardRepos.set(JSON.stringify([req.agentId, req.board]), repoFullName)
    const pending = this.pending.get(mapKey)
    let issueNumber = pending?.issueNumber
    if (issueNumber == null) {
      const marker = kanbanCardKeyMarker(
        kanbanOrchestrateCardKey({
          boardId: req.board,
          epicIssueNumber: req.epic,
          step: req.step ?? 'default',
          specDigest
        })
      )
      const intent = pending?.issueNumber === null
      const lostAge = this.lostJournalAge()
      const recovery = intent || lostAge !== undefined
      const rejectedIssueNumbers = pending?.rejectedIssueNumbers
      this.pending.set(mapKey, {
        issueNumber: null,
        startedAt: pending?.issueNumber === null ? pending.startedAt : this.now(),
        ...(rejectedIssueNumbers ? { rejectedIssueNumbers } : {})
      })
      this.prunePending()
      if (!this.saveJournal()) return { refused: 'could not persist the issue create intent', retryable: true }
      let found: number | null = null
      if (recovery) {
        found = await this.deps.findIssue(req.agentId, repoFullName, marker, prepared.appLogin, rejectedIssueNumbers)
        // A POST may have landed but still be invisible; a lost journal stops hiding one once the lag has passed.
        if (found === null && (intent || lostAge! < MARKER_LISTING_LAG_MS)) {
          if (!intent) {
            this.pending.delete(mapKey)
            this.saveJournal()
          }
          return { refused: refusalText('github_unavailable'), retryable: true }
        }
      }
      issueNumber =
        found ?? (await this.deps.fileIssue(req.agentId, repoFullName, req.title, `${req.body}\n\n${marker}`))
      this.pending.set(mapKey, {
        issueNumber,
        filedAt: this.now(),
        ...(found !== null ? { lookedUp: true } : {}),
        ...(rejectedIssueNumbers ? { rejectedIssueNumbers } : {})
      })
      this.saveJournal()
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
        this.saveJournal()
        return { created: true, cardId: commit.cardId, issueNumber: commit.issueNumber, repoFullName }
      }
      // github_partial is safe to retry: the card exists, so keep the pending map for the next commit.
      if (commit.code === 'github_partial') {
        return { created: true, issueNumber, repoFullName, partial: true, retryable: true }
      }
      this.revokeToken(req.agentId, req.board, commit.code)
      if (commit.code === 'github_unavailable') {
        return { filed: true, issueNumber, repoFullName, refused: refusalText(commit.code), retryable: true }
      }
      const entry = this.pending.get(mapKey)
      if (
        entry?.issueNumber !== null &&
        entry?.lookedUp &&
        ['issue_not_from_app', 'issue_mismatch', 'key_conflict'].includes(commit.code)
      ) {
        this.pending.set(mapKey, {
          issueNumber: null,
          startedAt: this.now(),
          rejectedIssueNumbers: [...(entry.rejectedIssueNumbers ?? []), issueNumber].slice(-300)
        })
      } else {
        this.pending.delete(mapKey)
      }
      this.saveJournal()
      return { refused: refusalText(commit.code) }
    } catch {
      // The CP went away after the file; the pending map keeps the issue for a retry.
      return { filed: true, issueNumber, repoFullName, retryable: true }
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  // How long ago a corrupt journal was loaded, until its lost entries would have expired.
  private lostJournalAge(): number | undefined {
    if (this.lostJournalAt === undefined) return undefined
    const age = this.now() - this.lostJournalAt
    if (age <= PENDING_TTL_MS) return age
    this.lostJournalAt = undefined
    return undefined
  }

  private revokeToken(agentId: string, board: string, code: KanbanOrchestrateRefusalCode): void {
    if (code !== 'not_orchestrator' && code !== 'board_disabled') return
    const repo = this.boardRepos.get(JSON.stringify([agentId, board]))
    if (repo) this.deps.invalidateToken?.(agentId, repo)
    else this.deps.invalidateAllTokens?.(agentId)
  }

  private saveJournal(): boolean {
    return savePendingJournal(this.deps.journalPath, this.pending, this.deps.log)
  }

  private prunePending(): void {
    const now = this.now()
    for (const [key, entry] of this.pending) {
      if (now - (entry.issueNumber === null ? entry.startedAt : entry.filedAt) > PENDING_TTL_MS)
        this.pending.delete(key)
    }
    // Map insertion order keeps eviction tied to the file time, even after retries.
    while (this.pending.size > 256) this.pending.delete(this.pending.keys().next().value!)
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
