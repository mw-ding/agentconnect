import { acknowledgeKanbanProjection } from '../fixtures/kanban-projection.js'
// PgKanbanCardRepo.upsertCard authority (PR #136 review): no mode input, ready only from a live human writer, repo fence.
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { attestHumanAuthority } from '../../src/kanban/human-authority.js'
import { cardIdempotencyKey } from '../../src/kanban/card-key.js'
import { PgKanbanBoardRepo, PgKanbanCardRepo } from '../../src/persistence/repositories/kanban.repo.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import type { KanbanCardUpsertInput } from '../../src/persistence/ports.js'
import type { RepoPermissionLevel } from '../../src/github/repo-permission.js'

const D1 = 'd1111111-1111-4111-8111-111111111111'
const A1 = 'a1111111-1111-4111-8111-111111111111'
const ORCH = 'a2222222-2222-4222-8222-222222222222'
const RESTRICTED = 'a3333333-3333-4333-8333-333333333333'
const PAUSED = 'a4444444-4444-4444-8444-444444444444'
const NOW = new Date('2026-10-17T12:00:00.000Z')

const cards = new PgKanbanCardRepo(prisma)
const boards = new PgKanbanBoardRepo(prisma)
const dispatch = new PgKanbanDispatchRepo(prisma)

async function seedBoard(): Promise<string> {
  await seedDaemon(prisma, D1, { sessionEpoch: 7n })
  await seedAgent(prisma, A1, { daemonId: D1, name: 'worker-one' })
  await seedAgent(prisma, ORCH, { daemonId: D1, name: 'orchestrator' })
  const board = await prisma.kanbanBoard.create({
    data: { orgId: DEFAULT_ORG_ID, name: 'eng', repoId: 4242n, repoFullName: 'acme/web' }
  })
  expect(board.defaultMode).toBe('read')
  return board.id
}

function input(boardId: string, n: number, extra: Partial<KanbanCardUpsertInput> = {}): KanbanCardUpsertInput {
  return { boardId, expectedRepoId: 4242n, issueId: BigInt(700_000 + n), issueNumber: n, source: 'import', ...extra }
}

const writer = (permission: RepoPermissionLevel = 'write') => ({
  humanAuthority: attestHumanAuthority('maintainer', permission)
})
const cardAudit = () => prisma.auditEvent.findMany({ where: { kind: 'kanban_card_change' }, orderBy: { id: 'asc' } })

describe('upsertCard: mode and ready are never an agent’s to set', () => {
  it('refuses an orchestrator’s ready + write upsert on a read-default board (Vera’s repro)', async () => {
    const boardId = await seedBoard()
    const attempt = { status: 'ready', mode: 'write', assigneeAgentId: A1, source: 'orchestrator', actorAgentId: ORCH }
    await expect(cards.upsertCard(input(boardId, 1, attempt as Partial<KanbanCardUpsertInput>))).rejects.toMatchObject({
      code: 'status_not_allowed'
    })
    expect(await prisma.kanbanCard.count()).toBe(0)
    expect(await cardAudit()).toHaveLength(0)
    expect((await dispatch.claim(boardId, { now: NOW, isDaemonLive: () => true })).leases).toEqual([])
  })

  it('files a todo card with a smuggled write mode as inherit, so its later claim is a read lease', async () => {
    const boardId = await seedBoard()
    const attempt = { status: 'todo', mode: 'write', assigneeAgentId: A1, source: 'orchestrator', actorAgentId: ORCH }
    const { card, created } = await cards.upsertCard(input(boardId, 2, attempt as Partial<KanbanCardUpsertInput>))
    expect(created).toBe(true)
    expect(card).toMatchObject({ status: 'todo', mode: null })
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).toMatchObject({
      mode: null,
      modeRevision: 0
    })
    // A human promotion (1b's casStatus) makes it claimable; the claim takes the board's read default.
    expect(await cards.casStatus(card.id, card.stateRevision, 'ready')).toBe(true)
    await acknowledgeKanbanProjection(card.id)
    const [lease] = (await dispatch.claim(boardId, { now: NOW, isDaemonLive: () => true })).leases
    expect(lease).toMatchObject({ cardId: card.id, mode: 'read' })
    expect(await prisma.auditEvent.count({ where: { kind: 'kanban_mode_change' } })).toBe(0)
  })

  it('admits ready from an import carrying a write-level human authority and audits who', async () => {
    const boardId = await seedBoard()
    const { card } = await cards.upsertCard(input(boardId, 3, { status: 'ready', ...writer('maintain') }))
    expect(card.status).toBe('ready')
    const [audit] = await cardAudit()
    expect(audit!.details).toMatchObject({
      change: 'created',
      to: 'ready',
      source: 'import',
      humanAuthority: { login: 'maintainer', permission: 'maintain' }
    })
  })

  it.each(['literal', 'spread', 'JSON'] as const)('rejects %s authority with no row, audit, or claim', async (kind) => {
    const boardId = await seedBoard()
    const real = attestHumanAuthority('maintainer', 'admin')
    const forged =
      kind === 'literal'
        ? { login: 'nobody', permission: 'admin' }
        : kind === 'spread'
          ? { ...real }
          : JSON.parse(JSON.stringify(real))
    await expect(
      cards.upsertCard(
        input(boardId, 20, {
          status: 'ready',
          assigneeAgentId: A1,
          humanAuthority: forged as KanbanCardUpsertInput['humanAuthority']
        })
      )
    ).rejects.toMatchObject({ code: 'status_not_allowed' })
    expect(await prisma.kanbanCard.count()).toBe(0)
    expect(await cardAudit()).toHaveLength(0)
    expect((await dispatch.claim(boardId, { now: NOW, isDaemonLive: () => true })).leases).toEqual([])
  })

  it.each(['triage', 'read', 'none'] as const)('refuses ready with a %s-level human authority', async (level) => {
    const boardId = await seedBoard()
    await expect(cards.upsertCard(input(boardId, 4, { status: 'ready', ...writer(level) }))).rejects.toMatchObject({
      code: 'status_not_allowed'
    })
    expect(await prisma.kanbanCard.count()).toBe(0)
  })

  it.each([
    ['an agent actor', { actorAgentId: ORCH }],
    ['a non-import source', { source: 'orchestrator' }],
    ['an empty login', { humanAuthority: attestHumanAuthority('', 'admin') }]
  ])('refuses ready with a writer authority but %s', async (_name, extra) => {
    const boardId = await seedBoard()
    await expect(
      cards.upsertCard(input(boardId, 5, { status: 'ready', ...writer('admin'), ...extra }))
    ).rejects.toMatchObject({ code: 'status_not_allowed' })
    expect(await prisma.kanbanCard.count()).toBe(0)
  })

  it.each(['blocked', 'review', 'done', 'archived'] as const)(
    'refuses %s without a human authority',
    async (status) => {
      const boardId = await seedBoard()
      await expect(cards.upsertCard(input(boardId, 6, { status }))).rejects.toMatchObject({
        code: 'status_not_allowed'
      })
    }
  )

  it('leaves setCardMode as the only mode path: revisioned and audited', async () => {
    const boardId = await seedBoard()
    const { card } = await cards.upsertCard(input(boardId, 7, { status: 'todo' }))
    expect(await boards.setCardMode(DEFAULT_ORG_ID, boardId, card.id, DEFAULT_OWNER_ID, 'write')).toBe(true)
    // A redelivery with a smuggled mode neither changes nor resets the override.
    const again = await cards.upsertCard(input(boardId, 7, { mode: 'read' } as Partial<KanbanCardUpsertInput>))
    expect(again).toMatchObject({ created: false, card: { mode: 'write' } })
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).toMatchObject({
      mode: 'write',
      modeRevision: 1
    })
    expect(await prisma.auditEvent.findMany({ where: { kind: 'kanban_mode_change' } })).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({ cardId: card.id, oldMode: null, newMode: 'write' })
      })
    ])
  })
})

describe('upsertCard: repository and issue fences', () => {
  it('refuses an import read from the old repository after the board was retargeted', async () => {
    const boardId = await seedBoard()
    const moved = await boards.updateBoard(DEFAULT_ORG_ID, boardId, DEFAULT_OWNER_ID, {
      repoId: 5555n,
      repoFullName: 'acme/api'
    })
    expect(moved).toMatchObject({ ok: true })
    await expect(cards.upsertCard(input(boardId, 8))).rejects.toMatchObject({ code: 'repo_mismatch' })
    expect(await prisma.kanbanCard.count()).toBe(0)
    expect(await cardAudit()).toHaveLength(0)
    await expect(cards.upsertCard(input(boardId, 8, { expectedRepoId: 5555n }))).resolves.toMatchObject({
      created: true
    })
  })

  it('never hands back an existing card to a caller fenced on another repository', async () => {
    const boardId = await seedBoard()
    await cards.upsertCard(input(boardId, 9))
    await expect(cards.upsertCard(input(boardId, 9, { expectedRepoId: 1n }))).rejects.toMatchObject({
      code: 'repo_mismatch'
    })
  })

  it('refuses a number that now names a different issue', async () => {
    const boardId = await seedBoard()
    await cards.upsertCard(input(boardId, 10))
    await expect(cards.upsertCard(input(boardId, 10, { issueId: 123n }))).rejects.toMatchObject({
      code: 'issue_mismatch'
    })
    expect(await prisma.kanbanCard.count()).toBe(1)
  })
})

describe('upsertCard: key adoption', () => {
  it('attaches a key inside an ambient transaction, keeps it usable, and audits the attach', async () => {
    const boardId = await seedBoard()
    const imported = await cards.upsertCard(input(boardId, 11))
    const key = cardIdempotencyKey({ epic: '1', step: 'adopt', spec: 'p' })
    const result = await prisma.$transaction(async (tx) => {
      const adopted = await new PgKanbanCardRepo(tx).upsertCard(
        input(boardId, 11, { idempotencyKey: key, source: 'orchestrator', actorAgentId: ORCH })
      )
      await tx.kanbanCard.count()
      return adopted
    })
    expect(result).toMatchObject({
      created: false,
      matchedBy: 'issue',
      card: { id: imported.card.id, idempotencyKey: key }
    })
    const audit = await cardAudit()
    expect(audit.map((a) => (a.details as { change: string }).change)).toEqual(['created', 'key_attached'])
    expect(audit[1]).toMatchObject({
      agentId: ORCH,
      details: { cardId: imported.card.id, issueNumber: 11, change: 'key_attached', source: 'orchestrator' }
    })
  })

  it('survives losing a key race inside an ambient transaction and returns the winner', async () => {
    const boardId = await seedBoard()
    const imported = await cards.upsertCard(input(boardId, 12))
    const key = cardIdempotencyKey({ epic: '1', step: 'race', spec: 'p' })
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let inserted!: () => void
    const ready = new Promise<void>((resolve) => (inserted = resolve))
    // A concurrent filer holds the key on another issue, uncommitted, while the adoption runs.
    const winner = prisma.$transaction(
      async (tx) => {
        const row = await tx.kanbanCard.create({
          data: { boardId, issueId: 700_013n, issueNumber: 13, idempotencyKey: key }
        })
        inserted()
        await held
        return row
      },
      { timeout: 20_000 }
    )
    await ready
    const loser = prisma.$transaction(
      async (tx) => {
        const r = await new PgKanbanCardRepo(tx).upsertCard(
          input(boardId, 12, { idempotencyKey: key, source: 'orchestrator' })
        )
        // Still usable: the unique violation, if any, was rolled back to the savepoint.
        await tx.kanbanCard.count()
        return r
      },
      { timeout: 20_000 }
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    release()
    const won = await winner
    const lost = await loser
    expect(lost).toMatchObject({ created: false, matchedBy: 'idempotency_key', card: { id: won.id } })
    expect((await cards.getCard(imported.card.id))?.idempotencyKey).toBeNull()
  })
})

describe('assignee policy: restricted agents are never assignable', () => {
  it('resolves neither a restricted slug nor accepts one on upsert or setAssignee; paused still resolves', async () => {
    const boardId = await seedBoard()
    await seedAgent(prisma, RESTRICTED, {
      daemonId: D1,
      name: 'private-one',
      visibility: 'restricted',
      sharedWith: [DEFAULT_OWNER_ID]
    })
    await seedAgent(prisma, PAUSED, { daemonId: D1, name: 'paused-one' })
    await prisma.agent.update({ where: { id: PAUSED }, data: { status: 'paused' } })
    expect(await cards.resolveAgentSlug(DEFAULT_ORG_ID, 'private-one')).toBeNull()
    expect(await cards.resolveAgentSlug(DEFAULT_ORG_ID, 'paused-one')).toBe(PAUSED)
    await expect(cards.upsertCard(input(boardId, 14, { assigneeAgentId: RESTRICTED }))).rejects.toMatchObject({
      code: 'agent_not_assignable'
    })
    const { card } = await cards.upsertCard(input(boardId, 14))
    await expect(
      cards.setAssignee({ cardId: card.id, agentId: RESTRICTED, now: NOW, source: 'test' })
    ).resolves.toEqual({ ok: false, reason: 'agent_not_assignable' })
    await expect(
      cards.setAssignee({ cardId: card.id, agentId: PAUSED, now: NOW, source: 'test' })
    ).resolves.toMatchObject({
      ok: true,
      changed: true
    })
  })
})
