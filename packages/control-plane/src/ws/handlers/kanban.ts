// Kanban lease frames (issue #2 M2): the authenticated connection's daemonId and epoch are the fence inputs, never the payload's.
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId } from '../../domain/ids.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import { frameOrgId } from './frame-org.js'
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
    // Replied only after the fenced write commits. The summary stays in the daemon outbox and is posted once this ack (or its replay) says accepted.
    conn.replyTo(
      frame,
      'kanban/report/ok',
      await deps.kanbanDispatcher.onReport(conn.daemonId, conn.sessionEpoch, frame.payload)
    )
  } catch {
    conn.sendError(frame.id, 'INTERNAL', 'kanban report failed', true)
  }
}

export const handleKanbanCard: Handler = async (frame, conn, deps) => {
  if (!isFrame('kanban/card')(frame)) return
  if (!deps.kanbanDispatcher) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'kanban dispatch is not enabled', false)
    return
  }
  try {
    // The fence inputs are the authenticated connection's, never the payload's.
    conn.replyTo(
      frame,
      'kanban/card/ok',
      await deps.kanbanDispatcher.onCardShow(conn.daemonId, conn.sessionEpoch, frame.payload)
    )
  } catch {
    conn.sendError(frame.id, 'INTERNAL', 'kanban card read failed', true)
  }
}

export const handleKanbanOrchestrate: Handler = async (frame, conn, deps) => {
  if (!isFrame('kanban/orchestrate')(frame)) return
  if (!deps.kanbanOrchestrator) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'kanban orchestration is not enabled', false)
    return
  }
  const orgId = frameOrgId(frame, conn)
  if (!orgId) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'organization is required', false)
    return
  }
  try {
    // The caller identity is the authenticated connection's agent placement, never the payload's agentId alone.
    const req = frame.payload
    const agent = await deps.agent.get(orgId, AgentId(req.agentId))
    if (!agent || !(await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, conn.daemonId))) {
      conn.replyTo(frame, 'kanban/orchestrate/ok', { ok: false, op: req.op, code: 'not_orchestrator' })
      return
    }
    conn.replyTo(frame, 'kanban/orchestrate/ok', await deps.kanbanOrchestrator.orchestrate(orgId, req.agentId, req))
  } catch {
    conn.sendError(frame.id, 'INTERNAL', 'kanban orchestration failed', true)
  }
}
