// Control and synthesis status moves commit body-free notification rows with their state and fence changes.
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { PgKanbanCardRepo } from '../../src/persistence/repositories/kanban.repo.js'

const AGENT = 'a1111111-1111-4111-8111-111111111111'
const DAEMON = 'd1111111-1111-4111-8111-111111111111'

async function harness(headless = false) {
  await seedDaemon(prisma, DAEMON)
  await seedAgent(prisma, AGENT, { daemonId: DAEMON })
  const board = await prisma.kanbanBoard.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      name: 'outbox',
      repoId: 42n,
      repoFullName: 'acme/web',
      targetPlatform: 'slack',
      targetChannel: headless ? null : 'FAKE-ONLY',
      synthesizerAgentId: AGENT
    }
  })
  const card = await prisma.kanbanCard.create({
    data: {
      boardId: board.id,
      issueId: 1n,
      issueNumber: 1,
      status: 'running',
      assigneeAgentId: AGENT,
      dispatchRevision: 1n
    }
  })
  const run = await prisma.kanbanRun.create({
    data: {
      cardId: card.id,
      attempt: 1,
      agentId: AGENT,
      daemonId: DAEMON,
      leaseId: 'e1111111-1111-4111-8111-111111111111',
      dispatchRevision: 1n,
      dispatchedAt: new Date(),
      mode: 'read'
    }
  })
  const input = {
    orgId: DEFAULT_ORG_ID,
    boardId: board.id,
    cardId: card.id,
    actorUserId: DEFAULT_OWNER_ID,
    source: 'owner' as const
  }
  const outbox = () =>
    prisma.$queryRaw<
      Array<{
        cardId: string
        stateRevision: bigint
        fromStatus: string
        toStatus: string
        reasonCode: string
        mention: boolean
      }>
    >`SELECT "cardId", "stateRevision", "fromStatus", "toStatus", "reasonCode", "mention" FROM "kanban_notification" WHERE "cardId" = ${card.id}::uuid`
  return { card, run, input, outbox, repo: new PgKanbanCardRepo(prisma) }
}

describe('control notification atomicity (real Postgres)', () => {
  it.each(['skip', 'restart'] as const)(
    'enqueues %s in the same transaction as the state and lease revocation',
    async (operation) => {
      const h = await harness()
      const result = operation === 'skip' ? await h.repo.skipCard(h.input) : await h.repo.restartCard(h.input)
      expect(result.ok).toBe(true)
      expect(await h.outbox()).toEqual([
        {
          cardId: h.card.id,
          stateRevision: 2n,
          fromStatus: 'running',
          toStatus: operation === 'skip' ? 'archived' : 'ready',
          reasonCode: operation === 'skip' ? 'skipped' : 'restarted',
          mention: false
        }
      ])
      expect(await prisma.kanbanRun.findUniqueOrThrow({ where: { id: h.run.id } })).toMatchObject({
        outcome: 'reclaimed',
        endedAt: expect.any(Date)
      })
      expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: h.card.id } })).dispatchRevision).toBe(2n)
    }
  )

  it.each(['skip', 'restart'] as const)('rolls back %s state, fence, audit and outbox together', async (operation) => {
    const h = await harness()
    await expect(
      prisma.$transaction(async (tx) => {
        const repo = new PgKanbanCardRepo(tx)
        const result = operation === 'skip' ? await repo.skipCard(h.input) : await repo.restartCard(h.input)
        expect(result.ok).toBe(true)
        expect(
          await tx.$queryRaw`SELECT 1 FROM "kanban_notification" WHERE "cardId" = ${h.card.id}::uuid`
        ).toHaveLength(1)
        throw new Error('rollback probe')
      })
    ).rejects.toThrow('rollback probe')
    expect(await h.outbox()).toEqual([])
    expect(await prisma.auditEvent.count()).toBe(0)
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: h.card.id } })).toMatchObject({
      status: 'running',
      stateRevision: 1n,
      dispatchRevision: 1n
    })
    expect((await prisma.kanbanRun.findUniqueOrThrow({ where: { id: h.run.id } })).endedAt).toBeNull()
  })

  it('keeps headless controls silent', async () => {
    const h = await harness(true)
    expect((await h.repo.skipCard(h.input)).ok).toBe(true)
    expect(await h.outbox()).toEqual([])
  })

  it('enqueues synthesis exactly once at its CAS revision', async () => {
    const h = await harness()
    await prisma.kanbanRun.delete({ where: { id: h.run.id } })
    await prisma.kanbanCard.update({ where: { id: h.card.id }, data: { status: 'todo' } })
    expect(await h.repo.beginSynthesis(h.card.id, 1n, 41n, new Date(), AGENT)).toBe(true)
    expect(await h.repo.beginSynthesis(h.card.id, 1n, 41n, new Date(), AGENT)).toBe(false)
    expect(await h.outbox()).toEqual([
      {
        cardId: h.card.id,
        stateRevision: 2n,
        fromStatus: 'todo',
        toStatus: 'ready',
        reasonCode: 'synthesis',
        mention: false
      }
    ])
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: h.card.id } })).toMatchObject({
      status: 'ready',
      assigneeAgentId: AGENT,
      promotionPending: true
    })
  })

  it('rolls back synthesis and its notification together', async () => {
    const h = await harness()
    await prisma.kanbanRun.delete({ where: { id: h.run.id } })
    await prisma.kanbanCard.update({ where: { id: h.card.id }, data: { status: 'todo', assigneeAgentId: null } })
    await expect(
      prisma.$transaction(async (tx) => {
        expect(await new PgKanbanCardRepo(tx).beginSynthesis(h.card.id, 1n, 41n, new Date(), AGENT)).toBe(true)
        expect(
          await tx.$queryRaw`SELECT 1 FROM "kanban_notification" WHERE "cardId" = ${h.card.id}::uuid`
        ).toHaveLength(1)
        throw new Error('rollback probe')
      })
    ).rejects.toThrow('rollback probe')
    expect(await h.outbox()).toEqual([])
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: h.card.id } })).toMatchObject({
      status: 'todo',
      assigneeAgentId: null,
      stateRevision: 1n,
      promotionPending: false
    })
  })
})
