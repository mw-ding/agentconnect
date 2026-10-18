import { describe, expect, it } from 'vitest'
import { canTransition } from './card-state.js'
import {
  FAILURE_COOLDOWN_MAX_MS,
  KANBAN_REVIEW_ROUND_LIMIT,
  PROVIDER_TRANSIENT_LIMIT,
  TRANSIENT_COOLDOWN_MS,
  failureCooldownMs,
  planRunEnd,
  staleLeaseReason,
  type AccountingBoard,
  type AccountingCard,
  type KanbanRunEnd,
  type OpenLeaseFacts
} from './run-accounting.js'

const NOW = new Date('2026-10-15T12:00:00.000Z')
const board: AccountingBoard = {
  failureLimit: 2,
  protocolRetryLimit: 3,
  blockRecurrenceLimit: 2,
  completionContract: 'close',
  verifierAgentId: null
}
const running: AccountingCard = {
  status: 'running',
  consecutiveFailures: 0,
  protocolViolations: 0,
  blockRecurrence: 0,
  cooldownUntil: null,
  blockKind: null,
  reviewRounds: 0,
  verifiedAt: null
}
const review: AccountingCard = { ...running, status: 'review' }

const END_CASES: KanbanRunEnd[] = [
  { outcome: 'completed' },
  { outcome: 'review_requested' },
  { outcome: 'failed' },
  { outcome: 'protocol_violation' },
  { outcome: 'transient' },
  { outcome: 'transient', provider: true },
  { outcome: 'reclaimed' },
  { outcome: 'blocked', blockKind: 'needs_input' },
  { outcome: 'blocked', blockKind: 'capability' },
  { outcome: 'changes_requested' }
]

describe('planRunEnd — failure, cooldown, and recurrence accounting', () => {
  it('only ever plans a move the M1 transition table allows', () => {
    for (const end of END_CASES) {
      for (const card of [running, { ...running, consecutiveFailures: 1, protocolViolations: 2, blockRecurrence: 1 }]) {
        const plan = planRunEnd(card, board, end, NOW)
        expect(canTransition('running', plan.status), `${end.outcome} → ${plan.status}`).toBe(true)
      }
    }
  })

  it('a stale reclaim returns the card to ready with no failure and no cooldown', () => {
    const plan = planRunEnd({ ...running, consecutiveFailures: 1 }, board, { outcome: 'reclaimed' }, NOW)
    expect(plan).toMatchObject({ status: 'ready', consecutiveFailures: 1, cooldownUntil: null, countsAsFailure: false })
  })

  it('counts consecutive failures with a doubling cooldown and routes to triage at failureLimit', () => {
    const first = planRunEnd(running, board, { outcome: 'failed' }, NOW)
    expect(first).toMatchObject({ status: 'ready', consecutiveFailures: 1, countsAsFailure: true })
    expect(first.cooldownUntil?.getTime()).toBe(NOW.getTime() + failureCooldownMs(1))
    const second = planRunEnd({ ...first, status: 'running' }, board, { outcome: 'failed' }, NOW)
    expect(second).toMatchObject({ status: 'triage', consecutiveFailures: 2, tripped: 'failure_limit' })
    expect(second.cooldownUntil).toBeNull()
  })

  it('caps the failure cooldown', () => {
    expect(failureCooldownMs(2)).toBe(2 * failureCooldownMs(1))
    expect(failureCooldownMs(50)).toBe(FAILURE_COOLDOWN_MAX_MS)
  })

  it('protocol violations spend their own budget, never the failure counter', () => {
    let card: AccountingCard = running
    for (let i = 1; i < board.protocolRetryLimit; i++) {
      const plan = planRunEnd(card, board, { outcome: 'protocol_violation' }, NOW)
      expect(plan).toMatchObject({ status: 'ready', protocolViolations: i, consecutiveFailures: 0 })
      expect(plan.cooldownUntil).not.toBeNull()
      card = { ...plan, status: 'running' }
    }
    const tripped = planRunEnd(card, board, { outcome: 'protocol_violation' }, NOW)
    expect(tripped).toMatchObject({ status: 'triage', tripped: 'protocol_retry_limit', protocolViolations: 3 })
  })

  it('a transient provider error cools down without counting', () => {
    const plan = planRunEnd(running, board, { outcome: 'transient' }, NOW)
    expect(plan).toMatchObject({ status: 'ready', consecutiveFailures: 0, countsAsFailure: false })
    expect(plan.cooldownUntil?.getTime()).toBe(NOW.getTime() + TRANSIENT_COOLDOWN_MS)
  })

  it('blocks count recurrence and route to triage at blockRecurrenceLimit; capability goes straight to triage', () => {
    const first = planRunEnd(running, board, { outcome: 'blocked', blockKind: 'needs_input' }, NOW)
    expect(first).toMatchObject({ status: 'blocked', blockKind: 'needs_input', blockRecurrence: 1 })
    const second = planRunEnd(
      { ...first, status: 'running' },
      board,
      { outcome: 'blocked', blockKind: 'dependency' },
      NOW
    )
    expect(second).toMatchObject({ status: 'triage', blockRecurrence: 2, tripped: 'block_recurrence_limit' })
    const capability = planRunEnd(running, board, { outcome: 'blocked', blockKind: 'capability' }, NOW)
    expect(capability).toMatchObject({ status: 'triage', tripped: 'capability', blockKind: 'capability' })
  })

  it('completion resets counters and goes to done, or review when a verifier or PR contract gates it', () => {
    const tired = { ...running, consecutiveFailures: 1, protocolViolations: 2, blockRecurrence: 1 }
    expect(planRunEnd(tired, board, { outcome: 'completed' }, NOW)).toMatchObject({
      status: 'done',
      consecutiveFailures: 0,
      protocolViolations: 0,
      blockRecurrence: 0
    })
    expect(planRunEnd(running, { ...board, verifierAgentId: 'v' }, { outcome: 'completed' }, NOW).status).toBe('review')
    expect(
      planRunEnd(running, { ...board, completionContract: 'pr_merged' }, { outcome: 'completed' }, NOW).status
    ).toBe('review')
    expect(planRunEnd(tired, board, { outcome: 'review_requested' }, NOW)).toMatchObject({
      status: 'review',
      consecutiveFailures: 0
    })
  })

  it('leaves a card a human already moved untouched', () => {
    const blocked = { ...running, status: 'blocked' as const, consecutiveFailures: 1 }
    for (const end of END_CASES)
      expect(planRunEnd(blocked, board, end, NOW)).toEqual({ ...blocked, countsAsFailure: false })
  })
})

describe('staleLeaseReason — the reaper predicate', () => {
  const opts = { unackedGraceMs: 2 * 60_000, epochGraceMs: 2 * 60_000 }
  const ago = (ms: number) => new Date(NOW.getTime() - ms)
  const healthy: OpenLeaseFacts = {
    dispatchedAt: ago(60 * 60_000),
    ackedAt: ago(60 * 60_000),
    heartbeatAt: ago(30_000),
    daemonId: 'd1',
    daemonEpoch: 4n,
    currentDaemonEpoch: 4n,
    agentDaemonId: 'd1',
    staleLeaseSec: 14_400
  }

  it('treats a heartbeat as liveness even when an earlier ACK was lost', () => {
    expect(staleLeaseReason({ ...healthy, ackedAt: null }, NOW, opts)).toBeNull()
    expect(staleLeaseReason({ ...healthy, ackedAt: null, heartbeatAt: ago(14_401_000) }, NOW, opts)).toBe(
      'stale_heartbeat'
    )
  })

  it('keeps a beating lease', () => {
    expect(staleLeaseReason(healthy, NOW, opts)).toBeNull()
  })

  it('reclaims a lease whose heartbeat is older than the board TTL', () => {
    expect(staleLeaseReason({ ...healthy, heartbeatAt: ago(14_401_000) }, NOW, opts)).toBe('stale_heartbeat')
    expect(staleLeaseReason({ ...healthy, heartbeatAt: ago(14_399_000) }, NOW, opts)).toBeNull()
  })

  it('reclaims when the daemon or agent row is gone, or the agent moved', () => {
    expect(staleLeaseReason({ ...healthy, currentDaemonEpoch: null }, NOW, opts)).toBe('daemon_missing')
    expect(staleLeaseReason({ ...healthy, agentDaemonId: undefined }, NOW, opts)).toBe('daemon_missing')
    expect(staleLeaseReason({ ...healthy, agentDaemonId: 'd2' }, NOW, opts)).toBe('agent_moved')
    expect(staleLeaseReason({ ...healthy, agentDaemonId: null }, NOW, opts)).toBe('agent_moved')
  })

  it('reclaims after an epoch change only once the daemon fails to re-assert within the grace', () => {
    expect(staleLeaseReason({ ...healthy, currentDaemonEpoch: 5n }, NOW, opts)).toBeNull()
    expect(staleLeaseReason({ ...healthy, currentDaemonEpoch: 5n, heartbeatAt: ago(3 * 60_000) }, NOW, opts)).toBe(
      'epoch_changed'
    )
  })

  it('bounds an unacked dispatch far below the TTL', () => {
    const inFlight = { ...healthy, dispatchedAt: ago(60_000), ackedAt: null, heartbeatAt: null }
    expect(staleLeaseReason(inFlight, NOW, opts)).toBeNull()
    expect(staleLeaseReason({ ...inFlight, dispatchedAt: ago(3 * 60_000) }, NOW, opts)).toBe('dispatch_unacked')
  })
})

describe('planRunEnd — provider outage backoff', () => {
  const outage: KanbanRunEnd = { outcome: 'transient', provider: true }
  const cooldown = (trailing: number) =>
    planRunEnd(running, board, outage, NOW, {
      trailingProviderTransients: trailing,
      role: 'work'
    }).cooldownUntil!.getTime() - NOW.getTime()

  it('doubles from one minute and caps at an hour without counting a failure', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(cooldown)).toEqual([
      60_000,
      120_000,
      240_000,
      480_000,
      960_000,
      1_920_000,
      FAILURE_COOLDOWN_MAX_MS
    ])
    expect(planRunEnd(running, board, outage, NOW, { trailingProviderTransients: 3, role: 'work' })).toMatchObject({
      status: 'ready',
      countsAsFailure: false,
      consecutiveFailures: 0
    })
  })

  it('routes to triage once the bound is reached', () => {
    const plan = planRunEnd(running, board, outage, NOW, {
      trailingProviderTransients: PROVIDER_TRANSIENT_LIMIT - 1,
      role: 'work'
    })
    expect(plan).toMatchObject({
      status: 'triage',
      tripped: 'transient_limit',
      cooldownUntil: null,
      countsAsFailure: false
    })
    expect(canTransition('running', plan.status)).toBe(true)
  })

  it('keeps the flat cooldown for an unclassified transient however many came before', () => {
    const plan = planRunEnd(running, board, { outcome: 'transient' }, NOW, {
      trailingProviderTransients: 9,
      role: 'work'
    })
    expect(plan).toMatchObject({ status: 'ready' })
    expect(plan.cooldownUntil!.getTime() - NOW.getTime()).toBe(TRANSIENT_COOLDOWN_MS)
  })
})

describe('planRunEnd — verify role and review cards', () => {
  const verify = { trailingProviderTransients: 0, role: 'verify' as const }

  it('a verifier approving on the close contract finishes the card', () => {
    expect(
      planRunEnd({ ...review, reviewRounds: 2, verifiedAt: NOW }, board, { outcome: 'completed' }, NOW, verify)
    ).toMatchObject({
      status: 'done',
      reviewRounds: 0,
      verifiedAt: null,
      countsAsFailure: false
    })
  })

  it('a verifier approving under a PR contract stays in review and stamps verifiedAt', () => {
    const gated = { ...board, completionContract: 'pr_merged' as const }
    const plan = planRunEnd(review, gated, { outcome: 'completed' }, NOW, verify)
    expect(plan).toMatchObject({ status: 'review', verifiedAt: NOW, reviewRounds: 0 })
  })

  it('changes_requested returns the card to ready for the assignee, counting a round and no failure', () => {
    const plan = planRunEnd({ ...review, reviewRounds: 1 }, board, { outcome: 'changes_requested' }, NOW, verify)
    expect(plan).toMatchObject({ status: 'ready', reviewRounds: 2, countsAsFailure: false, consecutiveFailures: 0 })
    expect(plan.cooldownUntil).toBeNull()
  })

  it('the review round limit routes to triage instead of looping forever', () => {
    const plan = planRunEnd(
      { ...review, reviewRounds: KANBAN_REVIEW_ROUND_LIMIT - 1 },
      board,
      { outcome: 'changes_requested' },
      NOW,
      verify
    )
    expect(plan).toMatchObject({
      status: 'triage',
      reviewRounds: KANBAN_REVIEW_ROUND_LIMIT,
      tripped: 'review_round_limit'
    })
  })

  it('a verifier failure/protocol/transient/reclaim stays in review with the same counters as a work run', () => {
    expect(planRunEnd(review, board, { outcome: 'failed' }, NOW, verify)).toMatchObject({
      status: 'review',
      consecutiveFailures: 1,
      countsAsFailure: true
    })
    expect(planRunEnd(review, board, { outcome: 'protocol_violation' }, NOW, verify)).toMatchObject({
      status: 'review',
      protocolViolations: 1
    })
    expect(planRunEnd(review, board, { outcome: 'transient' }, NOW, verify)).toMatchObject({ status: 'review' })
    expect(planRunEnd(review, board, { outcome: 'reclaimed' }, NOW, verify)).toMatchObject({
      status: 'review',
      cooldownUntil: null,
      countsAsFailure: false
    })
  })

  it('a verifier block routes to blocked like a work run', () => {
    expect(planRunEnd(review, board, { outcome: 'blocked', blockKind: 'needs_input' }, NOW, verify)).toMatchObject({
      status: 'blocked',
      blockKind: 'needs_input',
      blockRecurrence: 1
    })
  })

  it('only a review card moves for a verify run, and only a running card for a work run', () => {
    expect(planRunEnd(running, board, { outcome: 'changes_requested' }, NOW, verify)).toEqual({
      ...running,
      countsAsFailure: false
    })
    expect(planRunEnd(review, board, { outcome: 'completed' }, NOW)).toEqual({ ...review, countsAsFailure: false })
  })
})

describe('planRunEnd — the review loop stays bounded', () => {
  const verify = { trailingProviderTransients: 0, role: 'verify' as const }
  const gated = { ...board, verifierAgentId: 'a2222222-2222-4222-8222-222222222222' }

  it('vera-414: a worker completing keeps the review round count, so a changes loop still trips the limit', () => {
    const plan = planRunEnd({ ...running, reviewRounds: 2, verifiedAt: NOW }, gated, { outcome: 'completed' }, NOW)
    expect(plan).toMatchObject({ status: 'review', reviewRounds: 2, verifiedAt: null })
    const next = planRunEnd(plan, gated, { outcome: 'changes_requested' }, NOW, verify)
    expect(next).toMatchObject({ status: 'triage', tripped: 'review_round_limit' })
  })

  it('vera-414: every path back to review clears the approval stamp', () => {
    const stamped = { ...running, verifiedAt: NOW }
    for (const outcome of ['completed', 'review_requested'] as const)
      expect(planRunEnd(stamped, gated, { outcome }, NOW)).toMatchObject({ status: 'review', verifiedAt: null })
    expect(
      planRunEnd({ ...review, verifiedAt: NOW }, gated, { outcome: 'changes_requested' }, NOW, verify)
    ).toMatchObject({ status: 'ready', verifiedAt: null })
  })

  it('vera-414: an approval under a PR contract ends the rounds as the close contract does', () => {
    const prBoard = { ...gated, completionContract: 'pr_merged' as const }
    const plan = planRunEnd({ ...review, reviewRounds: 2 }, prBoard, { outcome: 'completed' }, NOW, verify)
    expect(plan).toMatchObject({ status: 'review', verifiedAt: NOW, reviewRounds: 0 })
  })
})
