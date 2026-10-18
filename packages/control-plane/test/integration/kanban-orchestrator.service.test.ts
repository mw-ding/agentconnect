// Real Postgres verifies orchestrator idempotency, budgets, and adoption with a recording GitHub store.
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { kanbanOrchestrateCardKey, type KanbanOrchestrate } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { OrgId } from '../../src/domain/ids.js'
import { KanbanOrchestrator } from '../../src/kanban/orchestrator.js'
import { PgKanbanCardRepo } from '../../src/persistence/repositories/kanban.repo.js'
import { PgKanbanOrchestratorRepo } from '../../src/persistence/repositories/kanban-orchestrator.repo.js'
import type { CardIssue } from '../../src/kanban/card-store.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { prisma } from '../setup.db.js'
import {
  KANBAN_ORCHESTRATE_REFUSAL_TEXT,
  KanbanOrchestratorTools
} from '../../../daemon/src/kanban/orchestrator-tools.js'

const ORG = OrgId(DEFAULT_ORG_ID)
const REPO_ID = 990010n
const DIGEST = 'c'.repeat(64)

function fakeStore() {
  const issue = (number: number): CardIssue => ({
    issueId: BigInt(5_000_000 + number),
    nodeId: `I_${number}`,
    number,
    state: 'open',
    stateReason: null,
    labels: [],
    authorType: 'Bot',
    authorLogin: 'agentconnect[bot]'
  })
  return {
    readCard: vi.fn(async (_repo: unknown, n: number) => issue(n)),
    readGraph: vi.fn(async () => ({ parent: null, subIssues: [], blockedBy: [], blocking: [], truncated: false })),
    applyPlan: vi.fn(async () => {}),
    addSubIssue: vi.fn(async () => {}),
    addBlockedBy: vi.fn(async () => {}),
    removeBlockedBy: vi.fn(async () => {}),
    closeIssue: vi.fn(async (_repo: unknown, _issueNumber: number) => {})
  }
}

async function setup(epicMaxCards: number) {
  const daemonId = randomUUID()
  const agentId = randomUUID()
  await seedDaemon(prisma, daemonId, { sessionEpoch: 1n })
  await seedAgent(prisma, agentId, { daemonId, name: `orch-${agentId.slice(0, 8)}` })
  const board = await prisma.kanbanBoard.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      name: `svc-${agentId.slice(0, 8)}`,
      repoId: REPO_ID,
      repoFullName: 'acme/web',
      orchestratorAgentId: agentId,
      epicMaxCards
    }
  })
  const epic = await prisma.kanbanCard.create({
    data: { boardId: board.id, issueId: 5_000_001n, issueNumber: 1, status: 'todo' }
  })
  const store = fakeStore()
  const svc = new KanbanOrchestrator({
    cards: new PgKanbanCardRepo(prisma),
    orchestrator: new PgKanbanOrchestratorRepo(prisma),
    store,
    installations: {
      liveByOrgAndAccount: async () => ({ installationId: 1n, revokedAt: null, suspendedAt: null }) as never
    },
    appSlug: 'agentconnect'
  })
  const create = (step: string, issueNumber?: number) =>
    ({
      op: issueNumber === undefined ? 'prepare_create' : 'commit_create',
      agentId,
      boardId: board.id,
      epicIssueNumber: 1,
      step,
      specDigest: DIGEST,
      ...(issueNumber !== undefined ? { issueNumber } : {})
    }) as KanbanOrchestrate
  return { agentId, daemonId, board, epic, store, svc, create }
}

describe('KanbanOrchestrator over real Postgres', () => {
  it('a replay on a full epic returns the existing card and closes nothing', async () => {
    const h = await setup(1)
    expect(await h.svc.orchestrate(ORG, h.agentId, h.create('child', 10))).toMatchObject({
      ok: true,
      op: 'commit_create',
      issueNumber: 10
    })
    // The epic is full now; a re-plan of the same step answers existing, and a retried commit returns the same card.
    expect(await h.svc.orchestrate(ORG, h.agentId, h.create('child'))).toEqual({
      ok: true,
      op: 'prepare_create',
      verdict: 'existing',
      appLogin: 'agentconnect[bot]',
      issueNumber: 10
    })
    expect(await h.svc.orchestrate(ORG, h.agentId, h.create('child', 10))).toMatchObject({
      ok: true,
      issueNumber: 10
    })
    expect(h.store.closeIssue).not.toHaveBeenCalled()
    const epic = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: h.epic.id } })
    expect(epic).toMatchObject({ status: 'todo', epicCardsCreated: 1 })
    const key = kanbanOrchestrateCardKey({ boardId: h.board.id, epicIssueNumber: 1, step: 'child', specDigest: DIGEST })
    expect((await prisma.kanbanCard.findFirstOrThrow({ where: { issueNumber: 10 } })).idempotencyKey).toBe(key)
  })

  it('a new create on a full epic is refused, closes only its own issue, and moves the epic to triage', async () => {
    const h = await setup(1)
    await h.svc.orchestrate(ORG, h.agentId, h.create('first', 10))
    expect(await h.svc.orchestrate(ORG, h.agentId, h.create('second'))).toEqual({
      ok: false,
      op: 'prepare_create',
      code: 'epic_budget_exhausted'
    })
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: h.epic.id } })).status).toBe('triage')
    // A commit that raced past prepare trips B2 under the lock: its issue (#11, no card) is closed, nothing else.
    expect(await h.svc.orchestrate(ORG, h.agentId, h.create('second', 11))).toEqual({
      ok: false,
      op: 'commit_create',
      code: 'epic_budget_exhausted'
    })
    expect(h.store.closeIssue.mock.calls.map((c) => c[1])).toEqual([11])
    expect(await prisma.kanbanCard.count({ where: { boardId: h.board.id, issueNumber: 11 } })).toBe(0)
  })

  it('a leased epic is refused but never moved', async () => {
    const h = await setup(1)
    await h.svc.orchestrate(ORG, h.agentId, h.create('first', 10))
    await prisma.kanbanRun.create({
      data: {
        cardId: h.epic.id,
        attempt: 1,
        agentId: h.agentId,
        daemonId: h.daemonId,
        leaseId: randomUUID(),
        dispatchRevision: 0n,
        dispatchedAt: new Date()
      }
    })
    expect(await h.svc.orchestrate(ORG, h.agentId, h.create('second'))).toMatchObject({
      code: 'epic_budget_exhausted'
    })
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: h.epic.id } })).status).toBe('todo')
  })

  it('concurrent commits at the boundary admit exactly the remaining room and close exactly the losers', async () => {
    const h = await setup(3)
    await h.svc.orchestrate(ORG, h.agentId, h.create('pre', 10))
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => h.svc.orchestrate(ORG, h.agentId, h.create(`race-${i}`, 20 + i)))
    )
    const won = results.filter((r) => r.ok)
    const lost = results.filter((r) => !r.ok)
    expect(won).toHaveLength(2)
    expect(lost).toHaveLength(3)
    for (const r of lost) expect(r).toMatchObject({ code: 'epic_budget_exhausted' })
    const closed = h.store.closeIssue.mock.calls.map((c) => c[1]).sort()
    const cardsFiled = (
      await prisma.kanbanCard.findMany({ where: { boardId: h.board.id, issueNumber: { gte: 20 } } })
    ).map((c) => c.issueNumber)
    expect(cardsFiled).toHaveLength(2)
    expect(closed).toHaveLength(3)
    expect(closed.some((n) => cardsFiled.includes(n))).toBe(false)
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: h.epic.id } })).epicCardsCreated).toBe(3)
  })
})

it.each(['open', 'closed'] as const)(
  'recovers a %s intent crash through the trailing-marker lookup with one POST and one card',
  async (state) => {
    const h = await setup(1)
    const journalPath = join(mkdtempSync(join(tmpdir(), 'ac-pending-')), 'pending.json')
    const issues: Array<{ number: number; body: string }> = []
    let fileCrashed = true
    const fileIssue = vi.fn(async (_agent: string, _repo: string, _title: string, body: string) => {
      // The POST landed server-side, but the crash kept the number out of the journal.
      issues.push({ number: 10 + issues.length, body })
      if (fileCrashed) throw new Error('process died during file')
      return issues.at(-1)!.number
    })
    let laggedOnce = false
    const findIssue = vi.fn(
      async (
        _agent: string,
        _repo: string,
        marker: string,
        appLogin: string | null | undefined,
        rejected: number[] = []
      ) => {
        expect(appLogin).toBe('agentconnect[bot]')
        if (!laggedOnce) {
          laggedOnce = true
          return null
        }
        return (
          issues
            .filter((i) => !rejected.includes(i.number) && i.body.trimEnd().endsWith(marker))
            .sort((a, b) => a.number - b.number)[0]?.number ?? null
        )
      }
    )
    const deps = {
      orchestrate: (p: KanbanOrchestrate) => h.svc.orchestrate(ORG, h.agentId, p),
      repoFullNameFor: async () => 'acme/web',
      findIssue,
      fileIssue,
      journalPath
    }
    const req = { agentId: h.agentId, board: h.board.id, epic: 1, step: 'crash', title: 'scratch', body: 'spec' }
    await expect(new KanbanOrchestratorTools(deps).create(req)).rejects.toThrow('process died during file')
    expect(fileIssue).toHaveBeenCalledTimes(1)
    // Listing lag hides the landed POST, so the restart files nothing and asks for a retry.
    expect(await new KanbanOrchestratorTools(deps).create(req)).toEqual({
      refused: KANBAN_ORCHESTRATE_REFUSAL_TEXT.github_unavailable,
      retryable: true
    })
    expect(fileIssue).toHaveBeenCalledTimes(1)
    expect(issues).toHaveLength(1)
    expect(await prisma.kanbanCard.count({ where: { boardId: h.board.id, id: { not: h.epic.id } } })).toBe(0)
    fileCrashed = false
    h.store.readCard.mockImplementation(async (_repo, n) => ({
      issueId: BigInt(5_000_000 + n),
      nodeId: `I_${n}`,
      number: n,
      state,
      stateReason: null,
      labels: [],
      authorType: 'Bot',
      authorLogin: 'agentconnect[bot]'
    }))
    // The marker is visible now, so the retry adopts issue 10 with no second POST.
    expect(await new KanbanOrchestratorTools(deps).create(req)).toMatchObject({ created: true, issueNumber: 10 })
    expect(fileIssue).toHaveBeenCalledTimes(1)
    expect(issues).toHaveLength(1)
    expect(await prisma.kanbanCard.count({ where: { boardId: h.board.id, issueNumber: 10 } })).toBe(1)
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: h.epic.id } })).epicCardsCreated).toBe(1)
    expect(await new KanbanOrchestratorTools(deps).create(req)).toEqual({ existing: true, issueNumber: 10 })
    expect(h.store.closeIssue).not.toHaveBeenCalled()
  }
)

it.each(['open', 'closed'] as const)(
  'commits a %s journaled-number crash with no POST and no lookup',
  async (state) => {
    const h = await setup(1)
    const journalPath = join(mkdtempSync(join(tmpdir(), 'ac-pending-')), 'pending.json')
    const issues: Array<{ number: number; body: string }> = []
    const fileIssue = vi.fn(async (_agent: string, _repo: string, _title: string, body: string) => {
      issues.push({ number: 10 + issues.length, body })
      return issues.at(-1)!.number
    })
    const findIssue = vi.fn(async () => null)
    let crash = true
    const deps = {
      orchestrate: async (p: KanbanOrchestrate) => {
        if (p.op === 'commit_create' && crash) throw new Error('process died before commit')
        return h.svc.orchestrate(ORG, h.agentId, p)
      },
      repoFullNameFor: async () => 'acme/web',
      findIssue,
      fileIssue,
      journalPath
    }
    const req = { agentId: h.agentId, board: h.board.id, epic: 1, step: 'crash', title: 'scratch', body: 'spec' }
    expect(await new KanbanOrchestratorTools(deps).create(req)).toMatchObject({ filed: true, issueNumber: 10 })
    expect(fileIssue).toHaveBeenCalledTimes(1)
    expect(await prisma.kanbanCard.count({ where: { boardId: h.board.id, issueNumber: 10 } })).toBe(0)
    crash = false
    h.store.readCard.mockImplementation(async (_repo, n) => ({
      issueId: BigInt(5_000_000 + n),
      nodeId: `I_${n}`,
      number: n,
      state,
      stateReason: null,
      labels: [],
      authorType: 'Bot',
      authorLogin: 'agentconnect[bot]'
    }))
    // A fresh toolset reloads the journaled number and commits it directly.
    expect(await new KanbanOrchestratorTools(deps).create(req)).toMatchObject({ created: true, issueNumber: 10 })
    expect(fileIssue).toHaveBeenCalledTimes(1)
    expect(findIssue).not.toHaveBeenCalled()
    expect(issues).toHaveLength(1)
    expect(await prisma.kanbanCard.count({ where: { boardId: h.board.id, issueNumber: 10 } })).toBe(1)
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: h.epic.id } })).epicCardsCreated).toBe(1)
    expect(await new KanbanOrchestratorTools(deps).create(req)).toEqual({ existing: true, issueNumber: 10 })
    expect(h.store.closeIssue).not.toHaveBeenCalled()
  }
)
