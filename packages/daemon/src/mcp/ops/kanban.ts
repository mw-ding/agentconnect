import { z } from 'zod'
import { KANBAN_BLOCK_KINDS, KANBAN_COMMENT_MAX_CHARS } from '@agentconnect.md/protocol'
import { KANBAN_REASON_MAX_CHARS, KANBAN_SUMMARY_MAX_CHARS, type KanbanTerminal } from '../../kanban/kanban-worker.js'
import type { SessionContext, ToolHandler } from './context.js'
import { optionalBoundedInt, parseArgs, requiredEnum } from './args.js'

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
  /** The live lease's role for a session, or undefined when no lease holds it; gates the verifier-only tools. */
  kanbanLeaseRole?: (req: KanbanSessionReq) => 'work' | 'verify' | undefined
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
export const KANBAN_REQUEST_CHANGES_ARGS = z.strictObject({ reason }, unexpectedKeys)

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
  if (deps.kanbanLeaseRole?.(sessionReq(ctx)) === 'verify') {
    throw new Error(
      'verifier_cannot_request_review: a verifier cannot request review; call kanbanComplete to approve or kanbanRequestChanges.'
    )
  }
  const parsed = parseArgs(KANBAN_REQUEST_REVIEW_ARGS, args)
  return record(ctx, deps, {
    outcome: 'review_requested',
    summary: parsed.summary,
    ...(parsed.prNumber ? { prNumber: parsed.prNumber } : {})
  })
}

export const kanbanRequestChanges: ToolHandler<KanbanDeps> = (ctx, args, deps) => {
  if (deps.kanbanLeaseRole?.(sessionReq(ctx)) !== 'verify') {
    throw new Error('not_verifier: kanbanRequestChanges is only available to a verifier run reviewing this card.')
  }
  const parsed = parseArgs(KANBAN_REQUEST_CHANGES_ARGS, args)
  return record(ctx, deps, {
    outcome: 'changes_requested',
    summary: '',
    reason: parsed.reason
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
  ['kanbanRequestChanges', kanbanRequestChanges],
  ['kanbanBlock', kanbanBlock],
  ['kanbanFail', kanbanFail],
  ['kanbanShow', kanbanShow],
  ['kanbanComment', kanbanComment]
]
export const KANBAN_ARG_SCHEMAS: [string, z.ZodType][] = [
  ['kanbanComplete', KANBAN_COMPLETE_ARGS],
  ['kanbanRequestReview', KANBAN_REQUEST_REVIEW_ARGS],
  ['kanbanRequestChanges', KANBAN_REQUEST_CHANGES_ARGS],
  ['kanbanBlock', KANBAN_BLOCK_ARGS],
  ['kanbanFail', KANBAN_FAIL_ARGS],
  ['kanbanShow', KANBAN_SHOW_ARGS],
  ['kanbanComment', KANBAN_COMMENT_ARGS]
]
