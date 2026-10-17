import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { KanbanImporter, KanbanImportInconclusiveError } from '../../src/kanban/importer.js'
import { KanbanGraphDoorbell } from '../../src/kanban/graph-doorbell.js'
import { PgKanbanBoardRepo, PgKanbanCardRepo } from '../../src/persistence/index.js'
import type { GithubInstallationRecord } from '../../src/persistence/ports.js'
import type { CardIssue, LabelEvent } from '../../src/kanban/card-store.js'
import type { LabelPlan } from '../../src/kanban/card-state.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
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

const unlabeled = (id: number, label: string, login: string): LabelEvent => ({
  ...labeled(id, label, login),
  event: 'unlabeled'
})

describe('issue import doorbells (Postgres)', () => {
  it.each([
    { name: 'opened', action: 'opened', extra: {} },
    { name: 'transferred', action: 'transferred', extra: {} },
    {
      name: 'labeled',
      action: 'labeled',
      extra: { sender: { login: 'alice', id: '1', type: 'User' }, label: 'ac/status:ready' }
    }
  ])('imports $name idempotently through the body-free doorbell', async ({ action, extra }) => {
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
      authorLogin: 'alice',
      authorType: 'User',
      authorViaGithubApp: false
    }
    const cards = new PgKanbanCardRepo(prisma)
    // No `transferred` event is visible, so a `transferred` doorbell must fail closed to triage (Blocker 2).
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
      onCard: (b, r, n, doorbell) => importer.import(b, r, n, doorbell).then(() => {}),
      log: { debug: vi.fn(), warn: vi.fn() }
    })
    const frame = {
      deliveryKey: 'import',
      installationId: '7',
      repoId: '42',
      event: 'issues' as const,
      action,
      ids: ['100'],
      numbers: [1],
      ...extra
    }
    bell.poke(frame)
    await bell.settle()
    bell.poke(frame)
    await bell.settle()
    expect(await prisma.kanbanCard.findMany({ where: { boardId: board.id } })).toEqual([
      expect.objectContaining(
        action === 'transferred'
          ? { status: 'triage', assigneeAgentId: null }
          : { status: 'ready', assigneeAgentId: agent }
      )
    ])
    expect(await prisma.auditEvent.count({ where: { kind: 'kanban_card_change' } })).toBe(1)
    expect(permissions.permission).toHaveBeenCalledTimes(1)
  })

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
      authorLogin: 'outsider',
      authorType: 'User',
      authorViaGithubApp: false
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
      authorLogin: 'alice',
      authorType: 'User',
      authorViaGithubApp: false
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

  // Vera round 2: the latest visible event for each current label decides; lag and newer removals fail closed.
  it.each([
    {
      name: 'a lagging re-add after a writer removed ready',
      events: [
        labeled(1, 'ac/status:ready', 'bob'),
        labeled(2, 'ac/agent:worker', 'bob'),
        unlabeled(3, 'ac/status:ready', 'bob')
      ],
      status: 'triage',
      assigned: false,
      authority: null
    },
    {
      name: 'a removal followed by a non-writer re-add',
      events: [
        labeled(1, 'ac/status:ready', 'bob'),
        unlabeled(2, 'ac/status:ready', 'bob'),
        labeled(3, 'ac/status:ready', 'tim'),
        labeled(4, 'ac/agent:worker', 'bob')
      ],
      status: 'triage',
      assigned: false,
      authority: null
    },
    {
      name: 'a lagging ac/agent re-add',
      events: [
        labeled(1, 'ac/status:ready', 'bob'),
        labeled(2, 'ac/agent:worker', 'bob'),
        unlabeled(3, 'AC/Agent:worker', 'bob')
      ],
      status: 'ready',
      assigned: false,
      authority: { login: 'bob', permission: 'write' }
    },
    {
      name: 'a removal followed by a writer re-add',
      events: [
        labeled(1, 'ac/status:ready', 'tim'),
        unlabeled(2, 'ac/status:ready', 'tim'),
        labeled(3, 'ac/status:ready', 'bob'),
        labeled(4, 'ac/agent:worker', 'bob')
      ],
      status: 'ready',
      assigned: true,
      authority: { login: 'bob', permission: 'write' }
    }
  ])('attributes $name against the latest visible event', async ({ events, status, assigned, authority }) => {
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'board', repoId: 42n, repoFullName: 'acme/web' }
    })
    await seedDaemon(prisma, 'd7777777-7777-4777-8777-777777777777')
    const agent = await seedAgent(prisma, 'a7777777-7777-4777-8777-777777777777', {
      daemonId: 'd7777777-7777-4777-8777-777777777777'
    })
    await prisma.agent.update({ where: { id: agent }, data: { name: 'worker' } })
    const issue: CardIssue = {
      issueId: 100n,
      nodeId: 'I_100',
      number: 1,
      state: 'open',
      labels: ['ac/status:ready', 'ac/agent:worker'],
      authorLogin: 'alice',
      authorType: 'User',
      authorViaGithubApp: false
    }
    const importer = new KanbanImporter({
      cards: new PgKanbanCardRepo(prisma),
      store: { readCard: async () => issue, applyPlan: vi.fn(), readLabelEvents: async () => events },
      permissions: {
        permission: async (_r: unknown, login: string): Promise<RepoPermissionLevel> =>
          login === 'tim' ? 'triage' : 'write'
      }
    })
    expect(await importer.import({ ...board, orgId: OrgId(board.orgId) }, repo, 1, { action: 'labeled' })).toBe(true)
    expect(await prisma.kanbanCard.findMany({ where: { boardId: board.id } })).toEqual([
      expect.objectContaining({ status, assigneeAgentId: assigned ? agent : null, mode: null })
    ])
    const [audit] = await prisma.auditEvent.findMany({ where: { kind: 'kanban_card_change' } })
    expect(audit!.details).toMatchObject({ to: status, humanAuthority: authority })
  })
  // A writer's visible adds, then a removal AND re-add the events API does not show yet: only the doorbell's sender says
  // who re-added the label, so the writer's older visible add must not import it as ready with the agent pick.
  describe('an invisible remove+re-add named by the labeled doorbell', () => {
    async function importFixture() {
      const board = await prisma.kanbanBoard.create({
        data: { orgId: DEFAULT_ORG_ID, name: 'board', repoId: 42n, repoFullName: 'acme/web' }
      })
      await seedDaemon(prisma, 'd8888888-8888-4888-8888-888888888888')
      const agent = await seedAgent(prisma, 'a8888888-8888-4888-8888-888888888888', {
        daemonId: 'd8888888-8888-4888-8888-888888888888'
      })
      await prisma.agent.update({ where: { id: agent }, data: { name: 'worker' } })
      const issue: CardIssue = {
        issueId: 100n,
        nodeId: 'I_100',
        number: 1,
        state: 'open',
        labels: ['ac/status:ready', 'ac/agent:worker'],
        authorLogin: 'alice',
        authorType: 'User',
        authorViaGithubApp: false
      }
      const events: LabelEvent[] = [labeled(1, 'ac/status:ready', 'alice'), labeled(2, 'ac/agent:worker', 'alice')]
      const writes: LabelPlan[] = []
      const importer = new KanbanImporter({
        cards: new PgKanbanCardRepo(prisma),
        store: {
          readCard: async () => issue,
          applyPlan: async (_r, _n, _o, plan) => {
            writes.push(plan)
          },
          readLabelEvents: async () => [...events]
        },
        permissions: {
          permission: async (_r: unknown, login: string): Promise<RepoPermissionLevel> =>
            ['alice', 'carol'].includes(login) ? 'write' : 'triage'
        }
      })
      return { board: { ...board, orgId: OrgId(board.orgId) }, agent, events, writes, importer }
    }
    const doorbell = (login: string, id: string) => ({
      action: 'labeled',
      sender: { login, id: Number(id), type: 'User' },
      label: 'ac/status:ready'
    })

    it("imports a non-writer sender's invisible re-add as unassigned triage, nothing to claim", async () => {
      const f = await importFixture()
      expect(await f.importer.import(f.board, repo, 1, doorbell('mallory', '7'))).toBe(true)
      expect(await prisma.kanbanCard.findMany({ where: { boardId: f.board.id } })).toEqual([
        expect.objectContaining({ status: 'triage', assigneeAgentId: null })
      ])
      expect(f.writes).toEqual([
        expect.objectContaining({
          status: 'triage',
          addLabels: ['ac/status:triage'],
          removeLabels: ['ac/status:ready']
        })
      ])
      const [audit] = await prisma.auditEvent.findMany({ where: { kind: 'kanban_card_change' } })
      expect(audit!.details).toMatchObject({ to: 'triage', humanAuthority: null })
      expect(
        await new PgKanbanDispatchRepo(prisma).claim(f.board.id, { now: new Date(), isDaemonLive: () => true })
      ).toHaveLength(0)
    })

    it("leaves a writer sender's invisible re-add un-imported until it is visible", async () => {
      const f = await importFixture()
      await expect(f.importer.import(f.board, repo, 1, doorbell('carol', '3'))).rejects.toBeInstanceOf(
        KanbanImportInconclusiveError
      )
      expect(await prisma.kanbanCard.count()).toBe(0)
      expect(f.writes).toHaveLength(0)
      f.events.push(unlabeled(3, 'ac/status:ready', 'carol'), {
        ...labeled(4, 'ac/status:ready', 'carol'),
        actor: { type: 'User', login: 'carol', id: 3 }
      })
      expect(await f.importer.import(f.board, repo, 1, doorbell('carol', '3'))).toBe(true)
      expect(await prisma.kanbanCard.findMany({ where: { boardId: f.board.id } })).toEqual([
        expect.objectContaining({ status: 'ready', assigneeAgentId: f.agent })
      ])
    })
  })
})
