import { describe, expect, it } from 'vitest'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { PgKanbanSyncRepo } from '../../src/persistence/repositories/kanban-sync.repo.js'
import { PgKanbanCardRepo } from '../../src/persistence/repositories/kanban.repo.js'
import { planLabelReconcile } from '../../src/kanban/card-state.js'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'

const DAEMON = 'd6666666-6666-4666-8666-666666666666'
const AGENT = 'a6666666-6666-4666-8666-666666666666'
const NEXT = 'a7777777-7777-4777-8777-777777777777'

async function fixture(leased = false) {
  await seedDaemon(prisma, DAEMON)
  await seedAgent(prisma, AGENT, { daemonId: DAEMON })
  await seedAgent(prisma, NEXT, { daemonId: DAEMON })
  const board = await prisma.kanbanBoard.create({
    data: { orgId: DEFAULT_ORG_ID, name: 'sync', repoId: 42n, repoFullName: 'acme/web' }
  })
  const card = await prisma.kanbanCard.create({
    data: {
      boardId: board.id,
      issueId: 1n,
      issueNumber: 1,
      status: leased ? 'running' : 'todo',
      assigneeAgentId: AGENT
    }
  })
  const run = leased
    ? await prisma.kanbanRun.create({
        data: {
          cardId: card.id,
          attempt: 1,
          agentId: AGENT,
          daemonId: DAEMON,
          dispatchRevision: card.dispatchRevision,
          dispatchedAt: new Date(),
          leaseId: crypto.randomUUID()
        }
      })
    : null
  return { board, card, run, repo: new PgKanbanSyncRepo(prisma), cards: new PgKanbanCardRepo(prisma) }
}

describe('Kanban synchronization transactions (Postgres)', () => {
  it('serializes a human transition with one audit and rejects a stale competing read', async () => {
    const f = await fixture()
    const snapshot = (await f.repo.get(f.board.id, 1))!
    const plan = planLabelReconcile({ status: 'todo', leased: false }, { state: 'open', labels: ['ac/status:ready'] })
    const results = await Promise.all([
      f.repo.apply(snapshot, plan, 7n, true, 0n),
      f.repo.apply(snapshot, plan, 7n, true, 0n)
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    const current = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: f.card.id } })
    expect(current).toMatchObject({ status: 'ready', stateRevision: 2n, labelWritePending: false, syncEventCursor: 7n })
    expect(await prisma.auditEvent.count({ where: { kind: 'kanban_card_change' } })).toBe(1)
    const next = (await f.repo.get(f.board.id, 1))!
    expect(await f.repo.ack(snapshot, 7n)).toBe(false)
    expect(await f.repo.ack(next, 7n)).toBe(true)
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: f.card.id } })).labelWritePending).toBe(false)
  })

  it.each(['blocked', 'triage', 'archived'] as const)(
    'revokes a lease on a human %s move without counting a failure',
    async (status) => {
      const f = await fixture(true)
      const snapshot = (await f.repo.get(f.board.id, 1))!
      const plan = planLabelReconcile(
        { status: 'running', leased: true },
        { state: 'open', labels: [`ac/status:${status}`] }
      )
      const result = await f.repo.apply(snapshot, plan, 7n, true, 0n)
      expect(result?.revoked?.leaseId).toBe(f.run?.leaseId)
      expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: f.card.id } })).toMatchObject({
        status,
        dispatchRevision: 2n,
        consecutiveFailures: 0
      })
      expect(await prisma.kanbanRun.findUniqueOrThrow({ where: { id: f.run!.id } })).toMatchObject({
        outcome: 'reclaimed',
        reasonCode: 'human_status',
        endedAt: expect.any(Date)
      })
    }
  )

  it('fences an assignment race and preserves independent status/agent event cursors', async () => {
    const f = await fixture(true)
    const snapshot = (await f.repo.get(f.board.id, 1))!
    const result = await f.cards.setAssignee({
      cardId: f.card.id,
      agentId: NEXT,
      onLease: 'revoke',
      source: 'label',
      now: new Date()
    })
    expect(result.ok && result.revokedLease?.leaseId).toBe(f.run?.leaseId)
    const plan = planLabelReconcile(
      { status: 'running', leased: true },
      { state: 'open', labels: ['ac/status:blocked'] }
    )
    expect(await f.repo.apply(snapshot, plan, 7n, true, 12n)).toBe(null)
    const next = (await f.repo.get(f.board.id, 1))!
    expect(next.status).toBe('ready')
    await f.repo.ack(next, 7n, 12n)
    expect(await f.repo.get(f.board.id, 1)).toMatchObject({ syncEventCursor: 7n, syncAgentCursor: 12n })
  })

  it('rotates a bounded scan fairly through terminal, active and todo cards', async () => {
    const f = await fixture()
    await prisma.kanbanCard.createMany({
      data: Array.from({ length: 54 }, (_, i) => ({
        boardId: f.board.id,
        issueId: BigInt(i + 2),
        issueNumber: i + 2,
        status: i % 2 ? ('done' as const) : ('todo' as const)
      }))
    })
    const seen = new Set<number>()
    for (let i = 0; i < 3; i++) {
      const batch = await f.repo.list(f.board.id, 25)
      expect(batch).toHaveLength(25)
      batch.forEach((n) => seen.add(n))
    }
    expect(seen.size).toBe(55)
  })
})
