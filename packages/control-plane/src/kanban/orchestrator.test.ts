// Kanban orchestrator service (issue #2 M3): role gate, B1 replay, B2 refusals, and link/unblock/assign semantics
// over fakes — the GitHub and repo writes are observed, never real.
import { describe, expect, it, vi } from 'vitest'
import type { KanbanOrchestrate } from '@agentconnect.md/protocol'
import { cardIdempotencyKey } from './card-key.js'
import { KanbanOrchestrator, type KanbanOrchestratorDeps } from './orchestrator.js'
import type { CardStore, KanbanRepoRef, CardIssue } from './card-store.js'
import type { OrgId } from '../domain/ids.js'

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
    resolveAssignee: anyMock(async () => ({ ok: true as const, agentId: 'agent' })),
    cardByIssueNumber: anyMock(async () => card()),
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
    h.orchestrator.resolveAssignee.mockResolvedValue({ ok: false, reason: 'unknown_agent' })
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
    h.orchestrator.resolveAssignee.mockResolvedValue({ ok: true, agentId: 'agent' })
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
    const h = harness()
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
    const h = harness()
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
    expect(h.store.addSubIssue).toHaveBeenCalledWith(REPO, 1, 7)
    expect(h.store.addBlockedBy).toHaveBeenCalledWith(REPO, 7, 2)
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
