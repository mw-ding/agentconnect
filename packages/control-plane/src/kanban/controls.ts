// Kanban human controls (issue #2 B5): pause/resume a board, skip/restart a card; body-free, owner + interactive OIDC only.
import type {
  GithubInstallationRepo,
  KanbanBoardAdminRepo,
  KanbanBoardWriteResult,
  KanbanCardControlOutcome,
  KanbanCardControlRepo,
  KanbanCardControlResult,
  KanbanBoardView
} from '../persistence/ports.js'
import { planStatusWrite, type KanbanStatus } from './card-state.js'
import type { CardStore, KanbanRepoRef } from './card-store.js'

/** Fixed, body-free templates: names and reason codes only, never issue content. */
export function skipComment(login: string | null): string {
  return login ? `skipped by @${login} via AgentConnect` : 'skipped via AgentConnect'
}

export function restartComment(): string {
  return 'restarted via AgentConnect'
}

export interface KanbanControlsDeps {
  boards: KanbanBoardAdminRepo
  cards: KanbanCardControlRepo
  installations: Pick<GithubInstallationRepo, 'liveByOrgAndAccount'>
  store: Pick<CardStore, 'readCard' | 'applyPlan'>
  /** Resolve the acting user's GitHub login for the body-free skip comment; undefined or null ⇒ no login in the comment. */
  resolveLogin?: (userId: string) => Promise<string | null>
  poke(boardId: string): void
  log: { warn(obj: unknown, msg?: string): void }
}

export class KanbanControls {
  constructor(private readonly deps: KanbanControlsDeps) {}

  pause(orgId: string, boardId: string, userId: string): Promise<KanbanBoardWriteResult<KanbanBoardView>> {
    return this.deps.boards.setPaused(orgId, boardId, userId, true)
  }

  async resume(orgId: string, boardId: string, userId: string): Promise<KanbanBoardWriteResult<KanbanBoardView>> {
    const result = await this.deps.boards.setPaused(orgId, boardId, userId, false)
    // Re-arm: an unpaused board is reconciled now, not on the next tick.
    if (result.ok) this.deps.poke(boardId)
    return result
  }

  async skip(orgId: string, boardId: string, cardId: string, userId: string): Promise<KanbanCardControlResult> {
    const result = await this.deps.cards.skipCard({ orgId, boardId, cardId, actorUserId: userId, source: 'owner' })
    if (!result.ok) return result
    const login = this.deps.resolveLogin ? await this.deps.resolveLogin(userId).catch(() => null) : null
    await this.writeIssue(result.value, 'archived', skipComment(login))
    return result
  }

  async restart(orgId: string, boardId: string, cardId: string, userId: string): Promise<KanbanCardControlResult> {
    const result = await this.deps.cards.restartCard({ orgId, boardId, cardId, actorUserId: userId, source: 'owner' })
    if (!result.ok) return result
    await this.writeIssue(result.value, 'ready', restartComment())
    this.deps.poke(boardId)
    return result
  }

  /** Best-effort label/close + comment after the DB write committed; a failure leaves drift for the reconciler. */
  private async writeIssue(card: KanbanCardControlOutcome, status: KanbanStatus, comment: string): Promise<void> {
    const repo = await this.repoRef(card)
    if (!repo) return
    try {
      const observed = await this.deps.store.readCard(repo, card.issueNumber)
      if (!observed) return
      await this.deps.store.applyPlan(repo, card.issueNumber, observed, {
        ...planStatusWrite(status, observed),
        comment
      })
    } catch (err) {
      this.deps.log.warn({ err, cardId: card.cardId, status }, 'kanban: control issue write failed')
    }
  }

  private async repoRef(card: KanbanCardControlOutcome): Promise<KanbanRepoRef | null> {
    const owner = card.repoFullName.split('/', 1)[0]
    if (!owner) return null
    const installation = await this.deps.installations.liveByOrgAndAccount(card.orgId, owner)
    if (!installation || installation.revokedAt || installation.suspendedAt) return null
    return { installationId: installation.installationId, repoId: card.repoId, repoFullName: card.repoFullName }
  }
}
