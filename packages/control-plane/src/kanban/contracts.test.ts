// PR completion contracts: contract × PR state × verifier × checks × stale sha truth table, and the checks verdict.
import { describe, expect, it } from 'vitest'
import { KANBAN_STATUSES } from './card-state.js'
import {
  checksVerdict,
  planContract,
  prClosedUnmergedComment,
  type ChecksVerdict,
  type ContractDecision,
  type ContractInput,
  type LivePullRequest
} from './contracts.js'

const HEAD = 'a'.repeat(40)
const OPEN: LivePullRequest = { number: 12, state: 'open', merged: false, headSha: HEAD }
const MERGED: LivePullRequest = { ...OPEN, state: 'closed', merged: true }
const CLOSED: LivePullRequest = { ...OPEN, state: 'closed', merged: false }

const input = (over: Partial<ContractInput> = {}): ContractInput => ({
  status: 'review',
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

  it('the unmerged-close note is one body-free line naming the PR number and the reason code', () => {
    const text = prClosedUnmergedComment(12)
    expect(text).toContain('#12')
    expect(text).toContain('`ac/status:triage` (pr_closed_unmerged)')
    expect(text.includes('\n')).toBe(false)
  })
})
