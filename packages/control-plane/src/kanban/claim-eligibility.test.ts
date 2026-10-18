import { describe, expect, it } from 'vitest'
import { explainClaim, type ClaimAgentFacts, type ClaimEligibilityInput, type ClaimGate } from './claim-eligibility.js'

const NOW = new Date('2026-10-15T12:00:00.000Z')
const A1 = 'a1111111-1111-4111-8111-111111111111'

function liveAgent(): ClaimAgentFacts {
  return { exists: true, paused: false, daemonId: 'd1111111-1111-4111-8111-111111111111', daemonLive: true }
}

function input(overrides: Partial<ClaimEligibilityInput> = {}): ClaimEligibilityInput {
  return {
    board: { enabled: true, paused: false, verifierAgentId: null, maxInProgress: 1, maxInProgressPerAgent: 1 },
    card: {
      status: 'ready',
      assigneeAgentId: A1,
      promotionPending: false,
      cooldownUntil: null,
      notBefore: null,
      verifiedAt: null,
      needsAttention: false,
      hasOpenLease: false
    },
    assignee: liveAgent(),
    verifier: null,
    workAgentIds: [],
    openRunCount: 0,
    openRunCountForAssignee: 0,
    openRunCountForVerifier: 0,
    now: NOW,
    ...overrides
  }
}

describe('explainClaim — eligible', () => {
  it('claims a ready card to its assignee as work', () => {
    expect(explainClaim(input())).toEqual({ eligible: true, role: 'work', agentId: A1 })
  })
})

describe('explainClaim — gates', () => {
  it.each<[ClaimGate, Partial<ClaimEligibilityInput>]>([
    [
      'board_disabled',
      { board: { enabled: false, paused: false, verifierAgentId: null, maxInProgress: 1, maxInProgressPerAgent: 1 } }
    ],
    [
      'board_paused',
      { board: { enabled: true, paused: true, verifierAgentId: null, maxInProgress: 1, maxInProgressPerAgent: 1 } }
    ],
    [
      'status_not_claimable',
      {
        card: {
          status: 'todo',
          assigneeAgentId: A1,
          promotionPending: false,
          cooldownUntil: null,
          notBefore: null,
          verifiedAt: null,
          needsAttention: false,
          hasOpenLease: false
        }
      }
    ],
    [
      'promotion_pending',
      {
        card: {
          status: 'ready',
          assigneeAgentId: A1,
          promotionPending: true,
          cooldownUntil: null,
          notBefore: null,
          verifiedAt: null,
          needsAttention: false,
          hasOpenLease: false
        }
      }
    ],
    [
      'cooldown',
      {
        card: {
          status: 'ready',
          assigneeAgentId: A1,
          promotionPending: false,
          cooldownUntil: new Date(NOW.getTime() + 1000),
          notBefore: null,
          verifiedAt: null,
          needsAttention: false,
          hasOpenLease: false
        }
      }
    ],
    [
      'not_before',
      {
        card: {
          status: 'ready',
          assigneeAgentId: A1,
          promotionPending: false,
          cooldownUntil: null,
          notBefore: new Date(NOW.getTime() + 1000),
          verifiedAt: null,
          needsAttention: false,
          hasOpenLease: false
        }
      }
    ],
    [
      'no_assignee',
      {
        card: {
          status: 'ready',
          assigneeAgentId: null,
          promotionPending: false,
          cooldownUntil: null,
          notBefore: null,
          verifiedAt: null,
          needsAttention: false,
          hasOpenLease: false
        }
      }
    ],
    ['agent_missing', { assignee: null }],
    ['agent_paused', { assignee: { ...liveAgent(), paused: true } }],
    ['agent_unplaced', { assignee: { ...liveAgent(), daemonId: null } }],
    ['daemon_offline', { assignee: { ...liveAgent(), daemonLive: false } }],
    [
      'open_lease',
      {
        card: {
          status: 'ready',
          assigneeAgentId: A1,
          promotionPending: false,
          cooldownUntil: null,
          notBefore: null,
          verifiedAt: null,
          needsAttention: false,
          hasOpenLease: true
        }
      }
    ],
    ['board_cap', { openRunCount: 1 }],
    ['agent_cap', { openRunCountForAssignee: 1 }]
  ])('returns %s when that gate alone blocks the card', (gate, overrides) => {
    expect(explainClaim(input(overrides))).toEqual({ eligible: false, gate })
  })

  it('checks disabled before paused and paused before card gates', () => {
    const b = { ...input().board, paused: true }
    expect(explainClaim(input({ board: b }))).toEqual({ eligible: false, gate: 'board_paused' })
    expect(explainClaim(input({ board: { ...b, enabled: false } }))).toEqual({
      eligible: false,
      gate: 'board_disabled'
    })
  })

  it('honours the documented precedence: board cap loses to a status gate', () => {
    const verdict = explainClaim(
      input({
        card: {
          status: 'todo',
          assigneeAgentId: A1,
          promotionPending: false,
          cooldownUntil: null,
          notBefore: null,
          verifiedAt: null,
          needsAttention: false,
          hasOpenLease: false
        },
        openRunCount: 10
      })
    )
    expect(verdict).toEqual({ eligible: false, gate: 'status_not_claimable' })
  })

  it('checks the assignee after the card-level gates', () => {
    const verdict = explainClaim(
      input({
        assignee: { ...liveAgent(), paused: true },
        card: {
          status: 'ready',
          assigneeAgentId: A1,
          promotionPending: true,
          cooldownUntil: null,
          notBefore: null,
          verifiedAt: null,
          needsAttention: false,
          hasOpenLease: false
        }
      })
    )
    expect(verdict).toEqual({ eligible: false, gate: 'promotion_pending' })
  })

  it('treats an elapsed cooldown and notBefore as claimable', () => {
    expect(
      explainClaim(
        input({
          card: {
            status: 'ready',
            assigneeAgentId: A1,
            promotionPending: false,
            cooldownUntil: new Date(NOW.getTime() - 1),
            notBefore: new Date(NOW.getTime() - 1),
            verifiedAt: null,
            needsAttention: false,
            hasOpenLease: false
          }
        })
      )
    ).toEqual({ eligible: true, role: 'work', agentId: A1 })
  })
})

const A2 = 'a2222222-2222-4222-8222-222222222222'

/** A review card on a board whose verifier is A2, with both agents live and nothing open. */
function review(overrides: Partial<ClaimEligibilityInput> = {}, card: Partial<ClaimEligibilityInput['card']> = {}) {
  const base = input()
  return {
    ...base,
    board: { ...base.board, verifierAgentId: A2, maxInProgress: 10 },
    card: { ...base.card, status: 'review' as const, ...card },
    verifier: liveAgent(),
    ...overrides
  }
}

describe('explainClaim — review routing', () => {
  it('checks board pause before review routing, approval and attention gates', () => {
    const facts = review({ board: { ...review().board, paused: true } })
    expect(explainClaim(facts)).toEqual({ eligible: false, gate: 'board_paused' })
    expect(explainClaim({ ...facts, card: { ...facts.card, verifiedAt: NOW, needsAttention: true } })).toEqual({
      eligible: false,
      gate: 'board_paused'
    })
    expect(explainClaim({ ...facts, board: { ...facts.board, verifierAgentId: null } })).toEqual({
      eligible: false,
      gate: 'board_paused'
    })
  })

  it('vera-414: routes a review card to the verifier as a verify claim', () => {
    expect(explainClaim(review())).toEqual({ eligible: true, role: 'verify', agentId: A2 })
  })

  it('vera-414: a ready card still routes to its assignee when the board has a verifier', () => {
    expect(explainClaim(review({}, { status: 'ready' }))).toEqual({ eligible: true, role: 'work', agentId: A1 })
  })

  it.each<[string, ClaimGate, ReturnType<typeof review>]>([
    ['the board has no verifier', 'verifier_unset', review({ board: { ...review().board, verifierAgentId: null } })],
    ['the verifier is the assignee', 'verifier_is_worker', review({}, { assigneeAgentId: A2 })],
    ['the verifier wrote the latest work run', 'verifier_is_worker', review({ workAgentIds: [A2] })],
    ['the verifier wrote an earlier work run', 'verifier_is_worker', review({ workAgentIds: [A2, A1] })],
    ['the verifier row is gone', 'agent_missing', review({ verifier: null })],
    ['the verifier is paused', 'agent_paused', review({ verifier: { ...liveAgent(), paused: true } })],
    ['the verifier is unplaced', 'agent_unplaced', review({ verifier: { ...liveAgent(), daemonId: null } })],
    ['the verifier daemon is offline', 'daemon_offline', review({ verifier: { ...liveAgent(), daemonLive: false } })],
    ['the verifier is at its cap', 'agent_cap', review({ openRunCountForVerifier: 1 })]
  ])('vera-414: blocks a review card when %s', (_why, gate, facts) => {
    expect(explainClaim(facts)).toEqual({ eligible: false, gate })
  })

  it("vera-414: reads the verifier's facts and count, not the assignee's", () => {
    const facts = review({ assignee: { ...liveAgent(), paused: true }, openRunCountForAssignee: 5 })
    expect(explainClaim(facts)).toEqual({ eligible: true, role: 'verify', agentId: A2 })
    expect(explainClaim({ ...facts, card: { ...facts.card, status: 'ready' } })).toEqual({
      eligible: false,
      gate: 'agent_paused'
    })
  })

  it('vera-414: orders gates as the SQL claim does (row filters, then board room, agent share, liveness, B8)', () => {
    // An open lease is a WHERE filter, so it wins over an agent gate the claim loop would only reach later.
    expect(
      explainClaim(
        input({ assignee: { ...liveAgent(), daemonLive: false }, card: { ...input().card, hasOpenLease: true } })
      )
    ).toEqual({
      eligible: false,
      gate: 'open_lease'
    })
    // The loop checks the agent's share before daemon liveness, and liveness before B8.
    expect(
      explainClaim(input({ assignee: { ...liveAgent(), daemonLive: false }, openRunCountForAssignee: 1 }))
    ).toEqual({
      eligible: false,
      gate: 'agent_cap'
    })
    expect(explainClaim(review({ verifier: { ...liveAgent(), daemonLive: false } }, { assigneeAgentId: A2 }))).toEqual({
      eligible: false,
      gate: 'daemon_offline'
    })
    expect(explainClaim(review({ openRunCount: 10 }, { assigneeAgentId: A2 }))).toEqual({
      eligible: false,
      gate: 'board_cap'
    })
  })
})

describe('explainClaim — approved review cards', () => {
  it('vera-414: an approved review card (verifiedAt set) is not re-verified', () => {
    expect(explainClaim(review({}, { verifiedAt: NOW }))).toEqual({ eligible: false, gate: 'verified' })
  })

  it('vera-414: a review card without an approval stamp is still verifiable', () => {
    expect(explainClaim(review({}, { verifiedAt: null }))).toEqual({ eligible: true, role: 'verify', agentId: A2 })
  })

  it('vera-414: the verified gate follows verifier_unset and precedes the timing gates', () => {
    const noVerifier = review({ board: { ...review().board, verifierAgentId: null } }, { verifiedAt: NOW })
    expect(explainClaim(noVerifier)).toEqual({ eligible: false, gate: 'verifier_unset' })
    const cooling = review({}, { verifiedAt: NOW, cooldownUntil: new Date(NOW.getTime() + 1000) })
    expect(explainClaim(cooling)).toEqual({ eligible: false, gate: 'verified' })
  })
})

describe('explainClaim — B8 covers every work attempt', () => {
  it('vera-414: refuses a verifier that wrote any earlier attempt, not only the latest', () => {
    // Attempt 1 by the verifier (A2), attempt 2 by A1: the reviewed branch still holds the verifier's work.
    expect(explainClaim(review({ workAgentIds: [A2, A1] }))).toEqual({ eligible: false, gate: 'verifier_is_worker' })
  })

  it("vera-414: other agents' attempts do not block the verifier", () => {
    expect(explainClaim(review({ workAgentIds: [A1, A1] }))).toEqual({ eligible: true, role: 'verify', agentId: A2 })
  })
})

describe('explainClaim — cards held for a human', () => {
  it.each(['ready', 'review'] as const)('vera-414: a flagged %s card is not claimable (needs_attention)', (status) => {
    expect(explainClaim(review({}, { status, needsAttention: true }))).toEqual({
      eligible: false,
      gate: 'needs_attention'
    })
  })

  it('vera-414: fixing the verifier alone does not lift a B8 park', () => {
    // The flag outlives the board edit: the verifier is now A2 (not the worker), yet the card stays held.
    expect(explainClaim(review({}, { needsAttention: true }))).toEqual({ eligible: false, gate: 'needs_attention' })
    expect(explainClaim(review({}, { needsAttention: false }))).toEqual({ eligible: true, role: 'verify', agentId: A2 })
  })
})
