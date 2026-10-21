// Live GitHub e2e for the Kanban graph doorbell + reconciler; opt-in via KANBAN_E2E=1 and GITHUB_TOKEN.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { OrgId } from '../../src/domain/ids.js'
import { KanbanGraphDoorbell } from '../../src/kanban/graph-doorbell.js'
import { KanbanGraphReconciler } from '../../src/kanban/graph-reconciler.js'
import { GithubCardStore, type CardStore } from '../../src/kanban/card-store.js'
import { PgKanbanBoardRepo, PgKanbanCardRepo } from '../../src/persistence/index.js'
import type { GithubInstallationRecord } from '../../src/persistence/ports.js'
import { prisma } from '../setup.db.js'

const TOKEN = process.env.GITHUB_TOKEN
const enabled = process.env.KANBAN_E2E === '1' && !!TOKEN && !process.env.CI
const OWNER = 'mw-ding'
const REPO_NAME = 'agentconnect'
const REPO_ID = 1332342098n
const FULL = `${OWNER}/${REPO_NAME}`
const API = 'https://api.github.com'
const STATUSES = ['triage', 'todo', 'ready', 'running', 'blocked', 'review', 'done', 'archived']

async function gh<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T }
}

async function labelsOf(n: number): Promise<string[]> {
  const { data } = await gh<{ labels: Array<{ name: string }> }>('GET', `/repos/${FULL}/issues/${n}`)
  return data.labels.map((l) => l.name)
}

const poke = (deliveryKey: string, numbers: number[]) => ({
  deliveryKey,
  installationId: '1',
  repoId: REPO_ID.toString(),
  event: 'issue_dependencies' as const,
  action: 'blocked_by_added',
  ids: [],
  numbers
})

describe.skipIf(!enabled)('kanban graph e2e (live GitHub)', () => {
  const ts = Date.now()
  const issues: number[] = []
  const createdLabels: string[] = []
  let boardId = ''
  let a = { id: 0, number: 0 }
  let b = { id: 0, number: 0 }

  const installation: GithubInstallationRecord = {
    id: 'e2e',
    orgId: OrgId(DEFAULT_ORG_ID),
    installationId: 1n,
    accountLogin: OWNER,
    accountType: 'User',
    permissions: { issues: 'write' },
    repositorySelection: 'selected',
    suspendedAt: null,
    revokedAt: null,
    createdAt: new Date(0)
  }
  const log = { debug: vi.fn(), warn: (o: unknown, m?: string) => console.log('warn', m, o) }
  const realStore = () =>
    new GithubCardStore({
      tokens: { mintKanbanCard: async () => ({ token: TOKEN! }) } as never,
      permissions: { permission: async () => 'none' }
    })

  function doorbell(store: Pick<CardStore, 'readCard' | 'readGraph' | 'applyPlan' | 'lastEventId'>) {
    const reconciler = new KanbanGraphReconciler({
      agentSlug: async (orgId, id) =>
        (await prisma.agent.findFirst({ where: { orgId, id }, select: { name: true } }))?.name ?? null,
      cards: new PgKanbanCardRepo(prisma),
      store,
      log
    })
    return new KanbanGraphDoorbell({
      boards: new PgKanbanBoardRepo(prisma),
      installations: { getByInstallationId: async () => installation },
      store,
      onGraph: (board, repo, n, graph) => reconciler.apply(board, repo, n, graph),
      log
    })
  }

  async function createIssue(title: string, labels: string[]) {
    const { status, data } = await gh<{ id: number; number: number }>('POST', `/repos/${FULL}/issues`, {
      title: `[kanban-e2e] ${title} ${ts}`,
      labels
    })
    expect(status).toBe(201)
    issues.push(data.number)
    return data
  }

  // Dependency reads are eventually consistent, so poll until the edge is visible.
  async function untilBlockedBy(n: number, blockerNumber: number) {
    await vi.waitFor(
      async () => {
        const { data } = await gh<Array<{ number: number }>>(
          'GET',
          `/repos/${FULL}/issues/${n}/dependencies/blocked_by`
        )
        expect(data.map((i) => i.number)).toContain(blockerNumber)
      },
      { timeout: 30_000, interval: 1_000 }
    )
  }

  beforeAll(async () => {
    const repo = await gh<{ id: number }>('GET', `/repos/${FULL}`)
    expect(BigInt(repo.data.id)).toBe(REPO_ID)
    const existingLabels = new Set<string>()
    for (let page = 1; ; page++) {
      const labels = await gh<Array<{ name: string }>>('GET', `/repos/${FULL}/labels?per_page=100&page=${page}`)
      expect(labels.status).toBe(200)
      for (const label of labels.data) existingLabels.add(label.name)
      if (labels.data.length < 100) break
    }
    for (const name of [...STATUSES.map((s) => `ac/status:${s}`), 'ac/agent:eng-backend']) {
      if (existingLabels.has(name)) continue
      const r = await gh('POST', `/repos/${FULL}/labels`, { name, color: 'ededed' })
      if (r.status === 201) createdLabels.push(name)
      else if (r.status !== 422) throw new Error(`label ${name}: ${r.status}`)
    }
    a = await createIssue('blocker', ['ac/status:running', 'ac/agent:eng-backend'])
    b = await createIssue('dependent', ['ac/status:todo', 'ac/agent:eng-backend'])
    const dep = await gh('POST', `/repos/${FULL}/issues/${b.number}/dependencies/blocked_by`, { issue_id: a.id })
    expect(dep.status).toBe(201)
    await untilBlockedBy(b.number, a.number)
    console.log(`e2e: blocker #${a.number}, dependent #${b.number}`)
  }, 120_000)

  afterAll(async () => {
    for (const n of issues) {
      await gh('PATCH', `/repos/${FULL}/issues/${n}`, { state: 'closed', state_reason: 'not_planned' }).catch(() => {})
    }
    const labelCleanup = await Promise.allSettled(
      createdLabels.map(async (name) => {
        const r = await gh('DELETE', `/repos/${FULL}/labels/${encodeURIComponent(name)}`)
        expect(r.status).toBe(204)
      })
    )
    if (boardId) await prisma.kanbanBoard.delete({ where: { id: boardId } }).catch(() => {})
    console.log(`e2e: closed scratch issues ${issues.join(', ')}`)
    for (const result of labelCleanup) if (result.status === 'rejected') throw result.reason
  }, 120_000)

  const card = (n: number) =>
    prisma.kanbanCard.findUniqueOrThrow({ where: { boardId_issueNumber: { boardId, issueNumber: n } } })

  it('promotes the dependent only after its blocker completes, idempotently, and does not land failed reads', async () => {
    // setup.db.ts truncates every table in beforeEach, so DB rows are seeded inside the test.
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: `e2e ${ts}`, repoId: REPO_ID, repoFullName: FULL }
    })
    boardId = board.id
    await prisma.kanbanCard.create({
      data: { boardId, issueId: BigInt(a.id), issueNumber: a.number, status: 'running' }
    })
    await prisma.kanbanCard.create({ data: { boardId, issueId: BigInt(b.id), issueNumber: b.number, status: 'todo' } })
    const bell = doorbell(realStore())

    console.log('phase 1: blocker open, poke dependent')
    bell.poke(poke('e2e-1', [b.number]))
    await bell.settle()
    expect((await card(b.number)).status).toBe('todo')
    expect(await labelsOf(b.number)).toContain('ac/status:todo')
    expect(bell.landedDeliveryKeys(['e2e-1'])).toEqual(new Set(['e2e-1']))

    console.log('phase 2: close blocker as completed, poke blocker')
    const closed = await gh('PATCH', `/repos/${FULL}/issues/${a.number}`, {
      state: 'closed',
      state_reason: 'completed'
    })
    expect(closed.status).toBe(200)
    await vi.waitFor(
      async () => {
        bell.poke(poke('e2e-2', [a.number]))
        await bell.settle()
        expect((await card(b.number)).status).toBe('ready')
      },
      { timeout: 60_000, interval: 2_000 }
    )
    const labels = await labelsOf(b.number)
    expect(labels).toContain('ac/status:ready')
    expect(labels).not.toContain('ac/status:todo')
    expect(labels).toContain('ac/agent:eng-backend')
    expect(bell.landedDeliveryKeys(['e2e-2'])).toEqual(new Set(['e2e-2']))

    console.log('phase 3: idempotent re-poke')
    const before = await card(b.number)
    bell.poke(poke('e2e-3', [a.number]))
    await bell.settle()
    const after = await card(b.number)
    expect(after.status).toBe('ready')
    expect(after.stateRevision).toBe(before.stateRevision)
    expect(await labelsOf(b.number)).toEqual(labels)

    console.log('phase 4: failed read is not landed')
    const failing = doorbell({
      readCard: realStore().readCard.bind(realStore()),
      readGraph: async () => {
        throw new Error('simulated github failure')
      },
      applyPlan: realStore().applyPlan.bind(realStore()),
      lastEventId: async () => 0
    })
    failing.poke(poke('e2e-4', [b.number]))
    await failing.settle()
    expect(failing.landedDeliveryKeys(['e2e-4'])).toEqual(new Set())
  }, 180_000)
})
