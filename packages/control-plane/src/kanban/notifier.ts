// Kanban transition notifier (issue #2 M4): which status transitions post to the board's anchor channel, and whether to @-mention the requester.
import type { KanbanStatus } from './card-state.js'
import type { KanbanBlockKind, TrippedLimit } from './run-accounting.js'

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

const READY_NOTIFY_REASONS: ReadonlySet<string> = new Set(['restarted', 'synthesis', 'comment_command'])

// Explicit restarts, synthesis and comment commands notify alongside terminal moves; churn and headless boards stay silent.
export function planNotification(transition: KanbanTransition, board: NotificationBoard): NotificationDecision {
  if (board.targetChannel == null) return { notify: false, mention: false }
  if (transition.from === transition.to) return { notify: false, mention: false }
  const to = transition.to
  if (to === 'blocked') return { notify: true, mention: transition.blockKind === 'needs_input' }
  if (to === 'review' || to === 'done' || to === 'archived') return { notify: true, mention: false }
  if (to === 'triage')
    return { notify: transition.tripped !== undefined || transition.reasonCode != null, mention: false }
  if (to === 'ready' && READY_NOTIFY_REASONS.has(transition.reasonCode ?? '')) return { notify: true, mention: false }
  if (to === 'ready' && transition.from === 'review' && transition.role === 'verify')
    return { notify: true, mention: false }
  return { notify: false, mention: false }
}
