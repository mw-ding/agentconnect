// Claim dry-run helpers (issue #2 Lane 4b): facts mapping, one hint per gate, and the claim loop's ordering/caps replay.
import { describe, expect, it } from 'vitest'
import type { ClaimEligibilityInput, ClaimGate, ClaimVerdict } from './claim-eligibility.js'
import {
  capDeferralHint,
  claimFactsOf,
  compareClaimOrder,
  gateHint,
  simulateClaim,
  type ClaimCandidate
} from './claim-explain.js'

const NOW = new Date('2026-10-15T12:00:00.000Z')

function input(overrides: Partial<ClaimEligibilityInput> = {}): ClaimEligibilityInput {
  return {
    board: { enabled: true, paused: false, verifierAgentId: null, maxInProgress: 3, maxInProgressPerAgent: 2 },
    card: {
      status: 'ready',
      assigneeAgentId: 'a1',
      promotionPending: false,
      controlWritePending: false,
      labelWritePending: false,
      cooldownUntil: null,
      notBefore: null,
      verifiedAt: null,
      needsAttention: false,
      hasOpenLease: false
    },
    assignee: { exists: true, paused: false, daemonId: 'd1', daemonLive: true },
    verifier: null,
    workAgentIds: [],
    openRunCount: 0,
    openRunCountForAssignee: 0,
    openRunCountForVerifier: 0,
    now: NOW,
    ...overrides
  }
}

const GATES: ClaimGate[] = [
  'board_disabled',
  'board_paused',
  'status_not_claimable',
  'promotion_pending',
  'cooldown',
  'not_before',
  'no_assignee',
  'agent_missing',
  'agent_paused',
  'agent_unplaced',
  'daemon_offline',
  'open_lease',
  'board_cap',
  'agent_cap',
  'verifier_unset',
  'verifier_is_worker',
  'verified',
  'needs_attention',
  'epic_cap',
  'daemon_cap'
]

describe('claimFactsOf', () => {
  it('uses verifier facts for review even when the assignee is paused and offline', () => {
    const facts = claimFactsOf(
      input({
        board: { ...input().board, verifierAgentId: 'v1' },
        card: { ...input().card, status: 'review', verifiedAt: NOW, needsAttention: true },
        assignee: { exists: true, paused: true, daemonId: null, daemonLive: false },
        verifier: { exists: true, paused: false, daemonId: 'd2', daemonLive: true },
        workAgentIds: ['earlier-worker', 'a1'],
        openRunCountForVerifier: 1,
        epicCapacity: { openRunCount: 2, maxActive: 3 },
        daemonCapacity: { openRunCount: 4, maxActive: 5 }
      })
    )
    expect(facts).toMatchObject({
      role: 'verify',
      targetAgentId: 'v1',
      targetExists: true,
      targetPaused: false,
      targetPlaced: true,
      targetDaemonLive: true,
      assigneePaused: true,
      verifierAgentId: 'v1',
      verifiedAt: NOW.toISOString(),
      needsAttention: true,
      workAgentIds: ['earlier-worker', 'a1'],
      openRunCountForVerifier: 1,
      epicCapacity: { openRunCount: 2, maxActive: 3 },
      daemonCapacity: { openRunCount: 4, maxActive: 5 }
    })
  })
  it('maps the input to booleans, counts and ISO timestamps only', () => {
    const cooldown = new Date('2026-10-15T13:00:00.000Z')
    const facts = claimFactsOf(
      input({
        card: { ...input().card, cooldownUntil: cooldown, hasOpenLease: true },
        openRunCount: 2,
        openRunCountForAssignee: 1
      })
    )
    expect(facts).toMatchObject({
      boardEnabled: true,
      boardPaused: false,
      status: 'ready',
      assigneeAgentId: 'a1',
      promotionPending: false,
      cooldownUntil: cooldown.toISOString(),
      notBefore: null,
      hasOpenLease: true,
      assigneeExists: true,
      assigneePaused: false,
      assigneePlaced: true,
      assigneeDaemonLive: true,
      openRunCount: 2,
      openRunCountForAssignee: 1,
      maxInProgress: 3,
      maxInProgressPerAgent: 2
    })
  })

  it('reads a missing assignee as absent, unplaced and offline', () => {
    const facts = claimFactsOf(input({ assignee: null }))
    expect(facts).toMatchObject({ assigneeExists: false, assigneePaused: false, assigneePlaced: false })
    expect(facts.assigneeDaemonLive).toBe(false)
  })

  it('reads an unplaced assignee', () => {
    const facts = claimFactsOf(input({ assignee: { exists: true, paused: true, daemonId: null, daemonLive: false } }))
    expect(facts).toMatchObject({ assigneeExists: true, assigneePaused: true, assigneePlaced: false })
  })
})

describe('gateHint', () => {
  it.each(GATES)('gives %s a non-empty sentence', (gate) => {
    const hint = gateHint(gate, claimFactsOf(input()))
    expect(hint.length).toBeGreaterThan(10)
  })

  it('names the cooldown and not-before instants', () => {
    const at = '2026-10-15T13:00:00.000Z'
    const facts = claimFactsOf(
      input({ card: { ...input().card, cooldownUntil: new Date(at), notBefore: new Date(at) } })
    )
    expect(gateHint('cooldown', facts)).toBe(`cooling down until ${at} after a failed run`)
    expect(gateHint('not_before', facts)).toContain(at)
  })

  it('names the board and agent limits and the card status', () => {
    const facts = claimFactsOf(input({ card: { ...input().card, status: 'todo' } }))
    expect(gateHint('board_cap', facts)).toContain('3 in-progress')
    expect(gateHint('agent_cap', facts)).toContain('2 in-progress')
    expect(gateHint('status_not_claimable', facts)).toContain('todo')
  })

  it('words a cap deferral as eligible now, blocked after the cards ahead', () => {
    const hint = capDeferralHint('agent_cap', claimFactsOf(input()))
    expect(hint).toMatch(/^eligible now, but .* once the cards ahead of it are dispatched$/)
  })
})

const ok = (agentId: string): ClaimVerdict => ({ eligible: true, role: 'work', agentId })
const blocked = (gate: ClaimGate): ClaimVerdict => ({ eligible: false, gate })
const at = (minute: number) => new Date(NOW.getTime() + minute * 60_000)
const cand = (id: string, priority: number, minute: number, verdict: ClaimVerdict): ClaimCandidate => ({
  id,
  priority,
  createdAt: at(minute),
  verdict
})
const caps = (over: Partial<Parameters<typeof simulateClaim>[1]> = {}) => ({
  maxInProgress: 10,
  maxInProgressPerAgent: 10,
  openTotal: 0,
  openPerAgent: new Map<string, number>(),
  ...over
})

describe('compareClaimOrder', () => {
  it('orders by priority DESC, then createdAt ASC, then id ASC', () => {
    const cards = [
      cand('b', 0, 1, ok('a')),
      cand('a', 0, 1, ok('a')),
      cand('c', 5, 9, ok('a')),
      cand('d', 0, 0, ok('a'))
    ]
    expect(cards.sort(compareClaimOrder).map((c) => c.id)).toEqual(['c', 'd', 'a', 'b'])
  })
})

describe('simulateClaim', () => {
  it('takes eligible cards in claim order and ignores ineligible ones', () => {
    const sim = simulateClaim(
      [
        cand('low', 0, 0, ok('a1')),
        cand('skip', 9, 0, blocked('cooldown')),
        cand('high', 3, 5, ok('a2')),
        cand('mid', 3, 6, ok('a3'))
      ],
      caps()
    )
    expect(sim.order).toEqual(['high', 'mid', 'low'])
    expect(sim.capBound.size).toBe(0)
  })

  it('stops at the board room and marks the rest board_cap', () => {
    const sim = simulateClaim(
      [cand('1', 3, 0, ok('a1')), cand('2', 2, 0, ok('a2')), cand('3', 1, 0, ok('a3'))],
      caps({ maxInProgress: 2, openTotal: 1 })
    )
    expect(sim.order).toEqual(['1'])
    expect([...sim.capBound]).toEqual([
      ['2', 'board_cap'],
      ['3', 'board_cap']
    ])
  })

  it('applies the per-agent cap cumulatively and lets other agents through', () => {
    const sim = simulateClaim(
      [cand('1', 3, 0, ok('a1')), cand('2', 2, 0, ok('a1')), cand('3', 1, 0, ok('a2')), cand('4', 0, 0, ok('a1'))],
      caps({ maxInProgressPerAgent: 2 })
    )
    expect(sim.order).toEqual(['1', '2', '3'])
    expect(sim.capBound.get('4')).toBe('agent_cap')
  })

  it('counts the agent’s already-open runs against its cap', () => {
    const sim = simulateClaim(
      [cand('1', 1, 0, ok('a1')), cand('2', 0, 0, ok('a2'))],
      caps({ maxInProgressPerAgent: 1, openTotal: 1, openPerAgent: new Map([['a1', 1]]) })
    )
    expect(sim.order).toEqual(['2'])
    expect(sim.capBound.get('1')).toBe('agent_cap')
  })

  it('honours the dispatcher’s limit like the board room', () => {
    const sim = simulateClaim([cand('1', 2, 0, ok('a1')), cand('2', 1, 0, ok('a2'))], caps({ limit: 1 }))
    expect(sim.order).toEqual(['1'])
    expect(sim.capBound.get('2')).toBe('board_cap')
  })

  it('takes nothing when nothing is eligible', () => {
    const sim = simulateClaim([cand('1', 1, 0, blocked('no_assignee'))], caps())
    expect(sim).toEqual({ order: [], capBound: new Map() })
  })
})
