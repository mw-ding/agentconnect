import { describe, expect, it } from 'vitest'
import {
  KANBAN_CARD_SHOW_MAX_RUNS,
  KANBAN_PROVIDER_FATAL_REASON_CODES,
  KANBAN_PROVIDER_REASON_CODES,
  KANBAN_PROVIDER_TRANSIENT_REASON_CODES,
  KANBAN_REASON_NO_TERMINAL_AFTER_NUDGE,
  KANBAN_REASON_NUDGE_DEFERRED,
  KANBAN_REASON_NUDGE_UNAVAILABLE,
  KanbanCardShow,
  KanbanCardShowOk,
  KanbanDispatch,
  KanbanDispatchOk,
  KanbanLeaseHeartbeat,
  KanbanOrchestrate,
  KanbanOrchestrateOk,
  KanbanReasonCode,
  KanbanReport,
  KanbanReportOk,
  KANBAN_ORCHESTRATE_REFUSAL_CODES,
  buildEnvelope,
  kanbanCardKey,
  kanbanCardKeyMarker,
  kanbanOrchestrateCardKey,
  parseKanbanCardKeyMarker,
  decodeEnvelope,
  isFrame
} from '../index.js'

const BOARD = '11111111-1111-4111-8111-111111111111'
const CARD = '22222222-2222-4222-8222-222222222222'
const AGENT = '33333333-3333-4333-8333-333333333333'
const LEASE = '44444444-4444-4444-8444-444444444444'

const dispatch = {
  boardId: BOARD,
  cardId: CARD,
  agentId: AGENT,
  repoId: '987654321',
  repoFullName: 'acme/web',
  issueNumber: 42,
  leaseId: LEASE,
  attempt: 1,
  dispatchRevision: '3',
  sessionKeyPrefix: 'github:987654321',
  mode: 'read' as const
}

const report = {
  boardId: BOARD,
  cardId: CARD,
  agentId: AGENT,
  leaseId: LEASE,
  attempt: 1,
  dispatchRevision: '3',
  outcome: 'failed' as const,
  reasonCode: 'turn_error'
}

describe('kanban wire (issue #2 M2)', () => {
  it('kanban/dispatch is a body-free lease grant (ids + fence only, strict)', () => {
    const decoded = decodeEnvelope(JSON.stringify(buildEnvelope('kanban/dispatch', dispatch)))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok || !isFrame('kanban/dispatch')(decoded.frame)) throw new Error('narrow')
    expect(decoded.frame.payload).toEqual(dispatch)
    // A smuggled title or body is rejected, never stripped silently.
    expect(KanbanDispatch.safeParse({ ...dispatch, title: 'Fix the login page' }).success).toBe(false)
    expect(KanbanDispatch.safeParse({ ...dispatch, body: 'secret' }).success).toBe(false)
    expect(decodeEnvelope(JSON.stringify(buildEnvelope('kanban/dispatch', { ...dispatch, body: 'x' }))).ok).toBe(false)
  })

  it('kanban/dispatch rejects malformed identities and fences', () => {
    const bad: Array<Record<string, unknown>> = [
      { repoId: 'acme/web' },
      { repoId: '0' },
      { issueNumber: 0 },
      { issueNumber: 1.5 },
      { attempt: 0 },
      { leaseId: 'not-a-uuid' },
      { dispatchRevision: '0' },
      { dispatchRevision: 3 },
      { sessionKeyPrefix: 'github:1#2' },
      { sessionKeyPrefix: '' },
      { repoFullName: 'acme web' },
      { mode: 'admin' }
    ]
    for (const patch of bad)
      expect(KanbanDispatch.safeParse({ ...dispatch, ...patch }).success, JSON.stringify(patch)).toBe(false)
    const { agentId: _, ...missingAgent } = dispatch
    expect(KanbanDispatch.safeParse(missingAgent).success).toBe(false)
    expect(KanbanDispatch.safeParse({ ...dispatch, sessionKeyPrefix: 'acme/web', mode: 'write' }).success).toBe(true)
  })

  it('kanban/dispatch/ok carries a typed refusal only when not accepted', () => {
    expect(KanbanDispatchOk.safeParse({ leaseId: LEASE, accepted: true }).success).toBe(true)
    expect(
      KanbanDispatchOk.safeParse({ leaseId: LEASE, accepted: false, reason: 'write_needs_worktree' }).success
    ).toBe(true)
    expect(KanbanDispatchOk.safeParse({ leaseId: LEASE, accepted: false }).success).toBe(false)
    expect(KanbanDispatchOk.safeParse({ leaseId: LEASE, accepted: true, reason: 'busy' }).success).toBe(false)
    expect(KanbanDispatchOk.safeParse({ leaseId: LEASE, accepted: false, reason: 'because I said so' }).success).toBe(
      false
    )
  })

  it('kanban/lease-heartbeat names leases and liveness only', () => {
    const beat = {
      leases: [{ leaseId: LEASE, cardId: CARD, dispatchRevision: '3', liveness: 'turn', sessionId: 's-1' }]
    }
    expect(decodeEnvelope(JSON.stringify(buildEnvelope('kanban/lease-heartbeat', beat))).ok).toBe(true)
    expect(KanbanLeaseHeartbeat.safeParse({ leases: [{ ...beat.leases[0], summary: 'did stuff' }] }).success).toBe(
      false
    )
    expect(KanbanLeaseHeartbeat.safeParse({ leases: [{ ...beat.leases[0], liveness: 'thinking' }] }).success).toBe(
      false
    )
    const many = Array.from({ length: 257 }, () => beat.leases[0])
    expect(KanbanLeaseHeartbeat.safeParse({ leases: many }).success).toBe(false)
  })

  it('kanban/report is body-free and requires blockKind exactly when blocked', () => {
    expect(decodeEnvelope(JSON.stringify(buildEnvelope('kanban/report', report))).ok).toBe(true)
    expect(KanbanReport.safeParse({ ...report, summary: 'free text' }).success).toBe(false)
    expect(KanbanReport.safeParse({ ...report, reasonCode: 'Contains spaces and CAPS' }).success).toBe(false)
    expect(KanbanReport.safeParse({ ...report, outcome: 'reclaimed' }).success).toBe(false)
    expect(KanbanReport.safeParse({ ...report, outcome: 'blocked' }).success).toBe(false)
    expect(KanbanReport.safeParse({ ...report, outcome: 'blocked', blockKind: 'needs_input' }).success).toBe(true)
    expect(KanbanReport.safeParse({ ...report, blockKind: 'needs_input' }).success).toBe(false)
    expect(KanbanReportOk.safeParse({ leaseId: LEASE, accepted: false, reason: 'superseded' }).success).toBe(true)
  })

  it('provider and nudge reason codes all satisfy KanbanReasonCode and ride a report', () => {
    expect(new Set(KANBAN_PROVIDER_REASON_CODES).size).toBe(8)
    expect([...KANBAN_PROVIDER_TRANSIENT_REASON_CODES, ...KANBAN_PROVIDER_FATAL_REASON_CODES]).toEqual([
      ...KANBAN_PROVIDER_REASON_CODES
    ])
    for (const code of [
      ...KANBAN_PROVIDER_REASON_CODES,
      KANBAN_REASON_NO_TERMINAL_AFTER_NUDGE,
      KANBAN_REASON_NUDGE_UNAVAILABLE,
      KANBAN_REASON_NUDGE_DEFERRED
    ]) {
      expect(KanbanReasonCode.safeParse(code).success, code).toBe(true)
      expect(KanbanReport.safeParse({ ...report, outcome: 'transient', reasonCode: code }).success, code).toBe(true)
    }
  })

  const run = {
    attempt: 1,
    outcome: 'transient',
    reasonCode: 'provider_rate_limited',
    dispatchedAt: 't0',
    endedAt: 't1'
  }
  const card = {
    status: 'running',
    priority: 2,
    attempt: 2,
    mode: 'read' as const,
    blockKind: null,
    consecutiveFailures: 0,
    protocolViolations: 1,
    blockRecurrence: 0,
    linkedPrNumber: null,
    runs: [run]
  }

  it('kanban/card is ids and the lease fence only, strict', () => {
    const req = { boardId: BOARD, cardId: CARD, leaseId: LEASE, dispatchRevision: '3' }
    expect(decodeEnvelope(JSON.stringify(buildEnvelope('kanban/card', req))).ok).toBe(true)
    expect(KanbanCardShow.safeParse({ ...req, title: 'x' }).success).toBe(false)
    expect(KanbanCardShow.safeParse({ ...req, dispatchRevision: '0' }).success).toBe(false)
    const { leaseId: _, ...noLease } = req
    expect(KanbanCardShow.safeParse(noLease).success).toBe(false)
  })

  it('kanban/card/ok returns bounded body-free metadata or a superseded refusal', () => {
    expect(
      decodeEnvelope(JSON.stringify(buildEnvelope('kanban/card/ok', { leaseId: LEASE, accepted: true, card }))).ok
    ).toBe(true)
    expect(KanbanCardShowOk.safeParse({ leaseId: LEASE, accepted: false, reason: 'superseded' }).success).toBe(true)
    expect(KanbanCardShowOk.safeParse({ leaseId: LEASE, accepted: false }).success).toBe(false)
    expect(KanbanCardShowOk.safeParse({ leaseId: LEASE, accepted: true, card: { ...card, title: 'x' } }).success).toBe(
      false
    )
    const runs = Array.from({ length: KANBAN_CARD_SHOW_MAX_RUNS + 1 }, () => run)
    expect(KanbanCardShowOk.safeParse({ leaseId: LEASE, accepted: true, card: { ...card, runs } }).success).toBe(false)
    expect(
      KanbanCardShowOk.safeParse({
        leaseId: LEASE,
        accepted: true,
        card: { ...card, runs: [{ ...run, summary: 'x' }] }
      }).success
    ).toBe(false)
  })

  it('kanban/orchestrate is discriminated by op and body-free (title/body/text rejected everywhere)', () => {
    const create = {
      agentId: AGENT,
      boardId: BOARD,
      step: 'decompose.login',
      specDigest: 'a'.repeat(64)
    }
    const commit = { ...create, issueNumber: 42 }
    const cases: Array<Record<string, unknown>> = [
      { op: 'list', agentId: AGENT },
      { op: 'list', agentId: AGENT, boardId: BOARD, status: 'todo' },
      { op: 'prepare_create', ...create },
      { op: 'prepare_create', ...create, assignee: 'ash', priority: 2, status: 'todo' },
      { op: 'commit_create', ...commit },
      { op: 'commit_create', ...commit, blockedBy: [1, 2] },
      { op: 'link', agentId: AGENT, boardId: BOARD, issueNumber: 7, blockedBy: [3], parentIssueNumber: 1 },
      { op: 'unblock', agentId: AGENT, boardId: BOARD, issueNumber: 7 },
      { op: 'unblock', agentId: AGENT, boardId: BOARD, issueNumber: 7, blockers: [3] },
      { op: 'assign', agentId: AGENT, boardId: BOARD, issueNumber: 7, assignee: 'ash' },
      { op: 'assign', agentId: AGENT, boardId: BOARD, issueNumber: 7, assignee: null }
    ]
    for (const payload of cases) {
      expect(KanbanOrchestrate.safeParse(payload).success, JSON.stringify(payload)).toBe(true)
      expect(decodeEnvelope(JSON.stringify(buildEnvelope('kanban/orchestrate', payload))).ok).toBe(true)
    }
    // Every request carries the agent id and (except list) the board id; no issue text of any kind crosses.
    const list = { op: 'list' }
    expect(KanbanOrchestrate.safeParse(list).success).toBe(false)
    const noBoard = { op: 'prepare_create', agentId: AGENT, step: 's', specDigest: 'a'.repeat(64) }
    expect(KanbanOrchestrate.safeParse(noBoard).success).toBe(false)
    for (const key of ['title', 'body', 'text']) {
      expect(KanbanOrchestrate.safeParse({ ...commit, [key]: 'secret' }).success, key).toBe(false)
      expect(KanbanOrchestrate.safeParse({ ...create, [key]: 'secret' }).success, key).toBe(false)
    }
    // Malformed identities: bad step, non-hex spec digest, oversized blocker list, bad slug.
    expect(KanbanOrchestrate.safeParse({ ...create, step: 'Bad Step!' }).success).toBe(false)
    expect(KanbanOrchestrate.safeParse({ ...create, step: 'x'.repeat(65) }).success).toBe(false)
    expect(KanbanOrchestrate.safeParse({ ...create, specDigest: 'ZZ'.repeat(32) }).success).toBe(false)
    expect(KanbanOrchestrate.safeParse({ ...create, specDigest: 'a'.repeat(63) }).success).toBe(false)
    expect(
      KanbanOrchestrate.safeParse({ ...commit, blockedBy: Array.from({ length: 21 }, (_, i) => i + 1) }).success
    ).toBe(false)
    expect(KanbanOrchestrate.safeParse({ ...create, assignee: 'UPPER CASE' }).success).toBe(false)
    expect(
      KanbanOrchestrate.safeParse({ op: 'assign', agentId: AGENT, boardId: BOARD, issueNumber: 1, assignee: 'UPPER' })
        .success
    ).toBe(false)
    expect(KanbanOrchestrate.safeParse({ ...create, status: 'ready' }).success).toBe(false)
  })

  it('kanban/orchestrate bounds blockers, priority, and the list reply', () => {
    const base = { agentId: AGENT, boardId: BOARD, issueNumber: 7 }
    const many = Array.from({ length: 21 }, (_, i) => i + 1)
    expect(KanbanOrchestrate.safeParse({ op: 'unblock', ...base, blockers: many }).success).toBe(false)
    expect(KanbanOrchestrate.safeParse({ op: 'unblock', ...base, blockers: many.slice(0, 20) }).success).toBe(true)
    expect(KanbanOrchestrate.safeParse({ op: 'link', ...base, blockedBy: many }).success).toBe(false)
    const create = { op: 'prepare_create', agentId: AGENT, boardId: BOARD, step: 's', specDigest: 'a'.repeat(64) }
    for (const priority of [-1000, 0, 1000]) {
      expect(KanbanOrchestrate.safeParse({ ...create, priority }).success, String(priority)).toBe(true)
    }
    for (const priority of [-1001, 1001, 2 ** 31, 1.5]) {
      expect(KanbanOrchestrate.safeParse({ ...create, priority }).success, String(priority)).toBe(false)
    }
    const list = (boards: unknown[]) => KanbanOrchestrateOk.safeParse({ ok: true, op: 'list', truncated: true, boards })
    const card = {
      issueNumber: 1,
      status: 'todo',
      assigneeAgentId: null,
      assigneeSlug: null,
      priority: 0,
      blockKind: null,
      epicIssueNumber: null,
      leased: false
    }
    const board = (over: Record<string, unknown> = {}) => ({
      boardId: BOARD,
      repoFullName: 'acme/web',
      cards: [],
      ...over
    })
    expect(list([board({ cards: Array.from({ length: 200 }, () => card) })]).success).toBe(true)
    expect(list([board({ cards: Array.from({ length: 201 }, () => card) })]).success).toBe(false)
    expect(list(Array.from({ length: 101 }, () => board())).success).toBe(false)
    for (const repoFullName of ['acme', 'acme/web/x', '-acme/web', 'acme/we b', '']) {
      expect(list([board({ repoFullName })]).success, repoFullName).toBe(false)
    }
    expect(list([board({ repoFullName: 'Acme-Org/web.site_2' })]).success).toBe(true)
  })

  it('every refusal code rides kanban/orchestrate/ok', () => {
    for (const code of KANBAN_ORCHESTRATE_REFUSAL_CODES) {
      expect(KanbanOrchestrateOk.safeParse({ ok: false, op: 'commit_create', code }).success, code).toBe(true)
    }
    expect(KANBAN_ORCHESTRATE_REFUSAL_CODES).toEqual(
      expect.arrayContaining(['repo_mismatch', 'status_not_allowed', 'card_conflict'])
    )
  })

  it('the B1 key helper keys on the epic issue number (or the board) and its marker round-trips', () => {
    const digest = 'b'.repeat(64)
    expect(kanbanOrchestrateCardKey({ boardId: BOARD, epicIssueNumber: 5, step: 's', specDigest: digest })).toBe(
      kanbanCardKey({ epic: '5', step: 's', spec: digest })
    )
    expect(kanbanOrchestrateCardKey({ boardId: BOARD, step: 's', specDigest: digest })).toBe(
      kanbanCardKey({ epic: `board:${BOARD}`, step: 's', spec: digest })
    )
    const key = kanbanOrchestrateCardKey({ boardId: BOARD, step: 's', specDigest: digest })
    expect(parseKanbanCardKeyMarker(`body text\n\n${kanbanCardKeyMarker(key)}\n`)).toBe(key)
    expect(parseKanbanCardKeyMarker('no marker')).toBeNull()
    expect(parseKanbanCardKeyMarker(null)).toBeNull()
    expect(parseKanbanCardKeyMarker('<!-- agentconnect:kanban-card-key:XYZ -->')).toBeNull()
    expect(() => kanbanCardKeyMarker('not-hex')).toThrow()
  })

  it('kanban/orchestrate/ok answers data or a stable refusal code', () => {
    expect(KanbanOrchestrateOk.safeParse({ ok: true, op: 'prepare_create', verdict: 'proceed' }).success).toBe(true)
    expect(
      KanbanOrchestrateOk.safeParse({ ok: true, op: 'prepare_create', verdict: 'existing', issueNumber: 5 }).success
    ).toBe(true)
    expect(KanbanOrchestrateOk.safeParse({ ok: true, op: 'commit_create', cardId: CARD, issueNumber: 5 }).success).toBe(
      true
    )
    expect(KanbanOrchestrateOk.safeParse({ ok: true, op: 'link' }).success).toBe(true)
    expect(KanbanOrchestrateOk.safeParse({ ok: true, op: 'unblock', status: 'todo' }).success).toBe(true)
    expect(KanbanOrchestrateOk.safeParse({ ok: true, op: 'unblock', status: 'todo', truncated: true }).success).toBe(
      true
    )
    expect(KanbanOrchestrateOk.safeParse({ ok: true, op: 'assign', assigned: false }).success).toBe(true)
    expect(
      KanbanOrchestrateOk.safeParse({
        ok: true,
        op: 'list',
        truncated: false,
        boards: [{ boardId: BOARD, repoFullName: 'acme/web', cards: [] }]
      }).success
    ).toBe(true)
    expect(
      KanbanOrchestrateOk.safeParse({ ok: false, op: 'prepare_create', code: 'epic_budget_exhausted' }).success
    ).toBe(true)
    expect(KanbanOrchestrateOk.safeParse({ ok: false, op: 'prepare_create', code: 'not_a_code' }).success).toBe(false)
    expect(KanbanOrchestrateOk.safeParse({ ok: false, op: 'prepare_create' }).success).toBe(false)
    // The reply is body-free too: a title on any ok shape is rejected.
    expect(
      KanbanOrchestrateOk.safeParse({ ok: true, op: 'commit_create', cardId: CARD, issueNumber: 5, title: 'x' }).success
    ).toBe(false)
  })
})

it('vera-349: prepare advertises optional nullable App identity in a strict body-free reply', () => {
  const reply = { ok: true, op: 'prepare_create', verdict: 'proceed' }
  for (const appLogin of ['acme-app[bot]', null]) {
    expect(KanbanOrchestrateOk.safeParse({ ...reply, appLogin }).success).toBe(true)
  }
  expect(KanbanOrchestrateOk.safeParse(reply).success).toBe(true)
  for (const appLogin of ['', 123, {}, 'a'.repeat(101)]) {
    expect(KanbanOrchestrateOk.safeParse({ ...reply, appLogin }).success).toBe(false)
  }
  expect(KanbanOrchestrateOk.safeParse({ ...reply, appLogin: 'app[bot]', body: 'secret' }).success).toBe(false)
})
