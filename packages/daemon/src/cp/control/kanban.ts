import type { AnyFrame, KanbanDispatch, KanbanDispatchOk } from '@agentconnect.md/protocol'
import type { ControlHandler } from './context.js'

export interface KanbanControlDeps {
  /** Admit one leased Kanban card (issue #2 M2); absent ⇒ every dispatch is refused as `no_agent`. */
  kanbanDispatch?: (dispatch: KanbanDispatch) => Promise<KanbanDispatchOk>
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
