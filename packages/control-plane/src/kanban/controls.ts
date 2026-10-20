// Kanban human controls (issue #2 B5): pause/resume a board, skip/restart a card; body-free, owner + interactive OIDC only.
import type {
  GithubInstallationRepo,
  KanbanLeaseRef,
  KanbanBoardAdminRepo,
  KanbanBoardWriteResult,
  KanbanCardControlOutcome,
  KanbanCardControlRepo,
  KanbanCardControlResult,
  KanbanBoardView
} from '../persistence/ports.js'
import { planStatusWrite, type KanbanStatus } from './card-state.js'
import type { CardStore, KanbanRepoRef } from './card-store.js'
import type { KanbanProjectHook } from './project-writer.js'

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
  /** Tells the revoked lease's daemon to stop now; the bumped dispatchRevision fences it either way. */
  revoke?: (lease: KanbanLeaseRef, cardId: string) => Promise<void>
  /** Post-commit Projects v2 seam for the committed status. */
  project?: Pick<KanbanProjectHook, 'onStatusCommitted'>
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
    if (!result.ok || !result.value.changed) return result
    await this.committed(boardId, result.value)
    const login = this.deps.resolveLogin ? await this.deps.resolveLogin(userId).catch(() => null) : null
    await this.writeIssue(result.value, 'archived', skipComment(login))
    return result
  }

  async restart(orgId: string, boardId: string, cardId: string, userId: string): Promise<KanbanCardControlResult> {
    const result = await this.deps.cards.restartCard({ orgId, boardId, cardId, actorUserId: userId, source: 'owner' })
    if (!result.ok || !result.value.changed) return result
    await this.committed(boardId, result.value)
    await this.writeIssue(result.value, 'ready', restartComment())
    this.deps.poke(boardId)
    return result
  }

  private async committed(boardId: string, card: KanbanCardControlOutcome): Promise<void> {
    if (card.from !== card.status) this.deps.project?.onStatusCommitted({ boardId, issueNumber: card.issueNumber })
    if (!card.revokedLease || !this.deps.revoke) return
    await this.deps.revoke(card.revokedLease, card.cardId).catch((err: unknown) => {
      this.deps.log.warn({ err, cardId: card.cardId }, 'kanban: immediate revocation failed; the fence still holds')
    })
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
