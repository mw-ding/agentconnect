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
  KanbanNotify,
  KanbanNotifyOk,
  KanbanReasonCode,
  KanbanReport,
  KanbanReportOk,
  buildEnvelope,
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

  it('kanban/dispatch carries an optional role: absent = work, and older frames without it still parse', () => {
    expect(KanbanDispatch.safeParse(dispatch).success).toBe(true)
    expect(KanbanDispatch.safeParse({ ...dispatch, role: 'work' }).success).toBe(true)
    expect(KanbanDispatch.safeParse({ ...dispatch, role: 'verify' }).success).toBe(true)
    expect(KanbanDispatch.safeParse({ ...dispatch, role: 'admin' }).success).toBe(false)
    const parsed = KanbanDispatch.parse(dispatch)
    expect(parsed.role).toBeUndefined()
    expect(KanbanDispatch.parse({ ...dispatch, role: 'verify' }).role).toBe('verify')
  })

  it('kanban/report accepts changes_requested, a verifier-only outcome', () => {
    expect(KanbanReport.safeParse({ ...report, outcome: 'changes_requested' }).success).toBe(true)
    expect(KanbanReport.safeParse({ ...report, outcome: 'changes_requested', reasonCode: undefined }).success).toBe(
      true
    )
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
})

describe('kanban/notify', () => {
  const base = {
    notifyId: '66666666-6666-4666-8666-666666666666',
    boardId: BOARD,
    cardId: CARD,
    repoFullName: 'acme/web',
    issueNumber: 7,
    from: 'running',
    to: 'blocked',
    target: { platform: 'slack', channel: 'C0ANCHOR', integrationId: AGENT }
  }

  it('parses with and without the optional detail and mention', () => {
    expect(KanbanNotify.parse(base)).toEqual(base)
    const full = {
      ...base,
      blockKind: 'needs_input',
      reasonCode: 'x_y',
      tripped: 'review_round_limit',
      mention: { slackUserId: 'U1' }
    }
    expect(KanbanNotify.parse(full)).toEqual(full)
  })

  it('rejects unknown keys so a body can never ride the frame', () => {
    expect(() => KanbanNotify.parse({ ...base, title: 'secret' })).toThrow()
    expect(() => KanbanNotify.parse({ ...base, target: { ...base.target, text: 'hi' } })).toThrow()
  })

  it('round-trips both frames through the envelope registry', () => {
    expect(decodeEnvelope(JSON.stringify(buildEnvelope('kanban/notify', base))).ok).toBe(true)
    expect(decodeEnvelope(JSON.stringify(buildEnvelope('kanban/notify', { ...base, title: 'x' }))).ok).toBe(false)
    expect(KanbanNotifyOk.parse({ notifyId: base.notifyId, ok: false, reason: 'post_failed' }).ok).toBe(false)
  })
})
