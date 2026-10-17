import { z } from 'zod'
import { GithubNumericId } from './relay-cp.js'

// Kanban dispatch wire (issue #2 M2, D2/D3): every frame is strict and body-free, so no issue title, body, or comment can ride it.

/** Decimal wire form for the card's bigint `dispatchRevision` fence. */
const KanbanRevision = z.string().regex(/^[1-9]\d*$/)

/** Short machine code only; free text never crosses to the CP. */
export const KanbanReasonCode = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_:-]+$/)
export type KanbanReasonCode = z.infer<typeof KanbanReasonCode>

/** Provider failures the daemon classifies from a turn's ACP error: transient ones report `transient`, fatal ones `failed`. */
export const KANBAN_PROVIDER_TRANSIENT_REASON_CODES = [
  'provider_rate_limited',
  'provider_network',
  'provider_overloaded',
  'provider_server_error'
] as const
export const KANBAN_PROVIDER_FATAL_REASON_CODES = [
  'provider_auth',
  'provider_invalid_request',
  'provider_context_overflow',
  'agent_crashed'
] as const
export const KANBAN_PROVIDER_REASON_CODES = [
  ...KANBAN_PROVIDER_TRANSIENT_REASON_CODES,
  ...KANBAN_PROVIDER_FATAL_REASON_CODES
] as const
export type KanbanProviderReasonCode = (typeof KANBAN_PROVIDER_REASON_CODES)[number]

/** Protocol-violation reasons: the dispatched turn ended without a terminal call, and the one nudge did not fix it. */
export const KANBAN_REASON_NO_TERMINAL_CALL = 'no_terminal_call'
export const KANBAN_REASON_NO_TERMINAL_AFTER_NUDGE = 'no_terminal_call_after_nudge'
export const KANBAN_REASON_NUDGE_UNAVAILABLE = 'nudge_unavailable'
/** A nudge was refused because the agent is paused or the daemon is draining: not the card's fault, so it reports transient instead of a protocol violation. */
export const KANBAN_REASON_NUDGE_DEFERRED = 'nudge_deferred'

/** The run's mode, chosen from CP configuration (never a label); a write run needs its own session worktree. */
export const KanbanRunMode = z.enum(['read', 'write'])
export type KanbanRunMode = z.infer<typeof KanbanRunMode>

export const KANBAN_BLOCK_KINDS = ['dependency', 'needs_input', 'capability', 'transient'] as const
export const KanbanBlockKind = z.enum(KANBAN_BLOCK_KINDS)
export type KanbanBlockKind = z.infer<typeof KanbanBlockKind>

/** `kanban/dispatch` (C→D REQ): D3's ids plus the agent, fence revision, D4 thread-key prefix, `gh -R` name, and mode. */
export const KanbanDispatch = z
  .object({
    boardId: z.string().uuid(),
    cardId: z.string().uuid(),
    agentId: z.string().uuid(),
    repoId: GithubNumericId,
    repoFullName: z
      .string()
      .min(3)
      .max(200)
      .regex(/^[\w.-]+\/[\w.-]+$/),
    issueNumber: z.number().int().positive(),
    leaseId: z.string().uuid(),
    attempt: z.number().int().positive(),
    dispatchRevision: KanbanRevision,
    // `github:<repoId>` or a legacy `owner/repo`; the session key is `<prefix>#<issueNumber>`.
    sessionKeyPrefix: z.string().regex(/^[^#\s]{1,200}$/),
    mode: KanbanRunMode
  })
  .strict()
export type KanbanDispatch = z.infer<typeof KanbanDispatch>

/** Why a daemon refused a dispatch; `write_needs_worktree` and `no_agent` are capability refusals, the rest transient. */
export const KanbanDispatchRefusal = z.enum([
  'no_agent',
  'write_needs_worktree',
  'paused',
  'draining',
  'busy',
  'durability'
])
export type KanbanDispatchRefusal = z.infer<typeof KanbanDispatchRefusal>

export const KanbanDispatchOk = z.discriminatedUnion('accepted', [
  z.object({ leaseId: z.string().uuid(), accepted: z.literal(true) }).strict(),
  z.object({ leaseId: z.string().uuid(), accepted: z.literal(false), reason: KanbanDispatchRefusal }).strict()
])
export type KanbanDispatchOk = z.infer<typeof KanbanDispatchOk>

/** One lease the daemon observed alive this beat: a live turn, or background tasks still running for the session. */
export const KanbanLeaseBeat = z
  .object({
    leaseId: z.string().uuid(),
    cardId: z.string().uuid(),
    dispatchRevision: KanbanRevision,
    liveness: z.enum(['turn', 'background']),
    sessionId: z.string().min(1).max(200).optional()
  })
  .strict()
export type KanbanLeaseBeat = z.infer<typeof KanbanLeaseBeat>

export const KANBAN_MAX_LEASES_PER_BEAT = 256

/** `kanban/lease-heartbeat` (D→C REQ → `kanban/lease-heartbeat/ok`) — daemon-derived, never model-remembered. */
export const KanbanLeaseHeartbeat = z
  .object({ leases: z.array(KanbanLeaseBeat).max(KANBAN_MAX_LEASES_PER_BEAT) })
  .strict()
export type KanbanLeaseHeartbeat = z.infer<typeof KanbanLeaseHeartbeat>

/** Leases the CP no longer honors (reaped, revoked, or reassigned); the daemon stops beating them. */
export const KanbanLeaseHeartbeatOk = z
  .object({ superseded: z.array(z.string().uuid()).max(KANBAN_MAX_LEASES_PER_BEAT) })
  .strict()
export type KanbanLeaseHeartbeatOk = z.infer<typeof KanbanLeaseHeartbeatOk>

/** Terminal outcomes a worker run may report; `reclaimed` is CP-only (the reaper), so it is not on the wire. */
export const KanbanReportOutcome = z.enum([
  'completed',
  'review_requested',
  'blocked',
  'failed',
  'protocol_violation',
  'transient'
])
export type KanbanReportOutcome = z.infer<typeof KanbanReportOutcome>

/** `kanban/report` (D→C REQ → `kanban/report/ok`) — one run ended; held in the daemon outbox until the CP answers. */
export const KanbanReport = z
  .object({
    boardId: z.string().uuid(),
    cardId: z.string().uuid(),
    agentId: z.string().uuid(),
    leaseId: z.string().uuid(),
    attempt: z.number().int().positive(),
    dispatchRevision: KanbanRevision,
    outcome: KanbanReportOutcome,
    blockKind: KanbanBlockKind.optional(),
    reasonCode: KanbanReasonCode.optional(),
    sessionId: z.string().min(1).max(200).optional(),
    prNumber: z.number().int().positive().optional()
  })
  .strict()
  .superRefine((report, ctx) => {
    if ((report.outcome === 'blocked') !== (report.blockKind !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['blockKind'], message: 'blockKind is required exactly when blocked' })
    }
  })
export type KanbanReport = z.infer<typeof KanbanReport>

/** A superseded run's report is answered as data (`accepted:false`), so the daemon drops its outbox row. */
export const KanbanReportOk = z
  .object({
    leaseId: z.string().uuid(),
    accepted: z.boolean(),
    reason: z.enum(['superseded']).optional()
  })
  .strict()
export type KanbanReportOk = z.infer<typeof KanbanReportOk>

/** Longest progress note a worker may post to its card's issue. */
export const KANBAN_COMMENT_MAX_CHARS = 4_000

/** Prior runs are bounded so a long-lived card cannot grow the reply. */
export const KANBAN_CARD_SHOW_MAX_RUNS = 10

/** `kanban/card` (D→C REQ → `kanban/card/ok`) — the worker's own leased card; ids and the lease fence only, never a title or body. */
export const KanbanCardShow = z
  .object({
    boardId: z.string().uuid(),
    cardId: z.string().uuid(),
    leaseId: z.string().uuid(),
    dispatchRevision: KanbanRevision
  })
  .strict()
export type KanbanCardShow = z.infer<typeof KanbanCardShow>

export const KanbanCardRun = z
  .object({
    attempt: z.number().int().positive(),
    outcome: z.string().min(1).max(40).nullable(),
    reasonCode: KanbanReasonCode.nullable(),
    dispatchedAt: z.string().max(40),
    endedAt: z.string().max(40).nullable()
  })
  .strict()
export type KanbanCardRun = z.infer<typeof KanbanCardRun>

/** Body-free card metadata; a superseded or unknown lease is answered as data (`accepted:false`). */
export const KanbanCardShowOk = z.discriminatedUnion('accepted', [
  z
    .object({
      leaseId: z.string().uuid(),
      accepted: z.literal(true),
      card: z
        .object({
          status: z.string().min(1).max(40),
          priority: z.number().int(),
          attempt: z.number().int().positive(),
          mode: KanbanRunMode,
          blockKind: KanbanBlockKind.nullable(),
          consecutiveFailures: z.number().int().nonnegative(),
          protocolViolations: z.number().int().nonnegative(),
          blockRecurrence: z.number().int().nonnegative(),
          linkedPrNumber: z.number().int().positive().nullable(),
          runs: z.array(KanbanCardRun).max(KANBAN_CARD_SHOW_MAX_RUNS)
        })
        .strict()
    })
    .strict(),
  z.object({ leaseId: z.string().uuid(), accepted: z.literal(false), reason: z.enum(['superseded']) }).strict()
])
export type KanbanCardShowOk = z.infer<typeof KanbanCardShowOk>

// ── kanban/orchestrate (issue #2 M3, Lane 2b): the orchestrator agent's create/link/assign surface.
// Body-free like every other kanban frame: a spec digest, not spec text, crosses; the daemon files the issue body.

/** A decomposition step id; short machine code only. */
export const KanbanOrchestrateStep = z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,63}$/)
/** sha256 of the masked title+body; the CP computes the B1 key from this, never from the spec text. */
export const KanbanSpecDigest = z.string().regex(/^[0-9a-f]{64}$/)
/** An orchestrator may only ever file into triage/todo; promotion past todo stays with humans/reconciler (D5). */
export const KanbanOrchestrateStatus = z.enum(['triage', 'todo'])
/** `ac/agent:<slug>` assignee; the CP resolves the slug against the board's org. */
export const KanbanAssigneeSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
export const KANBAN_ORCHESTRATE_MAX_BLOCKERS = 20

/** `list` → boards this agent orchestrates and their cards, bounded with a `truncated` flag. */
export const KanbanOrchestrateList = z
  .object({
    op: z.literal('list'),
    agentId: z.string().uuid(),
    boardId: z.string().uuid().optional(),
    status: z.string().min(1).max(40).optional()
  })
  .strict()
export type KanbanOrchestrateList = z.infer<typeof KanbanOrchestrateList>

/** Fields shared by the create op pair. */
const KanbanOrchestrateCreateFields = {
  agentId: z.string().uuid(),
  boardId: z.string().uuid(),
  epicIssueNumber: z.number().int().positive().optional(),
  step: KanbanOrchestrateStep,
  specDigest: KanbanSpecDigest,
  assignee: KanbanAssigneeSlug.optional(),
  priority: z.number().int().optional(),
  status: KanbanOrchestrateStatus.optional()
}

/** `prepare_create` asks whether to file, before anything is filed; an existing B1 key answers `existing`. */
export const KanbanOrchestratePrepareCreate = z
  .object({ op: z.literal('prepare_create'), ...KanbanOrchestrateCreateFields })
  .strict()
export type KanbanOrchestratePrepareCreate = z.infer<typeof KanbanOrchestratePrepareCreate>

/** `commit_create` registers the issue the daemon just filed; `blockedBy` are same-repo card issue numbers. */
export const KanbanOrchestrateCommitCreate = z
  .object({
    op: z.literal('commit_create'),
    ...KanbanOrchestrateCreateFields,
    issueNumber: z.number().int().positive(),
    blockedBy: z.array(z.number().int().positive()).max(KANBAN_ORCHESTRATE_MAX_BLOCKERS).optional()
  })
  .strict()
export type KanbanOrchestrateCommitCreate = z.infer<typeof KanbanOrchestrateCommitCreate>

export const KanbanOrchestrateLink = z
  .object({
    op: z.literal('link'),
    agentId: z.string().uuid(),
    boardId: z.string().uuid(),
    issueNumber: z.number().int().positive(),
    blockedBy: z.array(z.number().int().positive()).max(KANBAN_ORCHESTRATE_MAX_BLOCKERS).optional(),
    parentIssueNumber: z.number().int().positive().optional()
  })
  .strict()
export type KanbanOrchestrateLink = z.infer<typeof KanbanOrchestrateLink>

export const KanbanOrchestrateUnblock = z
  .object({
    op: z.literal('unblock'),
    agentId: z.string().uuid(),
    boardId: z.string().uuid(),
    issueNumber: z.number().int().positive(),
    blockers: z.array(z.number().int().positive()).optional()
  })
  .strict()
export type KanbanOrchestrateUnblock = z.infer<typeof KanbanOrchestrateUnblock>

export const KanbanOrchestrateAssign = z
  .object({
    op: z.literal('assign'),
    agentId: z.string().uuid(),
    boardId: z.string().uuid(),
    issueNumber: z.number().int().positive(),
    assignee: z.union([z.literal(null), KanbanAssigneeSlug])
  })
  .strict()
export type KanbanOrchestrateAssign = z.infer<typeof KanbanOrchestrateAssign>

/** `kanban/orchestrate` (D→C REQ): discriminated by `op`, every arm strict and body-free. */
export const KanbanOrchestrate = z.discriminatedUnion('op', [
  KanbanOrchestrateList,
  KanbanOrchestratePrepareCreate,
  KanbanOrchestrateCommitCreate,
  KanbanOrchestrateLink,
  KanbanOrchestrateUnblock,
  KanbanOrchestrateAssign
])
export type KanbanOrchestrate = z.infer<typeof KanbanOrchestrate>

export const KANBAN_ORCHESTRATE_REFUSAL_CODES = [
  'not_orchestrator',
  'board_not_found',
  'board_disabled',
  'epic_not_found',
  'epic_budget_exhausted',
  'card_not_found',
  'issue_not_found',
  'issue_not_from_app',
  'unknown_agent',
  'agent_not_assignable',
  'key_conflict',
  'issue_mismatch',
  'invalid_link',
  'cross_repo',
  'github_unavailable',
  'github_partial'
] as const
export type KanbanOrchestrateRefusalCode = (typeof KANBAN_ORCHESTRATE_REFUSAL_CODES)[number]
export const KanbanOrchestrateRefusalCode = z.enum(KANBAN_ORCHESTRATE_REFUSAL_CODES)

/** Refusals-as-data: a stable code, never a message, so the daemon can translate it. */
export const KanbanOrchestrateRefusal = z
  .object({
    ok: z.literal(false),
    op: z.string().min(1).max(40),
    code: KanbanOrchestrateRefusalCode
  })
  .strict()
export type KanbanOrchestrateRefusal = z.infer<typeof KanbanOrchestrateRefusal>

export const KanbanOrchestrateCard = z
  .object({
    issueNumber: z.number().int().positive(),
    status: z.string().min(1).max(40),
    assigneeAgentId: z.string().uuid().nullable(),
    assigneeSlug: z.string().nullable(),
    priority: z.number().int(),
    blockKind: z.string().min(1).max(40).nullable(),
    epicIssueNumber: z.number().int().positive().nullable(),
    leased: z.boolean()
  })
  .strict()
export type KanbanOrchestrateCard = z.infer<typeof KanbanOrchestrateCard>

export const KanbanOrchestrateBoard = z
  .object({
    boardId: z.string().uuid(),
    repoFullName: z.string(),
    cards: z.array(KanbanOrchestrateCard)
  })
  .strict()

export const KanbanOrchestrateListOk = z
  .object({
    ok: z.literal(true),
    op: z.literal('list'),
    truncated: z.boolean(),
    boards: z.array(KanbanOrchestrateBoard)
  })
  .strict()

export const KanbanOrchestratePrepareCreateOk = z
  .object({
    ok: z.literal(true),
    op: z.literal('prepare_create'),
    verdict: z.enum(['existing', 'proceed']),
    issueNumber: z.number().int().positive().optional()
  })
  .strict()

export const KanbanOrchestrateCommitCreateOk = z
  .object({
    ok: z.literal(true),
    op: z.literal('commit_create'),
    cardId: z.string().uuid(),
    issueNumber: z.number().int().positive()
  })
  .strict()

export const KanbanOrchestrateLinkOk = z.object({ ok: z.literal(true), op: z.literal('link') }).strict()

export const KanbanOrchestrateUnblockOk = z
  .object({ ok: z.literal(true), op: z.literal('unblock'), status: z.string().min(1).max(40) })
  .strict()

export const KanbanOrchestrateAssignOk = z
  .object({ ok: z.literal(true), op: z.literal('assign'), assigned: z.boolean() })
  .strict()

/** `kanban/orchestrate/ok` (C→D REP): one ok shape per op, or a refusal-as-data. */
export const KanbanOrchestrateOk = z.union([
  KanbanOrchestrateRefusal,
  KanbanOrchestrateListOk,
  KanbanOrchestratePrepareCreateOk,
  KanbanOrchestrateCommitCreateOk,
  KanbanOrchestrateLinkOk,
  KanbanOrchestrateUnblockOk,
  KanbanOrchestrateAssignOk
])
export type KanbanOrchestrateOk = z.infer<typeof KanbanOrchestrateOk>
