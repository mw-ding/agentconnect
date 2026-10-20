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

export function restartComment(issueNumber: number, supersededPrNumber: number | null): string {
  if (supersededPrNumber === null) return 'restarted via AgentConnect'
  return (
    `restarted via AgentConnect; pull request #${supersededPrNumber} from the earlier work can no longer complete ` +
    `this card, so close it if it is still open and open a new one from \`ac/card-${issueNumber}\``
  )
}

/** Releases a held status-write slot, running `write` (if any) in it; resolves once the slot has drained. */
type StatusWriteRelease = (write?: () => Promise<void>) => Promise<void>

export interface KanbanControlsDeps {
  boards: KanbanBoardAdminRepo
  cards: KanbanCardControlRepo
  installations: Pick<GithubInstallationRepo, 'liveByOrgAndAccount'>
  /** The GitHub card store; without one (no GitHub App) only pause and resume are available. */
  store?: Pick<CardStore, 'readCard' | 'applyPlan'>
  /** The dispatcher's per-card status-write queue, held across the DB write so no claim reads GitHub before the control's write lands. */
  gate?: { holdStatusWrite(cardId: string): StatusWriteRelease }
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
    const store = this.cardStore()
    return this.control(
      boardId,
      cardId,
      () => this.deps.cards.skipCard({ orgId, boardId, cardId, actorUserId: userId, source: 'owner' }),
      async (card) => {
        const login = this.deps.resolveLogin ? await this.deps.resolveLogin(userId).catch(() => null) : null
        await this.writeIssue(store, card, 'archived', skipComment(login))
      }
    )
  }

  async restart(orgId: string, boardId: string, cardId: string, userId: string): Promise<KanbanCardControlResult> {
    const store = this.cardStore()
    const result = await this.control(
      boardId,
      cardId,
      () => this.deps.cards.restartCard({ orgId, boardId, cardId, actorUserId: userId, source: 'owner' }),
      (card) => this.writeIssue(store, card, 'ready', restartComment(card.issueNumber, card.supersededPrNumber))
    )
    if (result.ok && result.value.changed) this.deps.poke(boardId)
    return result
  }

  /** Skip and restart write the GitHub issue, so they need the card store; without one their routes answer unavailable. */
  get cardControlsAvailable(): boolean {
    return this.deps.store !== undefined
  }

  private cardStore(): NonNullable<KanbanControlsDeps['store']> {
    if (!this.deps.store) throw new Error('kanban card controls need a GitHub card store')
    return this.deps.store
  }

  /** Hold the card's status-write slot across the DB move, write GitHub in it, and revoke the old lease alongside, never ahead of it. */
  private async control(
    boardId: string,
    cardId: string,
    move: () => Promise<KanbanCardControlResult>,
    write: (card: KanbanCardControlOutcome) => Promise<void>
  ): Promise<KanbanCardControlResult> {
    const release: StatusWriteRelease = this.deps.gate?.holdStatusWrite(cardId) ?? ((w) => w?.() ?? Promise.resolve())
    let card: KanbanCardControlOutcome | undefined
    try {
      const result = await move()
      if (result.ok && result.value.changed) card = result.value
      return result
    } finally {
      const changed = card
      if (changed && changed.from !== changed.status) this.projectCommitted(boardId, changed)
      const revoking = changed ? this.revokeLease(changed) : undefined
      await release(changed ? () => write(changed) : undefined)
      await revoking
    }
  }

  private projectCommitted(boardId: string, card: KanbanCardControlOutcome): void {
    try {
      this.deps.project?.onStatusCommitted({ boardId, issueNumber: card.issueNumber })
    } catch (err) {
      this.deps.log.warn({ err, cardId: card.cardId }, 'kanban: projection hook failed')
    }
  }

  private async revokeLease(card: KanbanCardControlOutcome): Promise<void> {
    if (!card.revokedLease || !this.deps.revoke) return
    await this.deps.revoke(card.revokedLease, card.cardId).catch((err: unknown) => {
      this.deps.log.warn({ err, cardId: card.cardId }, 'kanban: immediate revocation failed; the fence still holds')
    })
  }

  /** Best-effort label/close + comment after the DB write committed; a failure leaves drift for the reconciler. */
  private async writeIssue(
    store: NonNullable<KanbanControlsDeps['store']>,
    card: KanbanCardControlOutcome,
    status: KanbanStatus,
    comment: string
  ): Promise<void> {
    try {
      const repo = await this.repoRef(card)
      if (!repo) return
      const observed = await store.readCard(repo, card.issueNumber)
      if (!observed) return
      await store.applyPlan(repo, card.issueNumber, observed, {
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
