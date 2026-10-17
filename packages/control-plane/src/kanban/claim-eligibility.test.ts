import { describe, expect, it } from 'vitest'
import { explainClaim, type ClaimAgentFacts, type ClaimEligibilityInput, type ClaimGate } from './claim-eligibility.js'

const NOW = new Date('2026-10-15T12:00:00.000Z')
const A1 = 'a1111111-1111-4111-8111-111111111111'

function liveAgent(): ClaimAgentFacts {
  return { exists: true, paused: false, daemonId: 'd1111111-1111-4111-8111-111111111111', daemonLive: true }
}

function input(overrides: Partial<ClaimEligibilityInput> = {}): ClaimEligibilityInput {
  return {
    board: { enabled: true, verifierAgentId: null, maxInProgress: 1, maxInProgressPerAgent: 1 },
    card: {
      status: 'ready',
      assigneeAgentId: A1,
      promotionPending: false,
      cooldownUntil: null,
      notBefore: null,
      hasOpenLease: false
    },
    assignee: liveAgent(),
    verifier: null,
    latestWorkAgentId: null,
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
      { board: { enabled: false, verifierAgentId: null, maxInProgress: 1, maxInProgressPerAgent: 1 } }
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
          hasOpenLease: true
        }
      }
    ],
    ['board_cap', { openRunCount: 1 }],
    ['agent_cap', { openRunCountForAssignee: 1 }]
  ])('returns %s when that gate alone blocks the card', (gate, overrides) => {
    expect(explainClaim(input(overrides))).toEqual({ eligible: false, gate })
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
            hasOpenLease: false
          }
        })
      )
    ).toEqual({ eligible: true, role: 'work', agentId: A1 })
  })
})
