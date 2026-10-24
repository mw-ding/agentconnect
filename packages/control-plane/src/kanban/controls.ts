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
import { planStatusWrite, type KanbanStatus, type LabelPlan } from './card-state.js'
import type { CardStore, KanbanRepoRef } from './card-store.js'
import type { KanbanProjectHook } from './project-writer.js'
import type { PrReader } from './pr-reader.js'

// Fixed, body-free templates: names and reason codes only, never issue content.
export function skipComment(login: string | null): string {
  return login ? `skipped by @${login} via AgentConnect` : 'skipped via AgentConnect'
}

export function restartComment(issueNumber: number, supersededPrNumber: number | null): string {
  if (supersededPrNumber === null) return 'restarted via AgentConnect'
  return (
    `restarted via AgentConnect; pull request #${supersededPrNumber} from the earlier work can no longer complete ` +
    `this card, and the next run replaces it with a new one from \`ac/card-${issueNumber}\``
  )
}

/** The facts a control's comment is rendered from, stored on the card so the label sync's repair can re-post it. */
export interface ControlCommentFacts {
  cardId: string
  issueNumber: number
  controlVersion: bigint
  kind: 'skip' | 'restart'
  actorLogin: string | null
  supersededPrNumber: number | null
  at: Date
}

// One key per control version: the control's own write and any repair post the comment at most once between them.
export function controlComment(facts: ControlCommentFacts): Pick<LabelPlan, 'comment' | 'commentKey' | 'commentSince'> {
  return {
    comment:
      facts.kind === 'skip'
        ? skipComment(facts.actorLogin)
        : restartComment(facts.issueNumber, facts.supersededPrNumber),
    commentKey: `control:${facts.cardId}:${facts.controlVersion}`,
    commentSince: facts.at
  }
}

// Only this repository's open, unmerged PR from the card's own `ac/card-<n>` may be named for closing.
export function isSupersededCardPr(
  pr: Awaited<ReturnType<PrReader['readPullRequest']>>,
  expected: { prNumber: number; issueNumber: number; repoId: bigint }
): boolean {
  return (
    pr !== null &&
    pr.number === expected.prNumber &&
    pr.state === 'open' &&
    !pr.merged &&
    pr.headRef === `ac/card-${expected.issueNumber}` &&
    pr.headRepoId === expected.repoId
  )
}

// Releases a held status-write slot, running `write` (if any) in it; resolves once the slot has drained.
type StatusWriteRelease = (write?: () => Promise<void>) => Promise<void>

export interface KanbanControlsDeps {
  boards: KanbanBoardAdminRepo
  cards: KanbanCardControlRepo
  installations: Pick<GithubInstallationRepo, 'liveByOrgAndAccount'>
  // The GitHub card store; without one (no GitHub App) only pause and resume are available.
  store?: Pick<CardStore, 'readCard' | 'applyPlan'>
  // The read-only PR reader that validates a restart's superseded PR; without one no PR is ever named.
  prs?: Pick<PrReader, 'readPullRequest'>
  // The dispatcher's per-card status-write queue, held across the DB write so no claim reads GitHub before the control's write lands.
  gate?: { holdStatusWrite(cardId: string): StatusWriteRelease }
  // Resolve the acting user's GitHub login for the body-free skip comment; undefined or null ⇒ no login in the comment.
  resolveLogin?: (userId: string) => Promise<string | null>
  poke(boardId: string): void
  // Tells the revoked lease's daemon to stop now; the bumped dispatchRevision fences it either way.
  revoke?: (lease: KanbanLeaseRef, cardId: string) => Promise<void>
  // Post-commit Projects v2 seam for the committed status.
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
    // Resolved before the move, so the login is stored with the control for a repair to re-post.
    const login = this.deps.resolveLogin ? await this.deps.resolveLogin(userId).catch(() => null) : null
    return this.control(
      boardId,
      cardId,
      () =>
        this.deps.cards.skipCard({ orgId, boardId, cardId, actorUserId: userId, source: 'owner', actorLogin: login }),
      (card) => this.writeIssue(store, card, 'archived', controlComment(commentFacts(card, 'skip', login)))
    )
  }

  async restart(orgId: string, boardId: string, cardId: string, userId: string): Promise<KanbanCardControlResult> {
    const store = this.cardStore()
    const validatedPrNumber = await this.validatedSupersededPr(orgId, boardId, cardId)
    const result = await this.control(
      boardId,
      cardId,
      () =>
        this.deps.cards.restartCard({
          orgId,
          boardId,
          cardId,
          actorUserId: userId,
          source: 'owner',
          validatedPrNumber
        }),
      (card) => this.writeIssue(store, card, 'ready', controlComment(commentFacts(card, 'restart', null)))
    )
    if (result.ok && result.value.changed) this.deps.poke(boardId)
    return result
  }

  // Skip and restart write the GitHub issue, so they need the card store; without one their routes answer unavailable.
  get cardControlsAvailable(): boolean {
    return this.deps.store !== undefined
  }

  private cardStore(): NonNullable<KanbanControlsDeps['store']> {
    if (!this.deps.store) throw new Error('kanban card controls need a GitHub card store')
    return this.deps.store
  }

  // The linked PR, kept only when a live read proves it this repo's open PR from `ac/card-<n>`; any failure drops it.
  private async validatedSupersededPr(orgId: string, boardId: string, cardId: string): Promise<number | null> {
    try {
      const peek = await this.deps.cards.peekControl(orgId, boardId, cardId)
      if (!peek || peek.linkedPrNumber === null || !this.deps.prs) return null
      const repo = await this.repoRef(peek)
      if (!repo) return null
      const pr = await this.deps.prs.readPullRequest(repo, peek.linkedPrNumber)
      const expected = { prNumber: peek.linkedPrNumber, issueNumber: peek.issueNumber, repoId: peek.repoId }
      return isSupersededCardPr(pr, expected) ? peek.linkedPrNumber : null
    } catch (err) {
      this.deps.log.warn({ err, cardId }, 'kanban: superseded PR validation failed; the restart names no PR')
      return null
    }
  }

  // Hold the card's status-write slot across the DB move, write GitHub in it unless a newer control superseded it, and revoke alongside.
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
      await release(changed ? () => this.versionedWrite(changed, write) : undefined)
      await revoking
    }
  }

  // A control's write lands only while its version is the card's latest; a failure stays pending, unclaimable, for the label sync.
  private async versionedWrite(
    card: KanbanCardControlOutcome,
    write: (card: KanbanCardControlOutcome) => Promise<void>
  ): Promise<void> {
    try {
      if (!(await this.deps.cards.isLatestControl(card.cardId, card.controlVersion))) {
        this.deps.log.warn(
          { cardId: card.cardId, controlVersion: card.controlVersion },
          'kanban: dropped a control write a newer control superseded'
        )
        return
      }
      await write(card)
      await this.deps.cards.markControlWritten(card.cardId, card.controlVersion, card.stateRevision)
    } catch (err) {
      this.deps.log.warn(
        { err, cardId: card.cardId, status: card.status },
        'kanban: control issue write failed; the card stays unclaimable until the label sync repairs it'
      )
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

  // The label/close + comment after the DB write committed; it throws when the write cannot land, leaving it pending.
  private async writeIssue(
    store: NonNullable<KanbanControlsDeps['store']>,
    card: KanbanCardControlOutcome,
    status: KanbanStatus,
    comment: Pick<LabelPlan, 'comment' | 'commentKey' | 'commentSince'>
  ): Promise<void> {
    const repo = await this.repoRef(card)
    if (!repo) throw new Error('kanban control write has no live installation')
    const observed = await store.readCard(repo, card.issueNumber)
    if (!observed) throw new Error('kanban control write found no issue')
    if (!(await this.deps.cards.isLatestControl(card.cardId, card.controlVersion))) return
    await store.applyPlan(repo, card.issueNumber, observed, {
      ...planStatusWrite(status, observed),
      ...comment
    })
  }

  private async repoRef(
    card: Pick<KanbanCardControlOutcome, 'orgId' | 'repoId' | 'repoFullName'>
  ): Promise<KanbanRepoRef | null> {
    const owner = card.repoFullName.split('/', 1)[0]
    if (!owner) return null
    const installation = await this.deps.installations.liveByOrgAndAccount(card.orgId, owner)
    if (!installation || installation.revokedAt || installation.suspendedAt) return null
    return { installationId: installation.installationId, repoId: card.repoId, repoFullName: card.repoFullName }
  }
}

function commentFacts(
  card: KanbanCardControlOutcome,
  kind: ControlCommentFacts['kind'],
  actorLogin: string | null
): ControlCommentFacts {
  return {
    cardId: card.cardId,
    issueNumber: card.issueNumber,
    controlVersion: card.controlVersion,
    kind,
    actorLogin,
    supersededPrNumber: card.supersededPrNumber,
    at: card.controlAt
  }
}
