// PR completion contracts: contract × PR state × verifier × checks × stale sha truth table, and the checks verdict.
import { describe, expect, it } from 'vitest'
import { KANBAN_STATUSES } from './card-state.js'
import {
  checksVerdict,
  contractAttentionComment,
  FLAGGED_WAITS,
  planContract,
  prClosedUnmergedComment,
  type ChecksVerdict,
  type ContractDecision,
  type ContractInput,
  type LivePullRequest
} from './contracts.js'

const HEAD = 'a'.repeat(40)
const OPEN: LivePullRequest = {
  number: 12,
  state: 'open',
  merged: false,
  headSha: HEAD,
  authorLogin: 'agentconnect[bot]',
  authorType: 'Bot',
  headRef: 'ac/card-7',
  headRepoId: 42n,
  baseRef: 'main',
  defaultBranch: 'main',
  createdAt: new Date('2026-10-16T00:00:00Z'),
  mergedByLogin: null
}
const MERGED: LivePullRequest = { ...OPEN, state: 'closed', merged: true, mergedByLogin: 'octocat' }
const CLOSED: LivePullRequest = { ...OPEN, state: 'closed', merged: false }

const input = (over: Partial<ContractInput> = {}): ContractInput => ({
  status: 'review',
  binding: {
    appSlug: 'agentconnect',
    repoId: 42n,
    issueNumber: 7,
    workEpisodeStartedAt: new Date('2026-10-15T00:00:00Z')
  },
  contract: 'pr_merged',
  verifierAgentId: null,
  verifiedAt: null,
  linkedPrNumber: 12,
  pr: OPEN,
  ...over
})
const DONE: ContractDecision = { kind: 'done' }
const TRIAGE: ContractDecision = { kind: 'triage', reason: 'pr_closed_unmerged' }
const wait = (reason: string): ContractDecision => ({ kind: 'wait', reason }) as ContractDecision

describe('checksVerdict', () => {
  it.each(['skipped', 'neutral'])('vera-415: %s-only checks cannot make a green contract', (conclusion) => {
    const verdict = checksVerdict([{ status: 'completed', conclusion }])
    expect(verdict).toBe('pending')
  })

  it.each<[string, Array<[string, string | null]>, ChecksVerdict]>([
    ['no runs', [], 'none'],
    ['all success', [['completed', 'success']], 'green'],
    [
      'neutral and skipped pass',
      [
        ['completed', 'neutral'],
        ['completed', 'skipped'],
        ['completed', 'success']
      ],
      'green'
    ],
    [
      'one queued',
      [
        ['completed', 'success'],
        ['queued', null]
      ],
      'pending'
    ],
    ['one in progress', [['in_progress', null]], 'pending'],
    [
      'one failure',
      [
        ['completed', 'success'],
        ['completed', 'failure']
      ],
      'failed'
    ],
    [
      'failure beats pending',
      [
        ['in_progress', null],
        ['completed', 'failure']
      ],
      'failed'
    ],
    ['cancelled fails', [['completed', 'cancelled']], 'failed'],
    ['timed out fails', [['completed', 'timed_out']], 'failed'],
    ['action_required fails', [['completed', 'action_required']], 'failed'],
    ['stale fails', [['completed', 'stale']], 'failed'],
    ['completed without conclusion fails', [['completed', null]], 'failed']
  ])('%s → %s', (_name, runs, expected) => {
    expect(checksVerdict(runs.map(([status, conclusion]) => ({ status, conclusion })))).toBe(expected)
  })
})

describe('planContract', () => {
  it.each([
    ['author login', { authorLogin: 'unrelated[bot]' }],
    ['author type', { authorType: 'User' }],
    ['head branch', { headRef: 'unrelated' }],
    ['fork', { headRepoId: 99n }],
    ['base branch', { baseRef: 'release' }],
    ['missing default branch', { defaultBranch: null }],
    ['invalid creation time', { createdAt: new Date(NaN) }],
    ['old PR', { createdAt: new Date('2026-10-14T00:00:00Z') }],
    ['missing author', { authorLogin: null }],
    ['missing creation', { createdAt: null }]
  ])('vera-415: an unbound %s PR never completes or triages a card', (_name, broken) => {
    for (const contract of ['pr_merged', 'pr_checks_green'] as const)
      for (const pr of [MERGED, CLOSED]) {
        const live = {
          ...pr,
          authorLogin: 'agentconnect[bot]',
          authorType: 'Bot',
          headRef: 'ac/card-7',
          headRepoId: 42n,
          baseRef: 'main',
          defaultBranch: 'main',
          createdAt: new Date('2026-10-16T00:00:00Z'),
          ...broken
        }
        expect(
          planContract(
            input({
              pr: live,
              contract,
              checks: { headSha: HEAD, verdict: 'green' },
              binding: {
                appSlug: 'agentconnect',
                repoId: 42n,
                issueNumber: 7,
                workEpisodeStartedAt: new Date('2026-10-15T00:00:00Z')
              }
            })
          )
        ).toEqual(wait('pr_unbound'))
      }
  })

  it('vera-415: missing App identity or work provenance cannot bind a PR', () => {
    for (const binding of [
      undefined,
      { appSlug: undefined, repoId: 42n, issueNumber: 7, workEpisodeStartedAt: new Date(0) },
      { appSlug: 'agentconnect', repoId: 42n, issueNumber: 7, workEpisodeStartedAt: null }
    ])
      expect(planContract(input({ pr: MERGED, binding }))).toEqual(wait('pr_unbound'))
  })

  it('only a review card under a PR contract with a linked PR is ever judged', () => {
    for (const status of KANBAN_STATUSES.filter((s) => s !== 'review')) {
      expect(planContract(input({ status, pr: MERGED }))).toEqual(wait('not_review'))
    }
    expect(planContract(input({ contract: 'close', pr: MERGED }))).toEqual(wait('no_pr_contract'))
    expect(planContract(input({ linkedPrNumber: null, pr: MERGED }))).toEqual(wait('no_linked_pr'))
    expect(planContract(input({ pr: null }))).toEqual(wait('pr_missing'))
    expect(planContract(input({ pr: { ...MERGED, number: 13 } }))).toEqual(wait('pr_missing'))
  })

  // contract × PR state × verifier configured × verifiedAt
  const verifierCases = [
    { verifierAgentId: null, verifiedAt: null, ok: true },
    { verifierAgentId: 'v1', verifiedAt: null, ok: false },
    { verifierAgentId: 'v1', verifiedAt: new Date(0), ok: true }
  ]
  for (const v of verifierCases) {
    const tag = v.verifierAgentId === null ? 'no verifier' : v.verifiedAt ? 'verified' : 'unverified'
    it(`pr_merged (${tag}): merged → ${v.ok ? 'done' : 'wait'}, open → wait, closed unmerged → triage`, () => {
      const base = { contract: 'pr_merged' as const, verifierAgentId: v.verifierAgentId, verifiedAt: v.verifiedAt }
      expect(planContract(input({ ...base, pr: MERGED }))).toEqual(v.ok ? DONE : wait('awaiting_verifier'))
      expect(planContract(input({ ...base, pr: OPEN }))).toEqual(wait('pr_open'))
      expect(planContract(input({ ...base, pr: CLOSED }))).toEqual(TRIAGE)
    })

    it(`pr_checks_green (${tag}): checks verdict × open/merged × stale sha`, () => {
      const base = {
        contract: 'pr_checks_green' as const,
        verifierAgentId: v.verifierAgentId,
        verifiedAt: v.verifiedAt
      }
      for (const pr of [OPEN, MERGED]) {
        const at = (verdict: ChecksVerdict, headSha = HEAD) =>
          planContract(input({ ...base, pr, checks: { headSha, verdict } }))
        expect(at('green')).toEqual(v.ok ? DONE : wait('awaiting_verifier'))
        expect(at('pending')).toEqual(wait('checks_pending'))
        expect(at('failed')).toEqual(wait('checks_failed'))
        expect(at('none')).toEqual(wait('no_checks'))
        // A verdict read for an older head never completes the card, even when green.
        expect(at('green', 'b'.repeat(40))).toEqual(wait('stale_sha'))
        expect(planContract(input({ ...base, pr }))).toEqual(wait('checks_unread'))
      }
      // An unmerged close triages whatever the checks say.
      expect(planContract(input({ ...base, pr: CLOSED, checks: { headSha: HEAD, verdict: 'green' } }))).toEqual(TRIAGE)
    })
  }

  it('vera-415b3: a PR created inside the episode binds however late the reporting run started', () => {
    // Rework: the PR came from attempt 1, and the episode began at attempt 1's claim.
    const binding = {
      appSlug: 'agentconnect',
      repoId: 42n,
      issueNumber: 7,
      workEpisodeStartedAt: new Date('2026-10-15T23:59:30Z')
    }
    expect(planContract(input({ pr: MERGED, binding }))).toEqual(DONE)
    const later = { ...binding, workEpisodeStartedAt: new Date('2026-10-16T00:00:01Z') }
    expect(planContract(input({ pr: MERGED, binding: later }))).toEqual(wait('pr_unbound'))
  })

  it('vera-415 merged_by: an App-bot merge with no verifier waits; a verifier or a human merge completes', () => {
    const byApp = { ...MERGED, mergedByLogin: 'AgentConnect[bot]' }
    expect(planContract(input({ pr: byApp }))).toEqual(wait('merged_by_app'))
    expect(planContract(input({ pr: byApp, verifierAgentId: 'v1', verifiedAt: new Date(0) }))).toEqual(DONE)
    expect(planContract(input({ pr: MERGED }))).toEqual(DONE)
    // pr_checks_green does not depend on who merged.
    expect(
      planContract(input({ contract: 'pr_checks_green', pr: byApp, checks: { headSha: HEAD, verdict: 'green' } }))
    ).toEqual(DONE)
  })

  it('vera-415 actions:read: unreadable workflows never go green, but a visible failure still reads as failed', () => {
    const at = (verdict: ChecksVerdict) =>
      planContract(
        input({ contract: 'pr_checks_green', pr: OPEN, checks: { headSha: HEAD, verdict, actionsUnreadable: true } })
      )
    expect(at('green')).toEqual(wait('actions_read_missing'))
    expect(at('pending')).toEqual(wait('actions_read_missing'))
    expect(at('failed')).toEqual(wait('checks_failed'))
  })

  it('vera-415b3: each flagged wait has a one-line body-free note naming the PR and the reason code', () => {
    expect([...FLAGGED_WAITS].sort()).toEqual(['actions_read_missing', 'merged_by_app', 'pr_unbound'])
    for (const reason of FLAGGED_WAITS) {
      const text = contractAttentionComment(reason, 12)
      expect(text).toContain('#12')
      expect(text).toContain(`(${reason})`)
      expect(text.includes('\n')).toBe(false)
    }
  })

  it('the unmerged-close note is one body-free line naming the PR number and the reason code', () => {
    const text = prClosedUnmergedComment(12)
    expect(text).toContain('#12')
    expect(text).toContain('`ac/status:triage` (pr_closed_unmerged)')
    expect(text.includes('\n')).toBe(false)
  })
})
