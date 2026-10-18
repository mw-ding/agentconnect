// The claim dry run (explainBoard/explainCard) agrees with the real SQL claim on real Postgres, and changes nothing.
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import type { KanbanStatus } from '../../src/kanban/card-state.js'
import type { Prisma } from '../../src/generated/prisma/client.js'

const D1 = 'd1111111-1111-4111-8111-111111111111'
const D2 = 'd2222222-2222-4222-8222-222222222222'
const A1 = 'a1111111-1111-4111-8111-111111111111'
const A2 = 'a2222222-2222-4222-8222-222222222222'
const A3 = 'a3333333-3333-4333-8333-333333333333'
const A4 = 'a4444444-4444-4444-8444-444444444444'
const A5 = 'a5555555-5555-4555-8555-555555555555'
const A6 = 'a6666666-6666-4666-8666-666666666666'
const MISSING = 'a9999999-9999-4999-8999-999999999999'
const REPO_ID = 987654321n
const NOW = new Date('2026-10-15T12:00:00.000Z')
const LIVE = new Set([D1])
const opts = { now: NOW, isDaemonLive: (id: string) => LIVE.has(id) }

async function board(maxInProgress: number, maxPerAgent: number, enabled = true) {
  return prisma.kanbanBoard.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      name: 'explain',
      repoId: REPO_ID,
      repoFullName: 'acme/web',
      maxInProgress,
      maxInProgressPerAgent: maxPerAgent,
      enabled
    }
  })
}

async function card(boardId: string, n: number, data: Record<string, unknown> = {}) {
  return prisma.kanbanCard.create({
    data: {
      boardId,
      issueId: BigInt(1000 + n),
      issueNumber: n,
      status: 'ready' as KanbanStatus,
      assigneeAgentId: A1,
      createdAt: new Date(NOW.getTime() - (100 - n) * 1000),
      ...data
    }
  })
}

/** An assignee naming no agent row: the FK forbids a normal create, so insert with triggers off. */
async function danglingAssigneeCard(boardId: string, n: number): Promise<{ id: string }> {
  const id = randomUUID()
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
    await tx.$executeRawUnsafe(
      `INSERT INTO "kanban_card" ("id", "boardId", "issueId", "issueNumber", "status", "assigneeAgentId", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, 'ready', $5, now(), now())`,
      id,
      boardId,
      BigInt(1000 + n),
      n,
      MISSING
    )
  })
  return { id }
}

async function seedAgents() {
  await seedDaemon(prisma, D1, { sessionEpoch: 1n })
  await seedDaemon(prisma, D2, { sessionEpoch: 1n })
  await seedAgent(prisma, A1, { daemonId: D1 })
  await seedAgent(prisma, A2, { daemonId: D1 })
  await prisma.agent.update({ where: { id: A2 }, data: { status: 'paused' } })
  await seedAgent(prisma, A3)
  await seedAgent(prisma, A4, { daemonId: D2 })
  await seedAgent(prisma, A5, { daemonId: D1 })
}

async function snapshot() {
  return {
    cards: await prisma.kanbanCard.findMany({ orderBy: { id: 'asc' } }),
    runs: await prisma.kanbanRun.findMany({ orderBy: { id: 'asc' } }),
    boards: await prisma.kanbanBoard.findMany({ orderBy: { id: 'asc' } }),
    audit: await prisma.auditEvent.count()
  }
}

describe('claim dry run parity (real Postgres)', () => {
  // `open_lease` is deliberately absent: the SQL claim has no such gate (a second open run trips the unique index), so it cannot be compared by claiming.
  it('explainBoard agrees with the real claim: same set, same order, every skipped card explained', async () => {
    await seedAgents()
    const b = await board(4, 2)
    const gated: Record<string, { id: string }> = {
      status_not_claimable: await card(b.id, 20, { status: 'todo' }),
      no_assignee: await card(b.id, 21, { assigneeAgentId: null }),
      agent_missing: await danglingAssigneeCard(b.id, 22),
      agent_paused: await card(b.id, 23, { assigneeAgentId: A2 }),
      agent_unplaced: await card(b.id, 24, { assigneeAgentId: A3 }),
      daemon_offline: await card(b.id, 25, { assigneeAgentId: A4 }),
      cooldown: await card(b.id, 26, { cooldownUntil: new Date(NOW.getTime() + 60_000) }),
      not_before: await card(b.id, 27, { notBefore: new Date(NOW.getTime() + 60_000) }),
      promotion_pending: await card(b.id, 28, { promotionPending: true })
    }
    // A1 has three eligible cards but a per-agent cap of 2; A5's third meets the board cap of 4.
    const n1 = await card(b.id, 1, { priority: 5 })
    const n2 = await card(b.id, 2, { priority: 4 })
    const n3 = await card(b.id, 3, { priority: 3 })
    const n4 = await card(b.id, 4, { priority: 2, assigneeAgentId: A5 })
    const n5 = await card(b.id, 5, { priority: 1, assigneeAgentId: A5 })
    const n6 = await card(b.id, 6, { priority: 0, assigneeAgentId: A5 })
    const done = await card(b.id, 30, { status: 'done' })

    const repo = new PgKanbanDispatchRepo(prisma)
    const before = await snapshot()
    const explanation = (await repo.explainBoard(b.id, opts))!
    expect(await snapshot()).toEqual(before)

    expect(explanation.wouldClaimNext).toEqual([n1.id, n2.id, n4.id, n5.id])
    expect(explanation.cards.map((c) => c.cardId)).not.toContain(done.id)
    const byId = new Map(explanation.cards.map((c) => [c.cardId, c]))
    expect(byId.get(n3.id)).toMatchObject({ capBound: 'agent_cap', verdict: { eligible: true } })
    expect(byId.get(n6.id)).toMatchObject({ capBound: 'board_cap', verdict: { eligible: true } })
    for (const [gate, c] of Object.entries(gated)) {
      expect(byId.get(c.id)!.verdict, `card ${gate}`).toEqual({ eligible: false, gate })
    }

    const claimed = await repo.claim(b.id, opts)
    // A new gate in the SQL claim shows up here: it would claim a card the dry run called blocked, or skip one it called free.
    expect(claimed.map((l) => l.cardId)).toEqual(explanation.wouldClaimNext)
    const claimedIds = new Set(claimed.map((l) => l.cardId))
    for (const entry of explanation.cards) {
      if (claimedIds.has(entry.cardId)) continue
      const explained = !entry.verdict.eligible || entry.capBound !== undefined
      expect(explained, `card #${entry.issueNumber} was skipped by the claim but the dry run called it free`).toBe(true)
    }
  })

  it('explainCard reports the same verdict the board view gives, and null for a card of another board', async () => {
    await seedAgents()
    const b = await board(5, 5)
    const otherBoard = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'other', repoId: REPO_ID + 1n, repoFullName: 'acme/api' }
    })
    const elsewhere = await card(otherBoard.id, 9)
    const free = await card(b.id, 1)
    const cooling = await card(b.id, 2, { cooldownUntil: new Date(NOW.getTime() + 60_000) })
    const repo = new PgKanbanDispatchRepo(prisma)
    expect((await repo.explainCard(b.id, free.id, opts))!.verdict).toEqual({
      eligible: true,
      role: 'work',
      agentId: A1
    })
    expect((await repo.explainCard(b.id, cooling.id, opts))!.verdict).toEqual({ eligible: false, gate: 'cooldown' })
    expect(await repo.explainCard(b.id, randomUUID(), opts)).toBeNull()
    expect(await repo.explainCard(b.id, elsewhere.id, opts)).toBeNull()
    expect(await repo.explainCard(randomUUID(), free.id, opts)).toBeNull()
    expect(await repo.explainBoard(randomUUID(), opts)).toBeNull()
  })

  it('explains a terminal card on request and a disabled board as board_disabled', async () => {
    await seedAgents()
    const b = await board(5, 5, false)
    const done = await card(b.id, 1, { status: 'done' })
    const ready = await card(b.id, 2)
    const repo = new PgKanbanDispatchRepo(prisma)
    expect((await repo.explainCard(b.id, done.id, opts))!.verdict).toEqual({ eligible: false, gate: 'board_disabled' })
    const all = (await repo.explainBoard(b.id, opts))!
    expect(all.cards.map((c) => c.cardId)).toEqual([ready.id])
    expect(all.wouldClaimNext).toEqual([])
    expect(await repo.claim(b.id, opts)).toEqual([])
  })

  it('counts open runs against the caps and flags a held card', async () => {
    await seedAgents()
    const b = await board(1, 5)
    const held = await card(b.id, 1, { status: 'running' })
    await prisma.kanbanRun.create({
      data: {
        cardId: held.id,
        attempt: 1,
        agentId: A1,
        daemonId: D1,
        leaseId: randomUUID(),
        dispatchRevision: 1n,
        dispatchedAt: NOW,
        mode: 'read'
      }
    })
    const waiting = await card(b.id, 2)
    const repo = new PgKanbanDispatchRepo(prisma)
    const explanation = (await repo.explainBoard(b.id, opts))!
    const byId = new Map(explanation.cards.map((c) => [c.cardId, c]))
    expect(byId.get(waiting.id)!.verdict).toEqual({ eligible: false, gate: 'board_cap' })
    expect(byId.get(held.id)!.input.card.hasOpenLease).toBe(true)
    expect(byId.get(waiting.id)!.input.openRunCount).toBe(1)
    expect(explanation.wouldClaimNext).toEqual([])
    expect(await repo.claim(b.id, opts)).toEqual([])
  })

  it('treats an agent of another organization as missing, as the claim’s org join does', async () => {
    await seedAgents()
    await prisma.org.create({ data: { id: 'org-explain-other', name: 'Other', slug: 'other-explain' } })
    await seedAgent(prisma, A6, { orgId: 'org-explain-other', daemonId: D1, name: 'foreign' })
    const b = await board(5, 5)
    const c = await card(b.id, 1, { assigneeAgentId: A6 })
    const repo = new PgKanbanDispatchRepo(prisma)
    expect((await repo.explainCard(b.id, c.id, opts))!.verdict).toEqual({ eligible: false, gate: 'agent_missing' })
    expect(await repo.claim(b.id, opts)).toEqual([])
  })

  it('vera-528: sub-millisecond age order matches the claim exactly', async () => {
    await seedAgents()
    const b = await board(1, 5)
    // The older card carries the LARGER id and the newer one is 800µs younger: millisecond precision (plus the old id
    // tiebreak) would order them backwards, while PG's timestamptz(6) does not. Prisma writes createdAt at ms
    // precision, so both rows go in by raw SQL.
    const olderId = 'f0000000-0000-4000-8000-000000000001'
    const newerId = '10000000-0000-4000-8000-000000000001'
    await prisma.$executeRawUnsafe(
      `INSERT INTO "kanban_card" ("id", "boardId", "issueId", "issueNumber", "status", "assigneeAgentId", "priority", "createdAt", "updatedAt")
       VALUES ($1, $2, 9001, 901, 'ready', $3, 0, $4, $4),
              ($5, $2, 9002, 902, 'ready', $3, 0, $4 + interval '800 microseconds', $4 + interval '800 microseconds')`,
      olderId,
      b.id,
      A1,
      NOW,
      newerId
    )
    const repo = new PgKanbanDispatchRepo(prisma)
    const explanation = (await repo.explainBoard(b.id, opts))!
    expect(explanation.wouldClaimNext).toEqual([olderId])
    expect(await repo.claim(b.id, opts)).toMatchObject([{ cardId: olderId }])
  })

  it('vera-528: the dry run takes no row locks — it runs in a read-only transaction', async () => {
    await seedAgents()
    const b = await board(5, 5)
    const c = await card(b.id, 1)
    const before = await snapshot()
    // A refusal poisons its transaction, so each probe below gets a fresh read-only one; the sentinel rolls it back.
    class RoDone extends Error {}
    const readOnly = async (fn: (tx: Prisma.TransactionClient) => Promise<void>) => {
      await prisma
        .$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
          await fn(tx)
          throw new RoDone()
        })
        .catch((e: unknown) => {
          if (!(e instanceof RoDone)) throw e
        })
    }
    // (Prisma reports the Postgres code inside the P2010 message: "Raw query failed. Code: `25006`. ...".)
    const pgCode = (e: unknown) => /Code: `(\d+)`/.exec((e as { message?: string })?.message ?? '')?.[1]
    await readOnly(async (tx) => {
      const repo = new PgKanbanDispatchRepo(tx)
      expect((await repo.explainBoard(b.id, opts))!.cards.map((e) => e.cardId)).toContain(c.id)
      expect((await repo.explainCard(b.id, c.id, opts))!.cardId).toBe(c.id)
      expect((await repo.listBoardCards(b.id, 500)).cards.map((r) => r.id)).toContain(c.id)
    })
    await readOnly(async (tx) => {
      const claimed = await new PgKanbanDispatchRepo(tx).claim(b.id, opts).then(
        () => null,
        (e: unknown) => e
      )
      expect(pgCode(claimed)).toBe('25006')
    })
    await readOnly(async (tx) => {
      // Control: a row lock on the same session is refused, so a lock-taking read could not hide here.
      const lock = await tx.$queryRawUnsafe('SELECT 1 FROM "kanban_card" WHERE "id" = $1::uuid FOR UPDATE', c.id).then(
        () => null,
        (e: unknown) => e
      )
      expect(pgCode(lock)).toBe('25006')
    })
    expect(await snapshot()).toEqual(before)
  })
})
