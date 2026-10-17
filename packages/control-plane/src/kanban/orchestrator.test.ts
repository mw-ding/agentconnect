// Kanban orchestrator service (issue #2 M3): role gate, B1 replay, B2 refusals, and link/unblock/assign semantics
// over fakes — the GitHub and repo writes are observed, never real.
import { describe, expect, it, vi } from 'vitest'
import type { KanbanOrchestrate } from '@agentconnect.md/protocol'
import { cardIdempotencyKey } from './card-key.js'
import { KanbanOrchestrator, type KanbanOrchestratorDeps } from './orchestrator.js'
import type { KanbanRepoRef, CardIssue } from './card-store.js'
import type { OrgId } from '../domain/ids.js'
import { GithubApiError } from '../github/api.js'
import { InstallationTokenInvalidatedError } from '../github/installation-token.service.js'
import { KanbanCardUpsertError, type KanbanCardUpsertErrorCode } from '../persistence/ports.js'

const ORG = 'org' as OrgId
const AGENT = '11111111-1111-4111-8111-111111111111'
const BOARD = '22222222-2222-4222-8222-222222222222'
const REPO: KanbanRepoRef = { installationId: 1n, repoId: 42n, repoFullName: 'acme/web' }
const board = { id: BOARD, orgId: ORG, repoId: 42n, repoFullName: 'acme/web', epicMaxCards: 100 }

function issue(over: Partial<CardIssue> = {}): CardIssue {
  return {
    issueId: 9001n,
    nodeId: 'I_9001',
    number: 7,
    state: 'open',
    stateReason: null,
    labels: [],
    ...over
  }
}

const card = (over: Record<string, unknown> = {}) => ({
  cardId: '33333333-3333-4333-8333-333333333333',
  issueId: 7000n,
  issueNumber: 7,
  status: 'todo' as const,
  assigneeAgentId: null as string | null,
  assigneeSlug: null as string | null,
  priority: 0,
  blockKind: null,
  epicCardId: null as string | null,
  epicIssueNumber: null as number | null,
  leased: false,
  stateRevision: 1n,
  ...over
})

/** A mock whose return type is deliberately erased, so tests can mockResolvedValue any shape. */
const anyMock = (impl: (...args: never[]) => unknown) => vi.fn(impl as (...args: any[]) => any) as any

function harness(over: Partial<KanbanOrchestratorDeps> = {}) {
  const store = {
    readCard: anyMock(async () => issue()),
    readGraph: anyMock(async () => ({ parent: null, subIssues: [], blockedBy: [], blocking: [], truncated: false })),
    applyPlan: anyMock(async () => {}),
    addSubIssue: anyMock(async () => {}),
    addBlockedBy: anyMock(async () => {}),
    removeBlockedBy: anyMock(async () => {}),
    closeIssue: anyMock(async () => {})
  }
  const cards = {
    findByIdempotencyKey: anyMock(async () => null),
    casStatus: anyMock(async () => true),
    resolveAgentSlug: anyMock(async () => 'agent'),
    setAssignee: anyMock(async () => ({
      ok: true,
      changed: false,
      card: card(),
      previousAgentId: null,
      revokedLease: null
    }))
  }
  const orchestrator = {
    boardForOrchestrator: anyMock(async () => ({ ok: true as const, board })),
    epicBudget: anyMock(async () => 'ok' as const),
    unassignableReason: anyMock(async () => 'unknown_agent' as const),
    // Each issue number maps to a distinct GitHub id, so a test can tell an id from a number.
    cardByIssueNumber: anyMock(async (_board: string, n: number) =>
      card({ issueNumber: n, issueId: BigInt(n) * 1000n })
    ),
    createEpicChild: anyMock(async (input: { upsert: { issueNumber: number } }) => ({
      ok: true as const,
      card: { ...card(), issueNumber: input.upsert.issueNumber },
      created: true,
      matchedBy: 'created' as const
    })),
    adoptEpic: anyMock(async () => ({ ok: true as const, changed: true, card: card() })),
    orchestratorRepoId: anyMock(async () => null),
    orchestratorBoards: anyMock(async () => ({ truncated: false, boards: [] }))
  }
  const installations = {
    liveByOrgAndAccount: anyMock(async () => ({ installationId: 1n, revokedAt: null, suspendedAt: null }))
  }
  const svc = new KanbanOrchestrator({
    cards: cards as never,
    orchestrator: orchestrator as never,
    store: store as never,
    installations: installations as never,
    ...over
  })
  return { svc, store, cards, orchestrator }
}

const req = (op: KanbanOrchestrate['op'], over: Record<string, unknown> = {}): KanbanOrchestrate =>
  ({ op, agentId: AGENT, boardId: BOARD, ...over }) as KanbanOrchestrate

describe('KanbanOrchestrator role gate', () => {
  it('returns board_not_found for an unknown or other-org board', async () => {
    const h = harness()
    h.orchestrator.boardForOrchestrator.mockResolvedValue({ ok: false, reason: 'board_not_found' })
    expect(
      await h.svc.orchestrate(ORG, AGENT, req('prepare_create', { step: 's', specDigest: 'a'.repeat(64) }))
    ).toEqual({
      ok: false,
      op: 'prepare_create',
      code: 'board_not_found'
    })
  })

  it('returns board_disabled and not_orchestrator', async () => {
    const h = harness()
    h.orchestrator.boardForOrchestrator.mockResolvedValue({ ok: false, reason: 'board_disabled' })
    expect(await h.svc.orchestrate(ORG, AGENT, req('link', { issueNumber: 7 }))).toEqual({
      ok: false,
      op: 'link',
      code: 'board_disabled'
    })
    h.orchestrator.boardForOrchestrator.mockResolvedValue({ ok: false, reason: 'not_orchestrator' })
    expect(await h.svc.orchestrate(ORG, AGENT, req('assign', { issueNumber: 7, assignee: null }))).toEqual({
      ok: false,
      op: 'assign',
      code: 'not_orchestrator'
    })
  })
})

describe('KanbanOrchestrator prepare_create', () => {
  it('returns existing for a B1 key already filed, with zero GitHub writes', async () => {
    const h = harness()
    const key = cardIdempotencyKey({ epic: `board:${BOARD}`, step: 's', spec: 'a'.repeat(64) })
    h.cards.findByIdempotencyKey.mockResolvedValue(card({ issueNumber: 99 }))
    const out = await h.svc.orchestrate(ORG, AGENT, req('prepare_create', { step: 's', specDigest: 'a'.repeat(64) }))
    expect(out).toEqual({ ok: true, op: 'prepare_create', verdict: 'existing', issueNumber: 99 })
    expect(h.cards.findByIdempotencyKey).toHaveBeenCalledWith(BOARD, key)
  })

  it('refuses epic_not_found and epic_budget_exhausted before filing', async () => {
    const h = harness()
    h.orchestrator.epicBudget.mockResolvedValue('epic_not_found')
    expect(
      await h.svc.orchestrate(
        ORG,
        AGENT,
        req('prepare_create', { step: 's', specDigest: 'a'.repeat(64), epicIssueNumber: 1 })
      )
    ).toEqual({
      ok: false,
      op: 'prepare_create',
      code: 'epic_not_found'
    })
    h.orchestrator.epicBudget.mockResolvedValue('epic_budget_exhausted')
    expect(
      await h.svc.orchestrate(
        ORG,
        AGENT,
        req('prepare_create', { step: 's', specDigest: 'a'.repeat(64), epicIssueNumber: 1 })
      )
    ).toEqual({
      ok: false,
      op: 'prepare_create',
      code: 'epic_budget_exhausted'
    })
  })

  it('refuses an unknown assignee and proceeds otherwise', async () => {
    const h = harness()
    h.cards.resolveAgentSlug.mockResolvedValue(null)
    expect(
      await h.svc.orchestrate(
        ORG,
        AGENT,
        req('prepare_create', { step: 's', specDigest: 'a'.repeat(64), assignee: 'nope' })
      )
    ).toEqual({
      ok: false,
      op: 'prepare_create',
      code: 'unknown_agent'
    })
    h.cards.resolveAgentSlug.mockResolvedValue('agent')
    expect(
      await h.svc.orchestrate(
        ORG,
        AGENT,
        req('prepare_create', { step: 's', specDigest: 'a'.repeat(64), assignee: 'ash' })
      )
    ).toEqual({
      ok: true,
      op: 'prepare_create',
      verdict: 'proceed'
    })
  })
})

describe('KanbanOrchestrator commit_create', () => {
  it('refuses issue_not_found and issue_not_from_app', async () => {
    const h = harness()
    h.store.readCard.mockResolvedValue(null)
    expect(
      await h.svc.orchestrate(
        ORG,
        AGENT,
        req('commit_create', { step: 's', specDigest: 'a'.repeat(64), issueNumber: 7 })
      )
    ).toEqual({
      ok: false,
      op: 'commit_create',
      code: 'issue_not_found'
    })
    const h2 = harness({ appSlug: 'agentconnect' })
    h2.store.readCard.mockResolvedValue(issue({ authorType: 'User', authorLogin: 'alice' }))
    expect(
      await h2.svc.orchestrate(
        ORG,
        AGENT,
        req('commit_create', { step: 's', specDigest: 'a'.repeat(64), issueNumber: 7 })
      )
    ).toEqual({
      ok: false,
      op: 'commit_create',
      code: 'issue_not_from_app'
    })
    const ok = harness({ appSlug: 'agentconnect' })
    ok.store.readCard.mockResolvedValue(issue({ authorType: 'Bot', authorLogin: 'agentconnect[bot]' }))
    await ok.svc.orchestrate(
      ORG,
      AGENT,
      req('commit_create', { step: 's', specDigest: 'a'.repeat(64), issueNumber: 7 })
    )
    expect(ok.store.applyPlan).toHaveBeenCalled()
  })

  it('closes the just-filed issue when B2 trips at commit', async () => {
    const h = harness({ appSlug: 'agentconnect' })
    h.store.readCard.mockResolvedValue(issue({ authorType: 'Bot', authorLogin: 'agentconnect[bot]' }))
    // The rolled-back create left issue #7 without a card; the epic #1 is a card.
    h.orchestrator.cardByIssueNumber.mockImplementation(async (_b: string, n: number) =>
      n === 7 ? null : card({ issueNumber: n })
    )
    h.orchestrator.createEpicChild.mockResolvedValue({ ok: false, reason: 'epic_budget_exhausted' })
    const out = await h.svc.orchestrate(
      ORG,
      AGENT,
      req('commit_create', { step: 's', specDigest: 'a'.repeat(64), issueNumber: 7, epicIssueNumber: 1 })
    )
    expect(out).toEqual({ ok: false, op: 'commit_create', code: 'epic_budget_exhausted' })
    expect(h.store.closeIssue).toHaveBeenCalledWith(REPO, 7)
  })

  it('closes the duplicate and returns the winner on a key race', async () => {
    const h = harness({ appSlug: 'agentconnect' })
    h.store.readCard.mockResolvedValue(issue({ authorType: 'Bot', authorLogin: 'agentconnect[bot]' }))
    h.orchestrator.cardByIssueNumber.mockImplementation(async (_b: string, n: number) =>
      n === 7 ? null : card({ issueNumber: n })
    )
    h.orchestrator.createEpicChild.mockResolvedValue({
      ok: true,
      card: card({ issueNumber: 99 }),
      created: false,
      matchedBy: 'idempotency_key'
    })
    const out = await h.svc.orchestrate(
      ORG,
      AGENT,
      req('commit_create', { step: 's', specDigest: 'a'.repeat(64), issueNumber: 7 })
    )
    expect(out).toMatchObject({ ok: true, op: 'commit_create', issueNumber: 99 })
    expect(h.store.closeIssue).toHaveBeenCalledWith(REPO, 7)
  })

  it('writes status + agent labels, the sub-issue link, and blocked_by edges', async () => {
    const h = harness()
    await h.svc.orchestrate(
      ORG,
      AGENT,
      req('commit_create', {
        step: 's',
        specDigest: 'a'.repeat(64),
        issueNumber: 7,
        epicIssueNumber: 1,
        assignee: 'ash',
        blockedBy: [2]
      })
    )
    // GitHub takes numeric issue ids here: the new issue's id (9001) under epic #1, and blocker #2's id (2000).
    expect(h.store.addSubIssue).toHaveBeenCalledWith(REPO, 1, 9001n)
    expect(h.store.addBlockedBy).toHaveBeenCalledWith(REPO, 7, 2000n)
    expect(h.store.applyPlan).toHaveBeenCalled()
    const plan = h.store.applyPlan.mock.calls[0]![3]
    expect(plan.addLabels).toContain('ac/status:todo')
    expect(plan.addLabels).toContain('ac/agent:ash')
  })
})

describe('KanbanOrchestrator link/unblock/assign', () => {
  it('link rejects self and cycles and missing cards', async () => {
    const h = harness()
    expect(await h.svc.orchestrate(ORG, AGENT, req('link', { issueNumber: 7, blockedBy: [7] }))).toEqual({
      ok: false,
      op: 'link',
      code: 'invalid_link'
    })
    expect(await h.svc.orchestrate(ORG, AGENT, req('link', { issueNumber: 7, parentIssueNumber: 7 }))).toEqual({
      ok: false,
      op: 'link',
      code: 'invalid_link'
    })
    h.orchestrator.cardByIssueNumber.mockResolvedValue(null)
    expect(await h.svc.orchestrate(ORG, AGENT, req('link', { issueNumber: 7, blockedBy: [2] }))).toEqual({
      ok: false,
      op: 'link',
      code: 'card_not_found'
    })
  })

  it('unblock moves a blocked, unleased card to todo and leaves others alone', async () => {
    const h = harness()
    h.orchestrator.cardByIssueNumber.mockResolvedValue(card({ status: 'blocked', leased: false }))
    const out = await h.svc.orchestrate(ORG, AGENT, req('unblock', { issueNumber: 7, blockers: [3] }))
    expect(out).toEqual({ ok: true, op: 'unblock', status: 'todo' })
    expect(h.cards.casStatus).toHaveBeenCalledWith('33333333-3333-4333-8333-333333333333', 1n, 'todo')
    expect(h.store.applyPlan).toHaveBeenCalled()
  })

  it('unblock deletes edges by the blocker issue id from the live graph, only the named ones', async () => {
    const h = harness()
    const link = (number: number) => ({
      issueId: BigInt(number) * 1000n + 1n,
      number,
      repoId: 42n,
      state: 'open' as const,
      stateReason: null
    })
    h.store.readGraph.mockResolvedValue({
      parent: null,
      subIssues: [],
      blockedBy: [link(3), link(4)],
      blocking: [],
      truncated: false
    })
    await h.svc.orchestrate(ORG, AGENT, req('unblock', { issueNumber: 7, blockers: [3, 99] }))
    expect(h.store.removeBlockedBy.mock.calls).toEqual([[REPO, 7, 3001n]])
    h.store.removeBlockedBy.mockClear()
    await h.svc.orchestrate(ORG, AGENT, req('unblock', { issueNumber: 7 }))
    expect(h.store.removeBlockedBy.mock.calls).toEqual([
      [REPO, 7, 3001n],
      [REPO, 7, 4001n]
    ])
  })

  it('unblock refuses github_unavailable when the graph cannot be read', async () => {
    const h = harness()
    h.store.readGraph.mockRejectedValue(new GithubApiError('github unreachable', 0, 'INTERNAL', true))
    expect(await h.svc.orchestrate(ORG, AGENT, req('unblock', { issueNumber: 7 }))).toEqual({
      ok: false,
      op: 'unblock',
      code: 'github_unavailable'
    })
    expect(h.store.removeBlockedBy).not.toHaveBeenCalled()
  })

  it('link mirrors a parent as a native sub-issue and adds blocked_by by issue id', async () => {
    const h = harness()
    h.orchestrator.cardByIssueNumber.mockImplementation(async (_board: string, n: number) =>
      card({ cardId: `33333333-3333-4333-8333-33333333333${n}`, issueNumber: n, issueId: BigInt(n) * 1000n })
    )
    const out = await h.svc.orchestrate(
      ORG,
      AGENT,
      req('link', { issueNumber: 7, parentIssueNumber: 1, blockedBy: [2, 2] })
    )
    expect(out).toEqual({ ok: true, op: 'link' })
    expect(h.store.addSubIssue).toHaveBeenCalledWith(REPO, 1, 7000n)
    expect(h.store.addBlockedBy.mock.calls).toEqual([[REPO, 7, 2000n]])
  })

  it('commit_create refuses a self-blocker and a blocker that is not a card', async () => {
    const h = harness()
    const base = { step: 's', specDigest: 'a'.repeat(64), issueNumber: 7 }
    expect(await h.svc.orchestrate(ORG, AGENT, req('commit_create', { ...base, blockedBy: [7] }))).toEqual({
      ok: false,
      op: 'commit_create',
      code: 'invalid_link'
    })
    h.orchestrator.cardByIssueNumber.mockResolvedValue(null)
    expect(await h.svc.orchestrate(ORG, AGENT, req('commit_create', { ...base, blockedBy: [2] }))).toEqual({
      ok: false,
      op: 'commit_create',
      code: 'card_not_found'
    })
  })

  it('unblock leaves a non-blocked card alone', async () => {
    const h = harness()
    h.orchestrator.cardByIssueNumber.mockResolvedValue(card({ status: 'todo' }))
    const out = await h.svc.orchestrate(ORG, AGENT, req('unblock', { issueNumber: 7, blockers: [3] }))
    expect(out).toEqual({ ok: true, op: 'unblock', status: 'todo' })
    expect(h.cards.casStatus).not.toHaveBeenCalled()
  })

  it('assign with no change writes nothing', async () => {
    const h = harness()
    h.cards.setAssignee.mockResolvedValue({
      ok: true,
      changed: false,
      card: card(),
      previousAgentId: null,
      revokedLease: null
    })
    const out = await h.svc.orchestrate(ORG, AGENT, req('assign', { issueNumber: 7, assignee: 'ash' }))
    expect(out).toEqual({ ok: true, op: 'assign', assigned: false })
    expect(h.store.applyPlan).not.toHaveBeenCalled()
  })

  it('assign with a revoked lease posts the reassign comment and pokes the claim', async () => {
    const poke = vi.fn()
    const h = harness({ poke })
    h.cards.setAssignee.mockResolvedValue({
      ok: true,
      changed: true,
      card: card({ assigneeAgentId: 'new-agent' }),
      previousAgentId: 'old-agent',
      revokedLease: { leaseId: 'lease', runId: 'run', agentId: 'old', daemonId: 'd', dispatchRevision: 1n }
    })
    const out = await h.svc.orchestrate(ORG, AGENT, req('assign', { issueNumber: 7, assignee: 'ash' }))
    expect(out).toEqual({ ok: true, op: 'assign', assigned: true })
    expect(h.store.applyPlan).toHaveBeenCalled()
    const plan = h.store.applyPlan.mock.calls[0]![3]
    expect(plan.comment).toContain('reassigned')
    expect(poke).toHaveBeenCalledWith(BOARD)
  })
})

const BOT = { authorType: 'Bot', authorLogin: 'agentconnect[bot]' }
const create = (over: Record<string, unknown> = {}) => ({ step: 's', specDigest: 'a'.repeat(64), ...over })
const edge = (number: number, issueId = BigInt(number) * 1000n) => ({
  issueId,
  number,
  repoId: 42n,
  state: 'open' as const,
  stateReason: null
})
const graph = (over: Record<string, unknown> = {}) => ({
  parent: null,
  subIssues: [],
  blockedBy: [],
  blocking: [],
  truncated: false,
  ...over
})

describe('KanbanOrchestrator B1 key and replay (R2, S8)', () => {
  it('answers a replay before the epic or its budget is looked at', async () => {
    const h = harness()
    h.cards.findByIdempotencyKey.mockResolvedValue(card({ issueNumber: 99 }))
    h.orchestrator.epicBudget.mockResolvedValue('epic_budget_exhausted')
    const out = await h.svc.orchestrate(ORG, AGENT, req('prepare_create', create({ epicIssueNumber: 1 })))
    expect(out).toEqual({ ok: true, op: 'prepare_create', verdict: 'existing', issueNumber: 99 })
    expect(h.orchestrator.epicBudget).not.toHaveBeenCalled()
    expect(h.cards.casStatus).not.toHaveBeenCalled()
  })

  it('prepare and commit key on the epic issue number with one helper', async () => {
    const h = harness()
    await h.svc.orchestrate(ORG, AGENT, req('prepare_create', create({ epicIssueNumber: 1 })))
    await h.svc.orchestrate(ORG, AGENT, req('commit_create', create({ epicIssueNumber: 1, issueNumber: 7 })))
    const key = cardIdempotencyKey({ epic: '1', step: 's', spec: 'a'.repeat(64) })
    expect(h.cards.findByIdempotencyKey).toHaveBeenCalledWith(BOARD, key)
    expect(h.orchestrator.createEpicChild.mock.calls[0]![0].upsert.idempotencyKey).toBe(key)
  })
})

describe('KanbanOrchestrator expected failures are refusals (S1, S2)', () => {
  const codes: Array<[KanbanCardUpsertErrorCode, string]> = [
    ['board_not_found', 'board_not_found'],
    ['repo_mismatch', 'repo_mismatch'],
    ['agent_not_in_org', 'unknown_agent'],
    ['agent_not_assignable', 'agent_not_assignable'],
    ['invalid_status', 'status_not_allowed'],
    ['status_not_allowed', 'status_not_allowed'],
    ['key_conflict', 'key_conflict'],
    ['issue_mismatch', 'issue_mismatch']
  ]
  it.each(codes)('maps the upsert error %s to %s and closes nothing', async (thrown, code) => {
    const h = harness({ appSlug: 'agentconnect' })
    h.store.readCard.mockResolvedValue(issue(BOT))
    h.orchestrator.createEpicChild.mockRejectedValue(new KanbanCardUpsertError(thrown))
    const out = await h.svc.orchestrate(ORG, AGENT, req('commit_create', create({ issueNumber: 7 })))
    expect(out).toEqual({ ok: false, op: 'commit_create', code })
    expect(h.store.closeIssue).not.toHaveBeenCalled()
  })

  it('maps a GitHub read failure or a token invalidation to github_unavailable', async () => {
    for (const err of [
      new GithubApiError('github unreachable', 0, 'INTERNAL', true),
      new GithubApiError('github error (502)', 502, 'INTERNAL', true),
      new InstallationTokenInvalidatedError()
    ]) {
      const h = harness()
      h.store.readCard.mockRejectedValue(err)
      expect(await h.svc.orchestrate(ORG, AGENT, req('commit_create', create({ issueNumber: 7 })))).toEqual({
        ok: false,
        op: 'commit_create',
        code: 'github_unavailable'
      })
      h.store.readGraph.mockRejectedValue(err)
      expect(await h.svc.orchestrate(ORG, AGENT, req('unblock', { issueNumber: 7 }))).toEqual({
        ok: false,
        op: 'unblock',
        code: 'github_unavailable'
      })
    }
  })

  it('still surfaces a DB or programming fault', async () => {
    const h = harness()
    h.orchestrator.createEpicChild.mockRejectedValue(new Error('connection reset'))
    await expect(h.svc.orchestrate(ORG, AGENT, req('commit_create', create({ issueNumber: 7 })))).rejects.toThrow(
      'connection reset'
    )
  })
})

describe('KanbanOrchestrator closes only what this create filed (R5)', () => {
  const exhausted = (h: ReturnType<typeof harness>) =>
    h.orchestrator.createEpicChild.mockResolvedValue({ ok: false, reason: 'epic_budget_exhausted' })

  it('never closes without an App slug (the PAT seam cannot prove authorship)', async () => {
    const h = harness()
    h.orchestrator.cardByIssueNumber.mockImplementation(async (_b: string, n: number) =>
      n === 7 ? null : card({ issueNumber: n })
    )
    exhausted(h)
    await h.svc.orchestrate(ORG, AGENT, req('commit_create', create({ issueNumber: 7, epicIssueNumber: 1 })))
    expect(h.store.closeIssue).not.toHaveBeenCalled()
  })

  it('never closes an issue that already has a card on the board', async () => {
    const h = harness({ appSlug: 'agentconnect' })
    h.store.readCard.mockResolvedValue(issue(BOT))
    h.orchestrator.createEpicChild.mockResolvedValue({
      ok: true,
      card: card({ issueNumber: 99 }),
      created: false,
      matchedBy: 'idempotency_key'
    })
    // #7 was imported before this commit, so the key winner #99 does not make #7 ours to close.
    await h.svc.orchestrate(ORG, AGENT, req('commit_create', create({ issueNumber: 7 })))
    expect(h.store.closeIssue).not.toHaveBeenCalled()
  })

  it('swallows a failed close; the refusal is still the answer', async () => {
    const h = harness({ appSlug: 'agentconnect' })
    h.store.readCard.mockResolvedValue(issue(BOT))
    h.orchestrator.cardByIssueNumber.mockImplementation(async (_b: string, n: number) =>
      n === 7 ? null : card({ issueNumber: n })
    )
    h.store.closeIssue.mockRejectedValue(new GithubApiError('down', 502, 'INTERNAL', true))
    exhausted(h)
    expect(
      await h.svc.orchestrate(ORG, AGENT, req('commit_create', create({ issueNumber: 7, epicIssueNumber: 1 })))
    ).toEqual({ ok: false, op: 'commit_create', code: 'epic_budget_exhausted' })
  })
})

describe('KanbanOrchestrator epic to triage on exhaustion (R3)', () => {
  const epic = (over: Record<string, unknown> = {}) =>
    card({ cardId: '44444444-4444-4444-8444-444444444444', issueNumber: 1, status: 'todo', stateRevision: 5n, ...over })
  const withEpic = (h: ReturnType<typeof harness>, e: ReturnType<typeof epic>) =>
    h.orchestrator.cardByIssueNumber.mockImplementation(async (_b: string, n: number) =>
      n === 1 ? e : card({ issueNumber: n, issueId: BigInt(n) * 1000n })
    )
  const triaged = (h: ReturnType<typeof harness>) => {
    expect(h.cards.casStatus).toHaveBeenCalledWith('44444444-4444-4444-8444-444444444444', 5n, 'triage')
    const plan = h.store.applyPlan.mock.calls.find((c: unknown[]) => c[1] === 1)?.[3]
    expect(plan?.addLabels).toContain('ac/status:triage')
  }

  it('moves an unleased epic on prepare_create exhaustion', async () => {
    const h = harness()
    withEpic(h, epic())
    h.orchestrator.epicBudget.mockResolvedValue('epic_budget_exhausted')
    await h.svc.orchestrate(ORG, AGENT, req('prepare_create', create({ epicIssueNumber: 1 })))
    triaged(h)
  })

  it('moves an unleased epic on commit_create exhaustion', async () => {
    const h = harness()
    withEpic(h, epic())
    h.orchestrator.createEpicChild.mockResolvedValue({ ok: false, reason: 'epic_budget_exhausted' })
    await h.svc.orchestrate(ORG, AGENT, req('commit_create', create({ issueNumber: 7, epicIssueNumber: 1 })))
    triaged(h)
  })

  it('moves an unleased epic when link-parent exhausts it', async () => {
    const h = harness()
    withEpic(h, epic())
    h.orchestrator.adoptEpic.mockResolvedValue({ ok: false, reason: 'epic_budget_exhausted' })
    const out = await h.svc.orchestrate(ORG, AGENT, req('link', { issueNumber: 7, parentIssueNumber: 1 }))
    expect(out).toEqual({ ok: false, op: 'link', code: 'epic_budget_exhausted' })
    triaged(h)
    expect(h.store.addSubIssue).not.toHaveBeenCalled()
  })

  it('never moves a leased epic, and leaves one already in triage', async () => {
    for (const e of [epic({ leased: true }), epic({ status: 'triage' })]) {
      const h = harness()
      withEpic(h, e)
      h.orchestrator.epicBudget.mockResolvedValue('epic_budget_exhausted')
      h.orchestrator.adoptEpic.mockResolvedValue({ ok: false, reason: 'epic_budget_exhausted' })
      expect(await h.svc.orchestrate(ORG, AGENT, req('prepare_create', create({ epicIssueNumber: 1 })))).toMatchObject({
        ok: false,
        code: 'epic_budget_exhausted'
      })
      await h.svc.orchestrate(ORG, AGENT, req('link', { issueNumber: 7, parentIssueNumber: 1 }))
      expect(h.cards.casStatus).not.toHaveBeenCalled()
      expect(h.store.applyPlan).not.toHaveBeenCalled()
    }
  })

  it('a lost CAS race writes no label', async () => {
    const h = harness()
    withEpic(h, epic())
    h.cards.casStatus.mockResolvedValue(false)
    h.orchestrator.epicBudget.mockResolvedValue('epic_budget_exhausted')
    await h.svc.orchestrate(ORG, AGENT, req('prepare_create', create({ epicIssueNumber: 1 })))
    expect(h.store.applyPlan).not.toHaveBeenCalled()
  })
})

describe('KanbanOrchestrator edge writes read the graph first (S3, R4)', () => {
  it('skips edges the live graph already has', async () => {
    const h = harness()
    h.store.readGraph.mockResolvedValue(graph({ parent: edge(1), blockedBy: [edge(2)] }))
    const out = await h.svc.orchestrate(
      ORG,
      AGENT,
      req('link', { issueNumber: 7, parentIssueNumber: 1, blockedBy: [2, 3] })
    )
    expect(out).toEqual({ ok: true, op: 'link' })
    expect(h.store.addSubIssue).not.toHaveBeenCalled()
    expect(h.store.addBlockedBy.mock.calls).toEqual([[REPO, 7, 3000n]])
  })

  it('a 422 on add is invalid_link unless a re-read shows the edge', async () => {
    const h = harness()
    h.store.addBlockedBy.mockRejectedValue(new GithubApiError('github error (422)', 422, 'INTERNAL', false))
    expect(await h.svc.orchestrate(ORG, AGENT, req('link', { issueNumber: 7, blockedBy: [2] }))).toEqual({
      ok: false,
      op: 'link',
      code: 'invalid_link'
    })
    expect(h.store.readGraph).toHaveBeenCalledTimes(2)
    // A concurrent writer landed the same edge: the re-read shows it, so the link succeeds.
    const raced = harness()
    raced.store.addBlockedBy.mockRejectedValue(new GithubApiError('github error (422)', 422, 'INTERNAL', false))
    raced.store.readGraph.mockResolvedValueOnce(graph()).mockResolvedValueOnce(graph({ blockedBy: [edge(2)] }))
    expect(await raced.svc.orchestrate(ORG, AGENT, req('link', { issueNumber: 7, blockedBy: [2] }))).toEqual({
      ok: true,
      op: 'link'
    })
  })

  it('a 422 on the sub-issue add is invalid_link unless the re-read shows the parent', async () => {
    const h = harness()
    h.store.addSubIssue.mockRejectedValue(new GithubApiError('github error (422)', 422, 'INTERNAL', false))
    expect(
      await h.svc.orchestrate(ORG, AGENT, req('commit_create', create({ issueNumber: 7, epicIssueNumber: 1 })))
    ).toEqual({ ok: false, op: 'commit_create', code: 'invalid_link' })
  })

  it('a GitHub parent other than the epic is a refused re-parent', async () => {
    const h = harness()
    h.store.readGraph.mockResolvedValue(graph({ parent: edge(5) }))
    expect(await h.svc.orchestrate(ORG, AGENT, req('link', { issueNumber: 7, parentIssueNumber: 1 }))).toEqual({
      ok: false,
      op: 'link',
      code: 'invalid_link'
    })
    expect(h.store.addSubIssue).not.toHaveBeenCalled()
  })

  it('passes the repo refusal of a cycle or re-parent through as invalid_link', async () => {
    const h = harness()
    h.orchestrator.adoptEpic.mockResolvedValue({ ok: false, reason: 'invalid_link' })
    expect(await h.svc.orchestrate(ORG, AGENT, req('link', { issueNumber: 7, parentIssueNumber: 1 }))).toEqual({
      ok: false,
      op: 'link',
      code: 'invalid_link'
    })
    expect(h.store.addSubIssue).not.toHaveBeenCalled()
  })

  it('a non-422 add failure after the DB write is github_partial', async () => {
    const h = harness()
    h.store.addBlockedBy.mockRejectedValue(new GithubApiError('github error (502)', 502, 'INTERNAL', true))
    expect(await h.svc.orchestrate(ORG, AGENT, req('link', { issueNumber: 7, blockedBy: [2] }))).toEqual({
      ok: false,
      op: 'link',
      code: 'github_partial'
    })
  })
})

describe('KanbanOrchestrator unblock bounds (S7)', () => {
  it('omitted blockers on a truncated graph removes what was read, keeps the status, and says so', async () => {
    const h = harness()
    h.orchestrator.cardByIssueNumber.mockResolvedValue(card({ status: 'blocked' }))
    h.store.readGraph.mockResolvedValue(graph({ blockedBy: [edge(3)], truncated: true }))
    const out = await h.svc.orchestrate(ORG, AGENT, req('unblock', { issueNumber: 7 }))
    expect(out).toEqual({ ok: true, op: 'unblock', status: 'blocked', truncated: true })
    expect(h.store.removeBlockedBy.mock.calls).toEqual([[REPO, 7, 3000n]])
    expect(h.cards.casStatus).not.toHaveBeenCalled()
  })

  it('a named blocker past a truncated page is removed through its card row', async () => {
    const h = harness()
    h.store.readGraph.mockResolvedValue(graph({ blockedBy: [edge(3)], truncated: true }))
    await h.svc.orchestrate(ORG, AGENT, req('unblock', { issueNumber: 7, blockers: [3, 8] }))
    expect(h.store.removeBlockedBy.mock.calls).toEqual([
      [REPO, 7, 3000n],
      [REPO, 7, 8000n]
    ])
  })

  it('a 404 on delete (already removed) is success', async () => {
    const h = harness()
    h.store.readGraph.mockResolvedValue(graph({ blockedBy: [edge(3)] }))
    h.store.removeBlockedBy.mockRejectedValue(new GithubApiError('github error (404)', 404, 'INTERNAL', false))
    expect(await h.svc.orchestrate(ORG, AGENT, req('unblock', { issueNumber: 7 }))).toMatchObject({ ok: true })
  })
})

describe('KanbanOrchestrator assign (S6)', () => {
  it('resolves through the Lane 1 policy and explains a null as unknown or restricted', async () => {
    const h = harness()
    h.cards.resolveAgentSlug.mockResolvedValue(null)
    h.orchestrator.unassignableReason.mockResolvedValue('agent_not_assignable')
    expect(await h.svc.orchestrate(ORG, AGENT, req('assign', { issueNumber: 7, assignee: 'vip' }))).toEqual({
      ok: false,
      op: 'assign',
      code: 'agent_not_assignable'
    })
    expect(h.cards.resolveAgentSlug).toHaveBeenCalledWith(ORG, 'vip')
    expect(h.cards.setAssignee).not.toHaveBeenCalled()
  })

  it('maps setAssignee refusals; stale and leased are a conflict, never card_not_found', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ok: false, reason: 'not_found' }, 'card_not_found'],
      [{ ok: false, reason: 'stale' }, 'card_conflict'],
      [{ ok: false, reason: 'leased', lease: {} }, 'card_conflict'],
      [{ ok: false, reason: 'agent_not_in_org' }, 'unknown_agent'],
      [{ ok: false, reason: 'agent_not_assignable' }, 'agent_not_assignable']
    ]
    for (const [result, code] of cases) {
      const h = harness()
      h.cards.setAssignee.mockResolvedValue(result)
      expect(await h.svc.orchestrate(ORG, AGENT, req('assign', { issueNumber: 7, assignee: 'ash' }))).toEqual({
        ok: false,
        op: 'assign',
        code
      })
    }
  })

  it('posts the planReassign comment and mirrors a restart to ready', async () => {
    const h = harness()
    h.orchestrator.cardByIssueNumber.mockResolvedValue(card({ status: 'running', assigneeSlug: 'old-bot' }))
    h.store.readCard.mockResolvedValue(issue({ labels: ['ac/status:running', 'ac/agent:old-bot'] }))
    h.cards.setAssignee.mockResolvedValue({
      ok: true,
      changed: true,
      card: card({ status: 'ready', assigneeAgentId: 'agent' }),
      previousAgentId: 'old-agent',
      revokedLease: { leaseId: 'lease', runId: 'run', agentId: 'old-agent', daemonId: 'd', dispatchRevision: 3n }
    })
    await h.svc.orchestrate(ORG, AGENT, req('assign', { issueNumber: 7, assignee: 'ash' }))
    const plan = h.store.applyPlan.mock.calls[0]![3]
    expect(plan.comment).toBe('AgentConnect Kanban: reassigned from old-bot to ash; restarting in a new session.')
    expect(plan.addLabels).toEqual(['ac/status:ready', 'ac/agent:ash'])
    expect(plan.removeLabels).toEqual(['ac/status:running', 'ac/agent:old-bot'])
  })

  it('a label failure after the reassign is github_partial and still pokes the claim', async () => {
    const poke = vi.fn()
    const h = harness({ poke })
    h.cards.setAssignee.mockResolvedValue({
      ok: true,
      changed: true,
      card: card({ assigneeAgentId: 'agent' }),
      previousAgentId: null,
      revokedLease: { leaseId: 'lease', runId: 'run', agentId: 'old', daemonId: 'd', dispatchRevision: 1n }
    })
    h.store.applyPlan.mockRejectedValue(new GithubApiError('down', 502, 'INTERNAL', true))
    expect(await h.svc.orchestrate(ORG, AGENT, req('assign', { issueNumber: 7, assignee: 'ash' }))).toEqual({
      ok: false,
      op: 'assign',
      code: 'github_partial'
    })
    expect(poke).toHaveBeenCalledWith(BOARD)
  })
})
