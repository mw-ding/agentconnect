import { z } from 'zod'
import { KANBAN_BLOCK_KINDS, KANBAN_COMMENT_MAX_CHARS } from '@agentconnect.md/protocol'
import { KANBAN_REASON_MAX_CHARS, KANBAN_SUMMARY_MAX_CHARS, type KanbanTerminal } from '../../kanban/kanban-worker.js'
import type { SessionContext, ToolHandler } from './context.js'
import {
  optionalBoundedInt,
  optionalEnum,
  optionalPositiveInt,
  parseArgs,
  requiredEnum,
  requiredPositiveInt
} from './args.js'

/** A worker's terminal tool call; the lease is resolved from these trusted coordinates, never from tool input. */
export interface KanbanTerminalReq {
  agentId: string
  platform: string
  channel: string
  thread: string
  transportScope?: string
  terminal: KanbanTerminal & { summary: string }
}

/** The same trusted coordinates for the read and comment tools; no lease or card id ever comes from arguments. */
export type KanbanSessionReq = Omit<KanbanTerminalReq, 'terminal'>

/** Kanban card runs: record the run's one terminal outcome against the session's live lease. */
export interface KanbanDeps {
  /** Throws when refused (no live lease, already reported, or not durable). */
  recordKanbanTerminal?: (req: KanbanTerminalReq) => Promise<unknown>
  /** Reads the session's own leased card; throws when no live lease holds the session. */
  kanbanShow?: (req: KanbanSessionReq) => Promise<unknown>
  /** Posts one progress note on the session's own leased card; throws when refused or over the cap. */
  kanbanComment?: (req: KanbanSessionReq & { text: string }) => Promise<unknown>
}

const unexpectedKeys: { error: z.core.$ZodErrorMap } = {
  error: (issue) =>
    issue.code === 'unrecognized_keys'
      ? `unexpected argument${issue.keys.length > 1 ? 's' : ''}: ${issue.keys.join(', ')}`
      : undefined
}

function boundedText(key: string, max: number) {
  const missing = `missing required string argument: ${key}`
  return z
    .string(missing)
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, missing)
    .refine((value) => value.length <= max, `argument ${key} must be at most ${max} characters`)
}

const summary = boundedText('summary', KANBAN_SUMMARY_MAX_CHARS)
const reason = boundedText('reason', KANBAN_REASON_MAX_CHARS)
const prNumber = optionalBoundedInt('prNumber', 1, 2 ** 31 - 1)

export const KANBAN_COMPLETE_ARGS = z.strictObject({ summary, prNumber }, unexpectedKeys)
export const KANBAN_REQUEST_REVIEW_ARGS = z.strictObject({ summary, prNumber }, unexpectedKeys)
export const KANBAN_BLOCK_ARGS = z.strictObject(
  { summary, kind: requiredEnum('kind', KANBAN_BLOCK_KINDS), reason },
  unexpectedKeys
)
export const KANBAN_SHOW_ARGS = z.strictObject({}, unexpectedKeys)
export const KANBAN_COMMENT_ARGS = z.strictObject(
  { text: boundedText('text', KANBAN_COMMENT_MAX_CHARS) },
  unexpectedKeys
)
export const KANBAN_FAIL_ARGS = z.strictObject({ summary, reason }, unexpectedKeys)

function sessionReq(ctx: SessionContext): KanbanSessionReq {
  return {
    agentId: ctx.agentId,
    platform: ctx.platform,
    channel: ctx.channel,
    thread: ctx.thread,
    ...(ctx.transportScope !== undefined ? { transportScope: ctx.transportScope } : {})
  }
}

function record(ctx: SessionContext, deps: KanbanDeps, terminal: KanbanTerminalReq['terminal']): Promise<unknown> {
  if (!deps.recordKanbanTerminal) throw new Error('Kanban terminal reports are unavailable on this daemon')
  return deps.recordKanbanTerminal({ ...sessionReq(ctx), terminal })
}

// Reason codes are daemon-chosen constants, so no model text reaches the body-free report.
export const kanbanComplete: ToolHandler<KanbanDeps> = (ctx, args, deps) => {
  const parsed = parseArgs(KANBAN_COMPLETE_ARGS, args)
  return record(ctx, deps, {
    outcome: 'completed',
    summary: parsed.summary,
    ...(parsed.prNumber ? { prNumber: parsed.prNumber } : {})
  })
}

export const kanbanRequestReview: ToolHandler<KanbanDeps> = (ctx, args, deps) => {
  const parsed = parseArgs(KANBAN_REQUEST_REVIEW_ARGS, args)
  return record(ctx, deps, {
    outcome: 'review_requested',
    summary: parsed.summary,
    ...(parsed.prNumber ? { prNumber: parsed.prNumber } : {})
  })
}

export const kanbanBlock: ToolHandler<KanbanDeps> = (ctx, args, deps) => {
  const parsed = parseArgs(KANBAN_BLOCK_ARGS, args)
  return record(ctx, deps, {
    outcome: 'blocked',
    blockKind: parsed.kind,
    reasonCode: 'agent_blocked',
    summary: parsed.summary,
    reason: parsed.reason
  })
}

export const kanbanFail: ToolHandler<KanbanDeps> = (ctx, args, deps) => {
  const parsed = parseArgs(KANBAN_FAIL_ARGS, args)
  return record(ctx, deps, {
    outcome: 'failed',
    reasonCode: 'agent_failed',
    summary: parsed.summary,
    reason: parsed.reason
  })
}

export const kanbanShow: ToolHandler<KanbanDeps> = (ctx, args, deps) => {
  parseArgs(KANBAN_SHOW_ARGS, args ?? {})
  if (!deps.kanbanShow) throw new Error('Kanban card reads are unavailable on this daemon')
  return deps.kanbanShow(sessionReq(ctx))
}

export const kanbanComment: ToolHandler<KanbanDeps> = (ctx, args, deps) => {
  const parsed = parseArgs(KANBAN_COMMENT_ARGS, args)
  if (!deps.kanbanComment) throw new Error('Kanban comments are unavailable on this daemon')
  return deps.kanbanComment({ ...sessionReq(ctx), text: parsed.text })
}

/** Handler and argument-schema registry entries for {@link executeTool}. */
export const KANBAN_HANDLERS: [string, ToolHandler<KanbanDeps>][] = [
  ['kanbanComplete', kanbanComplete],
  ['kanbanRequestReview', kanbanRequestReview],
  ['kanbanBlock', kanbanBlock],
  ['kanbanFail', kanbanFail],
  ['kanbanShow', kanbanShow],
  ['kanbanComment', kanbanComment]
]
export const KANBAN_ARG_SCHEMAS: [string, z.ZodType][] = [
  ['kanbanComplete', KANBAN_COMPLETE_ARGS],
  ['kanbanRequestReview', KANBAN_REQUEST_REVIEW_ARGS],
  ['kanbanBlock', KANBAN_BLOCK_ARGS],
  ['kanbanFail', KANBAN_FAIL_ARGS],
  ['kanbanShow', KANBAN_SHOW_ARGS],
  ['kanbanComment', KANBAN_COMMENT_ARGS]
]

// ── Orchestrator tools (issue #2 M3): caller identity is ctx.agentId; the board is a uuid, and the CP gates the role. ──

export interface KanbanOrchestratorToolDeps {
  kanbanList?: (req: { agentId: string; board?: string; status?: string }) => Promise<unknown>
  kanbanCreate?: (req: {
    agentId: string
    board: string
    title: string
    body: string
    epic?: number
    step?: string
    assignee?: string
    priority?: number
    status?: 'triage' | 'todo'
    blockedBy?: number[]
  }) => Promise<unknown>
  kanbanLink?: (req: {
    agentId: string
    board: string
    issue: number
    blockedBy?: number[]
    parent?: number
  }) => Promise<unknown>
  kanbanUnblock?: (req: { agentId: string; board: string; issue: number; blockers?: number[] }) => Promise<unknown>
  kanbanAssign?: (req: { agentId: string; board: string; issue: number; assignee: string | null }) => Promise<unknown>
}

const boardArg = z.string().uuid('argument board must be a board id (uuid)')
const titleArg = z
  .string('missing required string argument: title')
  .transform((v) => v.trim())
  .refine((v) => v.length > 0, 'missing required string argument: title')
  .refine((v) => v.length <= 256, 'argument title must be at most 256 characters')
const bodyArg = z
  .string('missing required string argument: body')
  .transform((v) => v.trim())
  .refine((v) => v.length <= 60000, 'argument body must be at most 60000 characters')
const stepArg = z
  .string('argument step must be a string')
  .regex(/^[a-z0-9][a-z0-9_.:-]{0,63}$/, 'argument step must be a short machine id')
  .optional()
const positiveIntItem = z.int('blockedBy must list positive integers').min(1, 'blockedBy must list positive integers')
const blockersArg = z.array(positiveIntItem).max(20, 'argument blockedBy must list at most 20 issues').optional()

export const KANBAN_LIST_ARGS = z.strictObject(
  { board: boardArg.optional(), status: z.string().min(1).max(40).optional() },
  unexpectedKeys
)
export const KANBAN_CREATE_ARGS = z.strictObject(
  {
    board: boardArg,
    title: titleArg,
    body: bodyArg,
    epic: optionalPositiveInt('epic'),
    step: stepArg,
    assignee: z.string().min(1).max(64).optional(),
    priority: optionalBoundedInt('priority', Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    status: optionalEnum('status', ['triage', 'todo']),
    blockedBy: blockersArg
  },
  unexpectedKeys
)
export const KANBAN_LINK_ARGS = z.strictObject(
  {
    board: boardArg,
    issue: requiredPositiveInt('issue'),
    blockedBy: blockersArg,
    parent: optionalPositiveInt('parent')
  },
  unexpectedKeys
)
export const KANBAN_UNBLOCK_ARGS = z.strictObject(
  {
    board: boardArg,
    issue: requiredPositiveInt('issue'),
    blockers: z.array(positiveIntItem).optional()
  },
  unexpectedKeys
)
export const KANBAN_ASSIGN_ARGS = z.strictObject(
  { board: boardArg, issue: requiredPositiveInt('issue'), assignee: z.string().min(1).max(64).nullable() },
  unexpectedKeys
)

export const kanbanListTool: ToolHandler<KanbanOrchestratorToolDeps> = (ctx, args, deps) => {
  const parsed = parseArgs(KANBAN_LIST_ARGS, args)
  if (!deps.kanbanList) throw new Error('Kanban orchestrator tools are unavailable on this daemon')
  return deps.kanbanList({
    agentId: ctx.agentId,
    ...(parsed.board ? { board: parsed.board } : {}),
    ...(parsed.status ? { status: parsed.status } : {})
  })
}

export const kanbanCreateTool: ToolHandler<KanbanOrchestratorToolDeps> = (ctx, args, deps) => {
  const parsed = parseArgs(KANBAN_CREATE_ARGS, args)
  if (!deps.kanbanCreate) throw new Error('Kanban orchestrator tools are unavailable on this daemon')
  return deps.kanbanCreate({
    agentId: ctx.agentId,
    board: parsed.board,
    title: parsed.title,
    body: parsed.body,
    ...(parsed.epic !== undefined ? { epic: parsed.epic } : {}),
    ...(parsed.step !== undefined ? { step: parsed.step } : {}),
    ...(parsed.assignee !== undefined ? { assignee: parsed.assignee } : {}),
    ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
    ...(parsed.status !== undefined ? { status: parsed.status } : {}),
    ...(parsed.blockedBy !== undefined ? { blockedBy: parsed.blockedBy } : {})
  })
}

export const kanbanLinkTool: ToolHandler<KanbanOrchestratorToolDeps> = (ctx, args, deps) => {
  const parsed = parseArgs(KANBAN_LINK_ARGS, args)
  if (!deps.kanbanLink) throw new Error('Kanban orchestrator tools are unavailable on this daemon')
  return deps.kanbanLink({
    agentId: ctx.agentId,
    board: parsed.board,
    issue: parsed.issue,
    ...(parsed.blockedBy !== undefined ? { blockedBy: parsed.blockedBy } : {}),
    ...(parsed.parent !== undefined ? { parent: parsed.parent } : {})
  })
}

export const kanbanUnblockTool: ToolHandler<KanbanOrchestratorToolDeps> = (ctx, args, deps) => {
  const parsed = parseArgs(KANBAN_UNBLOCK_ARGS, args)
  if (!deps.kanbanUnblock) throw new Error('Kanban orchestrator tools are unavailable on this daemon')
  return deps.kanbanUnblock({
    agentId: ctx.agentId,
    board: parsed.board,
    issue: parsed.issue,
    ...(parsed.blockers !== undefined ? { blockers: parsed.blockers } : {})
  })
}

export const kanbanAssignTool: ToolHandler<KanbanOrchestratorToolDeps> = (ctx, args, deps) => {
  const parsed = parseArgs(KANBAN_ASSIGN_ARGS, args)
  if (!deps.kanbanAssign) throw new Error('Kanban orchestrator tools are unavailable on this daemon')
  return deps.kanbanAssign({
    agentId: ctx.agentId,
    board: parsed.board,
    issue: parsed.issue,
    assignee: parsed.assignee
  })
}

export const KANBAN_ORCHESTRATOR_HANDLERS: [string, ToolHandler<KanbanOrchestratorToolDeps>][] = [
  ['kanbanList', kanbanListTool],
  ['kanbanCreate', kanbanCreateTool],
  ['kanbanLink', kanbanLinkTool],
  ['kanbanUnblock', kanbanUnblockTool],
  ['kanbanAssign', kanbanAssignTool]
]
export const KANBAN_ORCHESTRATOR_ARG_SCHEMAS: [string, z.ZodType][] = [
  ['kanbanList', KANBAN_LIST_ARGS],
  ['kanbanCreate', KANBAN_CREATE_ARGS],
  ['kanbanLink', KANBAN_LINK_ARGS],
  ['kanbanUnblock', KANBAN_UNBLOCK_ARGS],
  ['kanbanAssign', KANBAN_ASSIGN_ARGS]
]
