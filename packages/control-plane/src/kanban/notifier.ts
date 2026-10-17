// Kanban transition notifier (issue #2 M4): which status transitions post to the board's anchor channel, and whether to @-mention the requester.
import type { KanbanStatus } from './card-state.js'
import type { KanbanBlockKind, TrippedLimit } from './run-accounting.js'
import type { KanbanNotifyRepo } from '../persistence/ports.js'

/** A card's status move, as the dispatcher, ingest, or graph promotion observed it. */
export interface KanbanTransition {
  cardId: string
  boardId: string
  issueNumber: number
  from: KanbanStatus
  to: KanbanStatus
  blockKind?: KanbanBlockKind
  reasonCode?: string
  tripped?: TrippedLimit
  role?: 'work' | 'verify'
}

/** The board facts a notification needs; `targetChannel` null means headless (never post). */
export interface NotificationBoard {
  targetChannel: string | null
}

/** Whether to enqueue a notification, and whether the post should @-mention the board owner. */
export interface NotificationDecision {
  notify: boolean
  mention: boolean
}

/** Pure from×to table: notify entering blocked/review/done/archived, triage with a trip or reason, and a verifier's review→ready; never churn, self-moves, or headless boards. */
export function planNotification(transition: KanbanTransition, board: NotificationBoard): NotificationDecision {
  if (board.targetChannel == null) return { notify: false, mention: false }
  if (transition.from === transition.to) return { notify: false, mention: false }
  const to = transition.to
  if (to === 'blocked') return { notify: true, mention: transition.blockKind === 'needs_input' }
  if (to === 'review' || to === 'done' || to === 'archived') return { notify: true, mention: false }
  if (to === 'triage')
    return { notify: transition.tripped !== undefined || transition.reasonCode != null, mention: false }
  if (to === 'ready' && transition.from === 'review' && transition.role === 'verify')
    return { notify: true, mention: false }
  return { notify: false, mention: false }
}

/** Enqueue a transition notification for the post-commit ingest path, replay-safe on the (cardId, stateRevision) key. */
export async function enqueueTransition(
  repo: KanbanNotifyRepo,
  transition: KanbanTransition,
  stateRevision: bigint
): Promise<void> {
  const target = await repo.target(transition.boardId)
  if (!target) return
  const decision = planNotification(transition, target)
  if (!decision.notify) return
  await repo.enqueue({
    boardId: transition.boardId,
    cardId: transition.cardId,
    issueNumber: transition.issueNumber,
    stateRevision,
    from: transition.from,
    to: transition.to,
    blockKind: transition.blockKind,
    reasonCode: transition.reasonCode,
    tripped: transition.tripped,
    mention: decision.mention
  })
}
