// Live GitHub + Postgres for the M5 Projects v2 projection (issue #2 Lane 4a).
// Block A runs now against the user-owned mw-ding/agentconnect: the guard refuses project fields and a
// label transition on a projection-less board makes zero project GraphQL calls. Block B needs an
// org-owned scratch repo + project and stays SKIPPED until MD provides them (see e2e-4a.md).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import type { FetchLike } from '../../src/github/api.js'
import { githubKanbanProjectVerifier } from '../../src/kanban/project-guard.js'
import { GithubCardStore } from '../../src/kanban/card-store.js'
import { planStatusWrite } from '../../src/kanban/card-state.js'
import { kanbanProjectHook, KanbanProjectWriter } from '../../src/kanban/project-writer.js'
import { PgKanbanBoardRepo, PgKanbanCardRepo } from '../../src/persistence/repositories/kanban.repo.js'
import { prisma } from '../setup.db.js'

const TOKEN = process.env.GITHUB_TOKEN
const blockA = !process.env.CI && process.env.KANBAN_E2E === '1' && !!TOKEN
const blockB =
  blockA &&
  process.env.KANBAN_PROJECT_E2E === '1' &&
  !!process.env.KANBAN_PROJECT_ORG_REPO &&
  !!process.env.KANBAN_PROJECT_NODE_ID &&
  !!process.env.KANBAN_PROJECT_STATUS_FIELD_ID &&
  !!process.env.KANBAN_PROJECT_ISSUE_NODE_ID
const OWNER = 'mw-ding'
const FULL = `${OWNER}/agentconnect`
const REPO_ID = 1332342098n
const INSTALLATION_ID = 424242n

async function gh<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status}`)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

interface Issue {
  id: number
  number: number
  node_id: string
  state: string
  state_reason: string | null
  labels: Array<{ name: string }>
}

describe.skipIf(!blockA)('kanban projection 4a e2e (live GitHub)', () => {
  const started = Date.now()
  const issues: number[] = []
  const createdLabels: string[] = []
  const projectCalls: unknown[] = []
  let boardId = ''
  const phase = (name: string, observed: unknown = {}) =>
    console.log(`${new Date().toISOString()} +${Date.now() - started}ms ${name}`, observed)

  // Counts every GraphQL call aimed at Projects v2; every other GitHub call passes through untouched.
  const spyFetch: FetchLike = async (url, init) => {
    const body = typeof init?.body === 'string' ? init.body : ''
    if (
      body.includes('addProjectV2ItemById') ||
      body.includes('updateProjectV2ItemFieldValue') ||
      body.includes('KanbanProjectGuard')
    ) {
      projectCalls.push(JSON.parse(body))
    }
    return fetch(url, init)
  }
  const patCard = { mintKanbanCard: async () => ({ token: TOKEN! }) } as never
  const patProject = (mint: ReturnType<typeof vi.fn>) => ({ mintKanbanProject: mint }) as never

  beforeAll(async () => {
    phase('setup: live repository labels')
    const existing = new Set<string>()
    for (let page = 1; ; page++) {
      const labels = await gh<Array<{ name: string }>>('GET', `/repos/${FULL}/labels?per_page=100&page=${page}`)
      for (const label of labels) existing.add(label.name)
      if (labels.length < 100) break
    }
    for (const name of ['ac/status:triage', 'ac/status:todo']) {
      if (existing.has(name)) continue
      await gh('POST', `/repos/${FULL}/labels`, { name, color: 'ededed' })
      createdLabels.push(name)
    }
  }, 120_000)

  afterAll(async () => {
    const cleanup = await Promise.allSettled([
      ...createdLabels.map((name) => gh('DELETE', `/repos/${FULL}/labels/${encodeURIComponent(name)}`)),
      ...issues.map(async (number) => {
        await gh('PATCH', `/repos/${FULL}/issues/${number}`, { state: 'closed', state_reason: 'not_planned' })
        const closed = await gh<Issue>('GET', `/repos/${FULL}/issues/${number}`)
        expect(closed).toMatchObject({ state: 'closed', state_reason: 'not_planned' })
        phase('cleanup: confirmed closed/not_planned', { issue: number })
      })
    ])
    if (boardId) {
      await prisma.kanbanCard.deleteMany({ where: { boardId } })
      await prisma.kanbanBoard.deleteMany({ where: { id: boardId } })
    }
    for (const result of cleanup) if (result.status === 'rejected') throw result.reason
  }, 120_000)

  it('Block A1: refuses project fields on the user-owned repo with no project GraphQL call', async () => {
    const repo = await gh<{ id: number; owner: { type: string } }>('GET', `/repos/${FULL}`)
    expect(BigInt(repo.id)).toBe(REPO_ID)
    expect(repo.owner.type).toBe('User')
    const mint = vi.fn(async () => ({
      token: TOKEN!,
      ttlSec: 3600,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      repoFullName: FULL,
      access: 'read' as const
    }))
    const verifier = githubKanbanProjectVerifier({ tokens: patProject(mint), fetchImpl: spyFetch })
    const verdict = await verifier.verify({
      installationId: INSTALLATION_ID,
      repoId: REPO_ID,
      repoFullName: FULL,
      ownerType: 'User',
      projectNodeId: 'PVT_lane4a',
      statusFieldId: 'PVTSSF_lane4a'
    })
    expect(verdict).toEqual({ ok: false, code: 'project_requires_org_repo' })
    expect(mint).not.toHaveBeenCalled()
    expect(projectCalls).toHaveLength(0)
    phase('A1 refused without a project call', verdict)
  })

  it('Block A2: creates the board without project fields and transitions a card with zero project calls', async () => {
    boardId = (
      await prisma.kanbanBoard.create({
        data: { orgId: DEFAULT_ORG_ID, name: `lane4a-e2e ${started}`, repoId: REPO_ID, repoFullName: FULL }
      })
    ).id
    const created = await gh<Issue>('POST', `/repos/${FULL}/issues`, {
      title: `[kanban-e2e] lane4a projection-skip ${started}`,
      body: 'Scratch issue for the Lane 4a live check. No repository changes are requested.',
      labels: ['ac/status:triage']
    })
    issues.push(created.number)
    const repo = { installationId: INSTALLATION_ID, repoId: REPO_ID, repoFullName: FULL }
    const store = new GithubCardStore({ tokens: patCard, fetchImpl: spyFetch })
    const observed = await store.readCard(repo, created.number)
    expect(observed).not.toBeNull()
    await store.applyPlan(repo, created.number, observed!, planStatusWrite('todo', observed!))
    await vi.waitFor(
      async () => {
        const live = await gh<Issue>('GET', `/repos/${FULL}/issues/${created.number}`)
        expect(live.labels.map((l) => l.name).sort()).toEqual(['ac/status:todo'])
      },
      { timeout: 45_000, interval: 1_000 }
    )
    const card = await prisma.kanbanCard.create({
      data: {
        boardId,
        issueId: BigInt(created.id),
        issueNumber: created.number,
        issueNodeId: created.node_id,
        status: 'todo'
      }
    })
    const mint = vi.fn(async () => ({
      token: TOKEN!,
      ttlSec: 3600,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      repoFullName: FULL,
      access: 'read' as const
    }))
    const hook = kanbanProjectHook({
      boards: new PgKanbanBoardRepo(prisma),
      cards: new PgKanbanCardRepo(prisma),
      writer: new KanbanProjectWriter({ tokens: patProject(mint), fetchImpl: spyFetch })
    })
    await expect(
      hook.projectAfterLabel({
        boardId,
        orgId: DEFAULT_ORG_ID,
        cardId: card.id,
        repo,
        status: 'todo',
        issueNodeId: created.node_id
      })
    ).resolves.toBeUndefined()
    expect(mint).not.toHaveBeenCalled()
    expect(projectCalls).toHaveLength(0)
    phase('A2 transition kept, zero project calls', { issue: created.number })
  })

  describe.skipIf(!blockB)('Block B: live projection on an org project (MD-gated)', () => {
    it('adds the item, sets three statuses, and reads back the field value', async () => {
      const orgRepo = process.env.KANBAN_PROJECT_ORG_REPO!
      const projectNodeId = process.env.KANBAN_PROJECT_NODE_ID!
      const statusFieldId = process.env.KANBAN_PROJECT_STATUS_FIELD_ID!
      const [owner, name] = orgRepo.split('/')
      const repoMeta = await gh<{ id: number; owner: { type: string } }>('GET', `/repos/${owner}/${name}`)
      expect(repoMeta.owner.type).toBe('Organization')
      const mint = async () => ({
        token: TOKEN!,
        ttlSec: 3600,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        repoFullName: orgRepo,
        access: 'read' as const
      })
      const verifier = githubKanbanProjectVerifier({
        tokens: { mintKanbanProject: mint } as never,
        fetchImpl: spyFetch
      })
      const verdict = await verifier.verify({
        installationId: INSTALLATION_ID,
        repoId: BigInt(repoMeta.id),
        repoFullName: orgRepo,
        ownerType: 'Organization',
        projectNodeId,
        statusFieldId
      })
      expect(verdict.ok).toBe(true)
      const writer = new KanbanProjectWriter({ tokens: { mintKanbanProject: mint } as never, fetchImpl: spyFetch })
      const issueNodeId = process.env.KANBAN_PROJECT_ISSUE_NODE_ID!
      for (const status of ['todo', 'ready', 'done'] as const) {
        const result = await writer.project({
          repo: { installationId: INSTALLATION_ID, repoId: BigInt(repoMeta.id), repoFullName: orgRepo },
          board: { projectNodeId, statusFieldId },
          card: { issueNodeId, projectItemId: null },
          status
        })
        expect(result).not.toBeNull()
      }
      phase('B projection wrote three statuses', { orgRepo })
    })
  })
})
