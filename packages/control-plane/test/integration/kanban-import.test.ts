import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { KanbanImporter } from '../../src/kanban/importer.js'
import { KanbanGraphDoorbell } from '../../src/kanban/graph-doorbell.js'
import { PgKanbanBoardRepo, PgKanbanCardRepo } from '../../src/persistence/index.js'
import type { GithubInstallationRecord } from '../../src/persistence/ports.js'
import type { CardIssue, LabelEvent } from '../../src/kanban/card-store.js'
import type { RepoPermissionLevel } from '../../src/github/repo-permission.js'
import { OrgId } from '../../src/domain/ids.js'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'

const installation = {
  installationId: 7n,
  orgId: OrgId(DEFAULT_ORG_ID),
  revokedAt: null,
  suspendedAt: null
} as GithubInstallationRecord
const repo = { installationId: 7n, repoId: 42n, repoFullName: 'acme/web' }
const labeled = (id: number, label: string, login: string): LabelEvent => ({
  id,
  event: 'labeled',
  label: { name: label },
  actor: { type: 'User', login }
})

describe('issue import doorbells (Postgres)', () => {
  it.each(['opened', 'transferred', 'labeled'])(
    'imports %s idempotently through the body-free doorbell',
    async (action) => {
      const board = await prisma.kanbanBoard.create({
        data: { orgId: DEFAULT_ORG_ID, name: 'board', repoId: 42n, repoFullName: 'acme/web' }
      })
      await seedDaemon(prisma, 'd6666666-6666-4666-8666-666666666666')
      const agent = await seedAgent(prisma, 'a6666666-6666-4666-8666-666666666666', {
        daemonId: 'd6666666-6666-4666-8666-666666666666'
      })
      await prisma.agent.update({ where: { id: agent }, data: { name: 'worker' } })
      const issue: CardIssue = {
        issueId: 100n,
        nodeId: 'I_100',
        number: 1,
        state: 'open',
        labels: ['ac/status:ready', 'ac/agent:worker'],
        authorLogin: 'alice'
      }
      const cards = new PgKanbanCardRepo(prisma)
      const events = [labeled(1, 'ac/status:ready', 'alice'), labeled(2, 'ac/agent:worker', 'alice')]
      const store = {
        readCard: async () => issue,
        applyPlan: vi.fn(),
        readGraph: vi.fn(),
        readLabelEvents: async () => events
      }
      const permissions = { permission: vi.fn(async () => 'admin' as const) }
      const importer = new KanbanImporter({ cards, store, permissions })
      const bell = new KanbanGraphDoorbell({
        boards: new PgKanbanBoardRepo(prisma),
        installations: { getByInstallationId: async () => installation },
        store,
        onCard: (b, r, n) => importer.import(b, r, n).then(() => {}),
        log: { debug: vi.fn(), warn: vi.fn() }
      })
      const frame = {
        deliveryKey: 'import',
        installationId: '7',
        repoId: '42',
        event: 'issues' as const,
        action,
        ids: ['100'],
        numbers: [1]
      }
      bell.poke(frame)
      await bell.settle()
      bell.poke(frame)
      await bell.settle()
      expect(await prisma.kanbanCard.findMany({ where: { boardId: board.id } })).toEqual([
        expect.objectContaining({ status: 'ready', assigneeAgentId: agent })
      ])
      expect(await prisma.auditEvent.count({ where: { kind: 'kanban_card_change' } })).toBe(1)
      expect(permissions.permission).toHaveBeenCalledTimes(1)
    }
  )

  it('never creates a dispatchable card when the author is read-only or its triage label write fails', async () => {
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'board', repoId: 42n, repoFullName: 'acme/web' }
    })
    const issue: CardIssue = {
      issueId: 100n,
      nodeId: 'I_100',
      number: 1,
      state: 'open',
      labels: ['ac/status:ready'],
      authorLogin: 'outsider'
    }
    const applyPlan = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const importer = new KanbanImporter({
      cards: new PgKanbanCardRepo(prisma),
      store: {
        readCard: async () => issue,
        applyPlan,
        readLabelEvents: async () => [labeled(1, 'ac/status:ready', 'alice')]
      },
      permissions: { permission: async () => 'read' }
    })
    await expect(importer.import({ ...board, orgId: OrgId(board.orgId) }, repo, 1)).rejects.toThrow('offline')
    expect(await prisma.kanbanCard.count()).toBe(0)
    await importer.import({ ...board, orgId: OrgId(board.orgId) }, repo, 1)
    expect((await prisma.kanbanCard.findFirstOrThrow()).status).toBe('triage')
    expect(applyPlan).toHaveBeenLastCalledWith(
      repo,
      1,
      issue,
      expect.objectContaining({ status: 'triage', addLabels: ['ac/status:triage'], removeLabels: ['ac/status:ready'] })
    )
  })

  it("imports a triage-role collaborator's ready label on a writer's issue as unassigned triage", async () => {
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'board', repoId: 42n, repoFullName: 'acme/web' }
    })
    await seedDaemon(prisma, 'd6666666-6666-4666-8666-666666666666')
    const agent = await seedAgent(prisma, 'a6666666-6666-4666-8666-666666666666', {
      daemonId: 'd6666666-6666-4666-8666-666666666666'
    })
    await prisma.agent.update({ where: { id: agent }, data: { name: 'worker' } })
    const issue: CardIssue = {
      issueId: 100n,
      nodeId: 'I_100',
      number: 1,
      state: 'open',
      labels: ['ac/status:ready', 'ac/agent:worker'],
      authorLogin: 'alice'
    }
    const applyPlan = vi.fn()
    const permission = vi.fn(async (_r: unknown, login: string): Promise<RepoPermissionLevel> =>
      login === 'alice' ? 'write' : 'triage'
    )
    const importer = new KanbanImporter({
      cards: new PgKanbanCardRepo(prisma),
      store: {
        readCard: async () => issue,
        applyPlan,
        readLabelEvents: async () => [labeled(1, 'ac/status:ready', 'tim'), labeled(2, 'ac/agent:worker', 'tim')]
      },
      permissions: { permission }
    })
    expect(await importer.import({ ...board, orgId: OrgId(board.orgId) }, repo, 1)).toBe(true)
    expect(await prisma.kanbanCard.findMany({ where: { boardId: board.id } })).toEqual([
      expect.objectContaining({ status: 'triage', assigneeAgentId: null, mode: null })
    ])
    expect(permission.mock.calls.map((c) => c[1])).toEqual(['alice', 'tim'])
    expect(applyPlan).toHaveBeenCalledWith(repo, 1, issue, expect.objectContaining({ status: 'triage' }))
    const [audit] = await prisma.auditEvent.findMany({ where: { kind: 'kanban_card_change' } })
    expect(audit!.details).toMatchObject({ to: 'triage', humanAuthority: null })
  })
})
