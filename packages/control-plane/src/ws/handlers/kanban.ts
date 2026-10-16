// Kanban lease frames (issue #2 M2): the authenticated connection's daemonId and epoch are the fence inputs, never the payload's.
import { isFrame } from '@agentconnect.md/protocol'
import type { Handler } from './index.js'

export const handleKanbanLeaseHeartbeat: Handler = async (frame, conn, deps) => {
  if (!isFrame('kanban/lease-heartbeat')(frame)) return
  if (!deps.kanbanDispatcher) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'kanban dispatch is not enabled', false)
    return
  }
  try {
    const superseded = await deps.kanbanDispatcher.onHeartbeat(conn.daemonId, conn.sessionEpoch, frame.payload.leases)
    conn.replyTo(frame, 'kanban/lease-heartbeat/ok', { superseded })
  } catch {
    conn.sendError(frame.id, 'INTERNAL', 'kanban heartbeat failed', true)
  }
}

export const handleKanbanReport: Handler = async (frame, conn, deps) => {
  if (!isFrame('kanban/report')(frame)) return
  if (!deps.kanbanDispatcher) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'kanban dispatch is not enabled', false)
    return
  }
  try {
    // Replied only after the fenced write commits, so the daemon may then drop its outbox row.
    conn.replyTo(
      frame,
      'kanban/report/ok',
      await deps.kanbanDispatcher.onReport(conn.daemonId, conn.sessionEpoch, frame.payload)
    )
  } catch {
    conn.sendError(frame.id, 'INTERNAL', 'kanban report failed', true)
  }
}
