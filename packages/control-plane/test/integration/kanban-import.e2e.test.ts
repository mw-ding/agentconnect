import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { GithubCardStore } from '../../src/kanban/card-store.js'
import { KanbanImporter } from '../../src/kanban/importer.js'
import { KanbanGraphDoorbell } from '../../src/kanban/graph-doorbell.js'
import { GithubRepoPermission, hasWriteAccess } from '../../src/github/repo-permission.js'
import { PgKanbanBoardRepo, PgKanbanCardRepo } from '../../src/persistence/index.js'
import { prisma } from '../setup.db.js'
import {
  enabled,
  FULL,
  REPO_ID,
  installation,
  tokens,
  repoRef,
  gh,
  ensureLabels,
  createIssue,
  closeIssues,
  record
} from '../fixtures/kanban-live.js'

// PAT stands in for installation minting; all issue, label, and permission calls use the live GitHub API.
describe.skipIf(!enabled)('Kanban import E2E (live GitHub)', () => {
  const issues: number[] = []
  const boards: string[] = []
  beforeAll(ensureLabels, 120_000)
  afterAll(async () => {
    await closeIssues(issues)
    await prisma.kanbanBoard.deleteMany({ where: { id: { in: boards } } })
  }, 120_000)

  it.each(['admin', 'read'] as const)(
    'imports a labeled issue with %s author permission, idempotently',
    async (level) => {
      const started = Date.now()
      const issue = await createIssue(issues, `import ${level}`, ['ac/status:ready'])
      const board = await prisma.kanbanBoard.create({
        data: { orgId: DEFAULT_ORG_ID, name: 'import E2E', repoId: REPO_ID, repoFullName: FULL }
      })
      boards.push(board.id)
      const cards = new PgKanbanCardRepo(prisma)
      const store = new GithubCardStore({ tokens })
      const live = new GithubRepoPermission({ tokens, ttlMs: 0 })
      expect(await live.permission(repoRef, 'mw-ding')).toBe('admin')
      if (level === 'read') expect(hasWriteAccess(await live.permission(repoRef, 'octocat'))).toBe(false)
      const permission = vi.fn((r: typeof repoRef, login: string) =>
        level === 'read' ? Promise.resolve('read' as const) : live.permission(r, login)
      )
      const importer = new KanbanImporter({ cards, store, permissions: { permission } })
      const bell = new KanbanGraphDoorbell({
        boards: new PgKanbanBoardRepo(prisma),
        installations: { getByInstallationId: async () => installation },
        store,
        onCard: (b, r, n) => importer.import(b, r, n).then(() => {}),
        log: { debug: vi.fn(), warn: vi.fn() }
      })
      const frame = {
        deliveryKey: `import-${issue.number}`,
        event: 'issues' as const,
        action: 'opened',
        installationId: '1',
        repoId: REPO_ID.toString(),
        ids: [String(issue.id)],
        numbers: [issue.number]
      }
      bell.poke(frame)
      await bell.settle()
      bell.poke(frame)
      await bell.settle()
      expect(bell.landedDeliveryKeys([frame.deliveryKey]).size).toBe(1)
      const card = await cards.getCard((await prisma.kanbanCard.findFirstOrThrow({ where: { boardId: board.id } })).id)
      expect(card?.status).toBe(level === 'admin' ? 'ready' : 'triage')
      expect(await prisma.kanbanCard.count({ where: { boardId: board.id } })).toBe(1)
      expect(permission).toHaveBeenCalledWith(repoRef, 'mw-ding')
      const current = await gh<{ labels: { name: string }[] }>('GET', `/repos/${FULL}/issues/${issue.number}`)
      expect(current.labels.map((l) => l.name)).toContain(`ac/status:${card?.status}`)
      record(`import ${level}: doorbell, live author check, idempotent upsert`, [issue.number], started)
    },
    120_000
  )
})
