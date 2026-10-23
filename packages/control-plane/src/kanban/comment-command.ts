// `/kanban` comment commands (TRD 4.4): live human authz, one recorded outcome per comment id, then the GitHub effect.
import type { KanbanDoorbellCommand } from '@agentconnect.md/protocol'
import type { RepoPermissionLookup } from '../github/repo-permission.js'
import type { KanbanBoardRecord, KanbanCardRepo, KanbanCommandRecord } from '../persistence/ports.js'
import { isKanbanStatus, planStatusWrite, type LabelPlan } from './card-state.js'
import type { CardStore, KanbanRepoRef } from './card-store.js'
import {
  authorizeHumanKanbanAction,
  humanRefusalComment,
  planHumanTransition,
  type HumanTransitionRefusal,
  type KanbanCommand
} from './human-action.js'
import type { KanbanProjectHook } from './project-writer.js'

/** A lost CAS (the card moved between read and write) is re-read this many times before the GUID stays unlanded. */
const STALE_ATTEMPTS = 3

/** An effect claim older than this is a dead holder's: a few 10s GitHub calls with retries never take this long. */
export const COMMAND_EFFECT_TTL_MS = 5 * 60_000

export type CommentCommandOutcome =
  'applied' | 'refused' | 'ignored' | 'duplicate' | 'not_a_card' | HumanTransitionRefusal

export interface KanbanCommentCommandsDeps {
  cards: Pick<
    KanbanCardRepo,
    | 'findByIssueNumber'
    | 'getCommand'
    | 'recordCommand'
    | 'settleCommand'
    | 'claimCommandEffect'
    | 'releaseCommandEffect'
  >
  store: Pick<CardStore, 'readCard' | 'applyPlan'>
  /** Live and uncached (`ttlMs: 0`): a revoked write grant must stop the very next command. */
  permissions: RepoPermissionLookup
  appSlug: string | undefined
  /** An applied move committed and its labels landed: wake the board (and its notifier). */
  onApplied?: (board: KanbanBoardRecord, record: KanbanCommandRecord) => void | Promise<void>
  /** Every committed status change is projected to the board's GitHub Project. */
  project?: Pick<KanbanProjectHook, 'onStatusCommitted'>
  log: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void }
}

export class KanbanCommentCommands {
  constructor(private readonly deps: KanbanCommentCommandsDeps) {}

  /** A throw leaves the doorbell GUID unlanded, so the redelivery sweep re-asks; every outcome below lands it. */
  async handle(
    board: KanbanBoardRecord,
    repo: KanbanRepoRef,
    issueNumber: number,
    command: KanbanDoorbellCommand
  ): Promise<CommentCommandOutcome> {
    const commentId = BigInt(command.commentId)
    const prior = await this.deps.cards.getCommand(board.id, commentId)
    if (prior) {
      if (!prior.settledAt) await this.settle(board, repo, issueNumber, prior)
      return 'duplicate'
    }
    // The CP re-checks the sender: a relay bug or an old relay must not let a bot or this App move a card (B8).
    const authz = await authorizeHumanKanbanAction({
      repo,
      actor: { login: command.sender.login, type: command.sender.type, viaApp: command.viaApp },
      appSlug: this.deps.appSlug,
      permissions: this.deps.permissions
    })
    if (!authz.ok && authz.reason === 'lookup_failed') throw authz.error
    if (!authz.ok && authz.reason !== 'no_write') {
      this.deps.log.info({ boardId: board.id, issueNumber, reason: authz.reason }, 'kanban: command sender ignored')
      return 'ignored'
    }
    for (let attempt = 0; attempt < STALE_ATTEMPTS; attempt++) {
      const card = await this.deps.cards.findByIssueNumber(board.id, issueNumber)
      if (!card) return 'not_a_card'
      const base = {
        boardId: board.id,
        cardId: card.id,
        commentId,
        command: command.name,
        actorLogin: command.sender.login,
        from: card.status,
        expectedStateRevision: card.stateRevision
      }
      let recorded
      if (!authz.ok) {
        recorded = await this.deps.cards.recordCommand({ ...base, refusal: 'no_write' })
      } else {
        const issue = await this.deps.store.readCard(repo, issueNumber)
        if (!issue) return 'not_a_card'
        const plan = planHumanTransition(card, command.name, issue)
        recorded = await this.deps.cards.recordCommand(
          plan.ok ? { ...base, to: plan.to, humanAuthority: authz.authority } : { ...base, refusal: plan.reason }
        )
      }
      if (recorded.kind === 'stale') continue
      if (recorded.kind === 'recorded' && recorded.record.outcome === 'applied') {
        this.deps.project?.onStatusCommitted({ boardId: board.id, issueNumber })
      }
      await this.settle(board, repo, issueNumber, recorded.record)
      if (recorded.kind === 'duplicate') return 'duplicate'
      const outcome = recorded.record.outcome as CommentCommandOutcome
      this.deps.log.info({ boardId: board.id, issueNumber, command: command.name, outcome }, 'kanban: comment command')
      return outcome
    }
    throw new Error('kanban: comment command lost its card CAS on every attempt')
  }

  // One delivery at a time runs the effect: an overlapping one throws, so its GUID stays unlanded and is re-asked later.
  private async settle(
    board: KanbanBoardRecord,
    repo: KanbanRepoRef,
    issueNumber: number,
    record: KanbanCommandRecord
  ): Promise<void> {
    if (record.outcome === 'no_write') {
      await this.deps.cards.settleCommand(record.id)
      return
    }
    const claimedAt = await this.deps.cards.claimCommandEffect(record.id, COMMAND_EFFECT_TTL_MS)
    if (!claimedAt) {
      if ((await this.deps.cards.getCommand(board.id, record.commentId))?.settledAt) return
      throw new Error('kanban: comment command effect is in flight on another delivery')
    }
    try {
      await this.runEffect(board, repo, issueNumber, record)
    } catch (err) {
      // Recovery checks the refusal marker even after a lost POST response or settlement failure.
      await this.deps.cards.releaseCommandEffect(record.id, claimedAt).catch(() => undefined)
      throw err
    }
  }

  // Applied: write the labels for the status the command set, unless the card has since moved on. Refused: the one comment.
  private async runEffect(
    board: KanbanBoardRecord,
    repo: KanbanRepoRef,
    issueNumber: number,
    record: KanbanCommandRecord
  ): Promise<void> {
    const issue = await this.deps.store.readCard(repo, issueNumber)
    if (record.outcome === 'applied') {
      const card = await this.deps.cards.findByIssueNumber(board.id, issueNumber)
      if (issue && card && record.toStatus && card.status === record.toStatus) {
        await this.deps.store.applyPlan(repo, issueNumber, issue, planStatusWrite(record.toStatus, issue))
      }
      await this.deps.cards.settleCommand(record.id)
      await this.deps.onApplied?.(board, record)
      return
    }
    if (issue) await this.deps.store.applyPlan(repo, issueNumber, issue, refusalPlan(record))
    await this.deps.cards.settleCommand(record.id)
  }
}

/** A comment-only plan: refusals never touch labels or issue state. */
function refusalPlan(record: KanbanCommandRecord): LabelPlan {
  const status = isKanbanStatus(record.fromStatus) ? record.fromStatus : 'triage'
  return {
    outcome: 'noop',
    status,
    releaseLease: false,
    addLabels: [],
    removeLabels: [],
    commentKey: `command:${record.id}`,
    commentSince: record.createdAt,
    comment: humanRefusalComment(record.command as KanbanCommand, status, record.outcome as HumanTransitionRefusal)
  }
}
