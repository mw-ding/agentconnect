// KanbanPrContracts over fakes: doorbell routing, stale suites, the verifier re-check, sweep batching, and race safety.
import { describe, expect, it, vi } from 'vitest'
import { OrgId } from '../domain/ids.js'
import type {
  KanbanBoardRecord,
  KanbanContractCard,
  KanbanContractFlagInput,
  KanbanContractSettleInput
} from '../persistence/ports.js'
import { statusLabel, type LabelPlan } from './card-state.js'
import type { CheckRunFacts, LivePullRequest } from './contracts.js'
import { KanbanPrContracts } from './pr-contracts.js'

const BOARD: KanbanBoardRecord = {
  id: 'b1',
  orgId: OrgId('org'),
  name: 'eng',
  repoId: 42n,
  repoFullName: 'acme/web',
  synthesizerAgentId: null
}
const REPO = { installationId: 1n, repoId: 42n, repoFullName: 'acme/web' }
const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const PR_BINDING = {
  authorLogin: 'agentconnect[bot]',
  authorType: 'Bot',
  headRef: 'ac/card-7',
  headRepoId: 42n,
  baseRef: 'main',
  defaultBranch: 'main',
  createdAt: new Date('2026-10-16T00:00:00Z'),
  mergedByLogin: 'octocat'
}

const card = (over: Partial<KanbanContractCard> = {}): KanbanContractCard => ({
  cardId: 'c1',
  boardId: BOARD.id,
  issueNumber: 7,
  status: 'review',
  stateRevision: 5n,
  linkedPrNumber: 12,
  workEpisodeStartedAt: new Date('2026-10-15T00:00:00Z'),
  contractFlags: [],
  needsAttention: false,
  verifiedAt: null,
  completionContract: 'pr_merged',
  verifierAgentId: null,
  configRevision: 1n,
  controlVersion: 0n,
  ...over
})

function make(
  opts: {
    cards?: KanbanContractCard[]
    pr?: LivePullRequest | null
    runs?: CheckRunFacts[]
    complete?: boolean
    actionsUnreadable?: boolean
    settle?: boolean
    applyFails?: boolean
  } = {}
) {
  const cards = opts.cards ?? [card()]
  const settles: KanbanContractSettleInput[] = []
  const flags: KanbanContractFlagInput[] = []
  const plans: LabelPlan[] = []
  const repo = {
    listContractCards: vi.fn(
      async (_b: string, q: { prNumbers?: readonly number[]; afterIssueNumber?: number; limit?: number }) =>
        cards
          .filter((c) => !q.prNumbers || q.prNumbers.includes(c.linkedPrNumber!))
          .filter((c) => c.issueNumber > (q.afterIssueNumber ?? 0))
          .slice(0, q.limit ?? Infinity)
    ),
    getContractCard: vi.fn(async (id: string) => cards.find((c) => c.cardId === id) ?? null),
    settleContract: vi.fn(async (input: KanbanContractSettleInput) => {
      settles.push(input)
      return opts.settle ?? true
    }),
    // Mirrors the PG CAS: the first flag for a (reason, PR) on an unflagged card wins; the card row then carries it.
    flagContract: vi.fn(async (input: KanbanContractFlagInput) => {
      const c = cards.find((x) => x.cardId === input.cardId)
      const key = `${input.reason}#${input.prNumber}`
      if (!c || c.stateRevision !== input.expectedStateRevision || c.needsAttention || c.contractFlags.includes(key))
        return false
      flags.push(input)
      Object.assign(c, {
        needsAttention: true,
        contractFlags: [...c.contractFlags, key],
        stateRevision: c.stateRevision + 1n
      })
      return true
    }),
    isLatestControl: vi.fn(async () => true)
  }
  const prs = {
    readPullRequest: vi.fn(async (_repo: unknown, n: number) =>
      opts.pr === undefined
        ? {
            ...PR_BINDING,
            headRef: `ac/card-${cards.find((c) => c.linkedPrNumber === n)?.issueNumber}`,
            number: n,
            state: 'closed' as const,
            merged: true,
            headSha: HEAD
          }
        : opts.pr
    ),
    readCheckRuns: vi.fn(async () => ({
      runs: opts.runs ?? [],
      complete: opts.complete ?? true,
      ...(opts.actionsUnreadable ? { actionsUnreadable: true } : {})
    }))
  }
  const store = {
    readCard: vi.fn(async () => ({
      issueId: 1n,
      nodeId: 'I',
      number: 7,
      labels: [statusLabel('review')],
      state: 'open' as const
    })),
    applyPlan: vi.fn(async (_r: unknown, _n: number, _o: unknown, plan: LabelPlan) => {
      if (opts.applyFails) throw new Error('github 502')
      plans.push(plan)
    })
  }
  const onSettled = vi.fn()
  const project = { onStatusCommitted: vi.fn() }
  const log = { info: vi.fn(), warn: vi.fn() }
  const contracts = new KanbanPrContracts({
    appSlug: 'agentconnect',
    repo,
    prs,
    store,
    repoRef: async () => REPO,
    onSettled,
    project,
    log
  })
  return { contracts, repo, prs, store, settles, flags, plans, onSettled, project, log }
}

const SUCCESS: CheckRunFacts = { status: 'completed', conclusion: 'success' }

describe('KanbanPrContracts', () => {
  it('a merged PR completes its linked pr_merged card: CAS to done, the issue closed as completed, then a wake', async () => {
    const h = make()
    await h.contracts.onPullRequest(BOARD, REPO, { number: 12, merged: true, headSha: HEAD })
    expect(h.settles).toEqual([
      {
        cardId: 'c1',
        expectedStateRevision: 5n,
        expectedConfigRevision: 1n,
        to: 'done',
        reason: 'pr_merged',
        prNumber: 12
      }
    ])
    expect(h.plans[0]).toMatchObject({
      addLabels: [statusLabel('done')],
      removeLabels: [statusLabel('review')],
      issueState: { state: 'closed', reason: 'completed' }
    })
    expect(h.plans[0]!.comment).toBeUndefined()
    expect(h.onSettled).toHaveBeenCalledWith(expect.objectContaining({ cardId: 'c1' }), 'done')
  })

  it('a PR closed unmerged sends the card to triage with one attention comment', async () => {
    const h = make({ pr: { ...PR_BINDING, number: 12, state: 'closed', merged: false, headSha: HEAD } })
    await h.contracts.onPullRequest(BOARD, REPO, { number: 12, merged: false, headSha: HEAD })
    expect(h.settles[0]).toMatchObject({ to: 'triage', reason: 'pr_closed_unmerged' })
    expect(h.plans[0]).toMatchObject({ addLabels: [statusLabel('triage')] })
    expect(h.plans[0]!.comment).toContain('#12 was closed without merging')
  })

  it('the live read decides, not the doorbell: a "merged" doorbell for a PR GitHub says is open moves nothing', async () => {
    const h = make({ pr: { ...PR_BINDING, number: 12, state: 'open', merged: false, headSha: HEAD } })
    await h.contracts.onPullRequest(BOARD, REPO, { number: 12, merged: true, headSha: HEAD })
    expect(h.settles).toEqual([])
  })

  it('waits for the verifier, then the approval path completes it without another event', async () => {
    const pending = make({ cards: [card({ verifierAgentId: 'v1' })] })
    await pending.contracts.onPullRequest(BOARD, REPO, { number: 12, merged: true, headSha: HEAD })
    expect(pending.settles).toEqual([])

    const approved = make({ cards: [card({ verifierAgentId: 'v1', verifiedAt: new Date() })] })
    expect(await approved.contracts.onVerified('c1')).toBe('done')
    expect(approved.settles[0]).toMatchObject({ to: 'done' })
    expect(await approved.contracts.onVerified('missing')).toBeNull()
  })

  it('a green suite on the current head completes a pr_checks_green card; pr_merged cards ignore suites', async () => {
    const h = make({
      cards: [card({ completionContract: 'pr_checks_green' }), card({ cardId: 'c2', issueNumber: 8 })],
      pr: { ...PR_BINDING, number: 12, state: 'open', merged: false, headSha: HEAD },
      runs: [SUCCESS, { status: 'completed', conclusion: 'skipped' }]
    })
    await h.contracts.onCheckSuite(BOARD, REPO, { headSha: HEAD, conclusion: 'success', prNumbers: [12] })
    expect(h.prs.readCheckRuns).toHaveBeenCalledWith(REPO, HEAD)
    expect(h.settles.map((s) => [s.cardId, s.to, s.reason])).toEqual([['c1', 'done', 'pr_checks_green']])
  })

  it('a suite for an older head is ignored, and failing or pending checks leave the card in review', async () => {
    const at = (runs: CheckRunFacts[], headSha = HEAD, complete = true) => {
      const h = make({
        cards: [card({ completionContract: 'pr_checks_green' })],
        pr: { ...PR_BINDING, number: 12, state: 'open', merged: false, headSha: HEAD },
        runs,
        complete
      })
      return h.contracts.onCheckSuite(BOARD, REPO, { headSha, conclusion: 'success', prNumbers: [12] }).then(() => h)
    }
    const stale = await at([SUCCESS], OLD)
    expect(stale.prs.readCheckRuns).not.toHaveBeenCalled()
    expect(stale.settles).toEqual([])
    expect((await at([SUCCESS, { status: 'completed', conclusion: 'failure' }])).settles).toEqual([])
    expect((await at([SUCCESS, { status: 'in_progress', conclusion: null }])).settles).toEqual([])
    expect((await at([])).settles).toEqual([])
    // A truncated run list is never green.
    expect((await at([SUCCESS], HEAD, false)).settles).toEqual([])
  })

  it('a suite naming no PR does nothing', async () => {
    const h = make()
    await h.contracts.onCheckSuite(BOARD, REPO, { headSha: HEAD, conclusion: 'success', prNumbers: [] })
    expect(h.repo.listContractCards).not.toHaveBeenCalled()
  })

  it('a lost CAS writes nothing to GitHub and wakes nobody', async () => {
    const h = make({ settle: false })
    await h.contracts.onPullRequest(BOARD, REPO, { number: 12, merged: true, headSha: HEAD })
    expect(h.store.applyPlan).not.toHaveBeenCalled()
    expect(h.onSettled).not.toHaveBeenCalled()
  })

  it('a label write failure after the commit is logged, never retried as a second move', async () => {
    const h = make({ applyFails: true })
    await h.contracts.onPullRequest(BOARD, REPO, { number: 12, merged: true, headSha: HEAD })
    expect(h.settles).toHaveLength(1)
    expect(h.log.warn).toHaveBeenCalled()
    expect(h.onSettled).toHaveBeenCalledOnce()
  })

  it('a PR read failure propagates, so the doorbell GUID stays unlanded', async () => {
    const h = make()
    h.prs.readPullRequest.mockRejectedValueOnce(new Error('github 502'))
    await expect(h.contracts.onPullRequest(BOARD, REPO, { number: 12, merged: true, headSha: HEAD })).rejects.toThrow()
  })

  it('the sweep judges a bounded batch, resumes after its cursor, and survives one card failing', async () => {
    const cards = Array.from({ length: 30 }, (_, i) =>
      card({ cardId: `c${i}`, issueNumber: i + 1, linkedPrNumber: i + 1 })
    )
    const h = make({ cards })
    h.prs.readPullRequest.mockRejectedValueOnce(new Error('github 502'))
    await h.contracts.sweep(BOARD.id)
    expect(h.repo.listContractCards).toHaveBeenLastCalledWith(BOARD.id, { afterIssueNumber: 0, limit: 25 })
    expect(h.settles).toHaveLength(24)
    expect(h.log.warn).toHaveBeenCalledOnce()
    await h.contracts.sweep(BOARD.id)
    expect(h.repo.listContractCards).toHaveBeenLastCalledWith(BOARD.id, { afterIssueNumber: 25, limit: 25 })
    expect(h.settles).toHaveLength(29)
    // The short page wrapped the cursor back to the start.
    await h.contracts.sweep(BOARD.id)
    expect(h.repo.listContractCards).toHaveBeenLastCalledWith(BOARD.id, { afterIssueNumber: 0, limit: 25 })
  })
})

it('vera-415: unbound PRs wait with body-free metadata before attempting check reads', async () => {
  const h = make({
    cards: [card({ completionContract: 'pr_checks_green' })],
    pr: {
      ...PR_BINDING,
      number: 12,
      state: 'closed',
      merged: true,
      headSha: HEAD,
      authorLogin: 'unrelated'
    }
  })
  h.prs.readCheckRuns.mockRejectedValue(new Error('checks unavailable'))
  expect(await h.contracts.onVerified('c1')).toBe('wait')
  expect(h.prs.readCheckRuns).not.toHaveBeenCalled()
  expect(h.settles).toEqual([])
  expect(h.log.info).toHaveBeenCalledWith(
    { boardId: 'b1', issueNumber: 7, prNumber: 12, reason: 'pr_unbound' },
    'kanban: PR contract needs attention'
  )
})

const UNBOUND: LivePullRequest = {
  ...PR_BINDING,
  number: 12,
  state: 'closed',
  merged: true,
  headSha: HEAD,
  headRef: 'feature-x'
}

it('vera-415b3: pr_unbound is raised once per (card, PR) across doorbells, sweeps and re-checks, with no wait log', async () => {
  const h = make({ pr: UNBOUND })
  for (let i = 0; i < 3; i++) {
    await h.contracts.onPullRequest(BOARD, REPO, { number: 12, merged: true, headSha: HEAD })
    await h.contracts.sweep(BOARD.id)
    await h.contracts.onVerified('c1')
  }
  expect(h.flags).toEqual([{ cardId: 'c1', expectedStateRevision: 5n, reason: 'pr_unbound', prNumber: 12 }])
  expect(h.plans).toHaveLength(1)
  expect(h.plans[0]).toMatchObject({ outcome: 'noop', status: 'review', addLabels: [], removeLabels: [] })
  expect(h.plans[0]!.comment).toContain('#12')
  expect(h.plans[0]!.comment).toContain('(pr_unbound)')
  expect(h.settles).toEqual([])
  expect(h.log.info).toHaveBeenCalledOnce()
})

it('vera-415b3: a card a human cleared is not re-flagged for the same PR, but a newly reported PR is', async () => {
  const c = card()
  const h = make({ cards: [c], pr: UNBOUND })
  await h.contracts.sweep(BOARD.id)
  c.needsAttention = false
  await h.contracts.sweep(BOARD.id)
  expect(h.flags).toHaveLength(1)
  c.linkedPrNumber = 13
  h.prs.readPullRequest.mockResolvedValue({ ...UNBOUND, number: 13 })
  await h.contracts.sweep(BOARD.id)
  expect(h.flags.map((f) => f.prNumber)).toEqual([12, 13])
  expect(h.plans).toHaveLength(2)
})

it('vera-415b3: a lost flag CAS posts no comment', async () => {
  const h = make({ pr: UNBOUND })
  h.repo.flagContract.mockResolvedValueOnce(false)
  await h.contracts.onVerified('c1')
  expect(h.plans).toEqual([])
})

it('vera-415 actions:read: an unreadable workflow list flags pr_checks_green once as actions_read_missing', async () => {
  const h = make({
    cards: [card({ completionContract: 'pr_checks_green' })],
    pr: { ...UNBOUND, headRef: 'ac/card-7', state: 'open', merged: false },
    runs: [SUCCESS],
    complete: false,
    actionsUnreadable: true
  })
  for (let i = 0; i < 2; i++) await h.contracts.sweep(BOARD.id)
  expect(h.settles).toEqual([])
  expect(h.flags).toEqual([{ cardId: 'c1', expectedStateRevision: 5n, reason: 'actions_read_missing', prNumber: 12 }])
  expect(h.plans[0]!.comment).toContain('(actions_read_missing)')
})

describe('vera-415r2: PR contract settlement', () => {
  it('vera-415r2: 🟡2 a settled contract queues the Projects projection; a lost race does not', async () => {
    const won = make()
    await won.contracts.onPullRequest(BOARD, REPO, { number: 12, merged: true, headSha: HEAD })
    expect(won.project.onStatusCommitted).toHaveBeenCalledExactlyOnceWith({ boardId: BOARD.id, issueNumber: 7 })
    const lost = make({ settle: false })
    await lost.contracts.onPullRequest(BOARD, REPO, { number: 12, merged: true, headSha: HEAD })
    expect(lost.project.onStatusCommitted).not.toHaveBeenCalled()
  })

  it('vera-415r2: 🟡1 the settle CAS carries the board configRevision the decision was made under', async () => {
    const h = make({ cards: [card({ configRevision: 9n })] })
    await h.contracts.onPullRequest(BOARD, REPO, { number: 12, merged: true, headSha: HEAD })
    expect(h.settles[0]).toMatchObject({ expectedConfigRevision: 9n })
  })
})
