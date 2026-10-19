import type {
  AnyFrame,
  KanbanDispatch,
  KanbanDispatchOk,
  KanbanNotify,
  KanbanNotifyOk,
  KanbanRevoke
} from '@agentconnect.md/protocol'
import type { ControlHandler } from './context.js'

export interface KanbanControlDeps {
  kanbanRevoke?: (req: KanbanRevoke) => Promise<void>
  /** Admit one leased Kanban card (issue #2 M2); absent ⇒ every dispatch is refused as `no_agent`. */
  kanbanDispatch?: (dispatch: KanbanDispatch) => Promise<KanbanDispatchOk>
  /** Post one Kanban transition notification in the anchor channel (issue #2 M4). */
  kanbanNotify?: (notify: KanbanNotify) => Promise<KanbanNotifyOk>
}

/** `kanban/dispatch` (C→D REQ): durable admission answers before the turn itself runs. */
export const kanbanDispatch: ControlHandler<KanbanControlDeps> = async (frame: AnyFrame, deps, wire) => {
  const dispatch = frame.payload as KanbanDispatch
  try {
    wire.reply(
      frame,
      'kanban/dispatch/ok',
      (await deps.kanbanDispatch?.(dispatch)) ?? { leaseId: dispatch.leaseId, accepted: false, reason: 'no_agent' }
    )
  } catch {
    wire.sendError(frame.id, 'INTERNAL', 'kanban admission failed', true)
  }
}

/** `kanban/notify` (C→D REQ): post one body-free transition notification; an unavailable handler refuses as data. */
export const kanbanNotify: ControlHandler<KanbanControlDeps> = async (frame: AnyFrame, deps, wire) => {
  const notify = frame.payload as KanbanNotify
  try {
    wire.reply(
      frame,
      'kanban/notify/ok',
      (await deps.kanbanNotify?.(notify)) ?? { notifyId: notify.notifyId, ok: false, reason: 'unavailable' }
    )
  } catch {
    wire.sendError(frame.id, 'INTERNAL', 'kanban notification failed', true)
  }
}

export const kanbanRevoke: ControlHandler<KanbanControlDeps> = async (frame, deps, wire) => {
  const req = frame.payload as KanbanRevoke
  try {
    if (!deps.kanbanRevoke) return wire.sendError(frame.id, 'INTERNAL', 'kanban revocation unavailable', true)
    await deps.kanbanRevoke(req)
    wire.reply(frame, 'kanban/revoke/ok', { leaseId: req.leaseId })
  } catch {
    wire.sendError(frame.id, 'INTERNAL', 'kanban revocation failed', true)
  }
}
