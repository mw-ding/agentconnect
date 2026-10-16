// PgKanbanDispatchRepo (issue #2 M2) against real Postgres: claim order, caps, SKIP LOCKED, the lease fence, and heartbeats.
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import { planRunEnd, staleLeaseReason, type KanbanRunEnd } from '../../src/kanban/run-accounting.js'
import type { KanbanRunEndInput, KanbanRunOutcomeValue } from '../../src/persistence/ports.js'

const D1 = 'd1111111-1111-4111-8111-111111111111'
const D2 = 'd2222222-2222-4222-8222-222222222222'
const A1 = 'a1111111-1111-4111-8111-111111111111'
const A2 = 'a2222222-2222-4222-8222-222222222222'
const REPO_ID = 987654321n
const NOW = new Date('2026-10-15T12:00:00.000Z')
const live = { now: NOW, isDaemonLive: () => true }

async function seedBoard(caps: { maxInProgress?: number; maxInProgressPerAgent?: number } = {}): Promise<string> {
  await seedDaemon(prisma, D1, { sessionEpoch: 7n })
  await seedDaemon(prisma, D2, { sessionEpoch: 3n })
  await seedAgent(prisma, A1, { daemonId: D1 })
  await seedAgent(prisma, A2, { daemonId: D2 })
  const board = await prisma.kanbanBoard.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      name: 'eng',
      repoId: REPO_ID,
      repoFullName: 'acme/web',
      maxInProgress: caps.maxInProgress ?? 10,
      maxInProgressPerAgent: caps.maxInProgressPerAgent ?? 10
    }
  })
  return board.id
}

let nextIssue = 1
async function seedCard(
  boardId: string,
  opts: {
    agentId?: string | null
    priority?: number
    status?: 'ready' | 'todo' | 'running'
    cooldownUntil?: Date
    notBefore?: Date
    createdAt?: Date
  } = {}
): Promise<{ id: string; issueNumber: number }> {
  const issueNumber = nextIssue++
  const card = await prisma.kanbanCard.create({
    data: {
      boardId,
      issueId: BigInt(100_000 + issueNumber),
      issueNumber,
      status: opts.status ?? 'ready',
      assigneeAgentId: opts.agentId === undefined ? A1 : opts.agentId,
      priority: opts.priority ?? 0,
      ...(opts.cooldownUntil ? { cooldownUntil: opts.cooldownUntil } : {}),
      ...(opts.notBefore ? { notBefore: opts.notBefore } : {}),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {})
    },
    select: { id: true, issueNumber: true }
  })
  return card
}

function end(
  leaseId: string,
  outcome: KanbanRunOutcomeValue,
  extra: Partial<KanbanRunEndInput> = {}
): KanbanRunEndInput {
  const runEnd: KanbanRunEnd =
    outcome === 'blocked'
      ? { outcome, blockKind: 'needs_input' }
      : { outcome: outcome as Exclude<typeof outcome, 'blocked'> }
  return {
    leaseId,
    outcome,
    reasonCode: null,
    now: NOW,
    plan: (card, board) => planRunEnd(card, board, runEnd, NOW),
    ...extra
  }
}

const repo = () => new PgKanbanDispatchRepo(prisma)

describe('PgKanbanDispatchRepo.claim — priority, age, and gates (real Postgres)', () => {
  it('claims ready cards by priority then age and leases each to its agent', async () => {
    const boardId = await seedBoard()
    const old = await seedCard(boardId, { createdAt: new Date('2026-10-01T00:00:00Z') })
    const urgent = await seedCard(boardId, { priority: 5 })
    const young = await seedCard(boardId, { createdAt: new Date('2026-10-14T00:00:00Z') })

    const claimed = await repo().claim(boardId, live)
    expect(claimed.map((c) => c.cardId)).toEqual([urgent.id, old.id, young.id])
    const first = claimed[0]!
    expect(first).toMatchObject({
      agentId: A1,
      daemonId: D1,
      daemonEpoch: 7n,
      attempt: 1,
      dispatchRevision: 2n,
      repoId: REPO_ID,
      repoFullName: 'acme/web',
      sessionKeyPrefix: `github:${REPO_ID}`
    })
    const card = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: urgent.id } })
    expect(card.status).toBe('running')
    const run = await prisma.kanbanRun.findUniqueOrThrow({ where: { leaseId: first.leaseId } })
    expect(run).toMatchObject({ cardId: urgent.id, attempt: 1, daemonEpoch: 7n, ackedAt: null, endedAt: null })
  })

  it("uses the agent's GitHub hook session key so the card resumes the hook's thread (D4)", async () => {
    const boardId = await seedBoard()
    await seedCard(boardId)
    await prisma.hookDef.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        agentId: A1,
        name: 'gh',
        kind: 'github',
        repoId: REPO_ID,
        repoFullName: 'acme/web',
        githubSessionKey: 'acme/web',
        sessionMode: 'perThread',
        events: ['issues:labeled']
      }
    })
    const [lease] = await repo().claim(boardId, live)
    expect(lease?.sessionKeyPrefix).toBe('acme/web')
  })

  it('skips cooling-down, not-yet-due, unassigned, non-ready, offline, and paused cards', async () => {
    const boardId = await seedBoard()
    await seedCard(boardId, { cooldownUntil: new Date(NOW.getTime() + 60_000) })
    await seedCard(boardId, { notBefore: new Date(NOW.getTime() + 60_000) })
    await seedCard(boardId, { agentId: null })
    await seedCard(boardId, { status: 'todo' })
    const offline = await seedCard(boardId, { agentId: A2 })
    const due = await seedCard(boardId, { cooldownUntil: new Date(NOW.getTime() - 1) })

    const claimed = await repo().claim(boardId, { now: NOW, isDaemonLive: (d) => d === D1 })
    expect(claimed.map((c) => c.cardId)).toEqual([due.id])
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: offline.id } })).status).toBe('ready')

    await prisma.agent.update({ where: { id: A2 }, data: { status: 'paused' } })
    expect(await repo().claim(boardId, live)).toEqual([])
  })

  it('never claims for an agent in another org', async () => {
    const boardId = await seedBoard()
    const otherOrg = await prisma.org.create({ data: { name: 'other', slug: 'other' } })
    await prisma.agent.update({ where: { id: A1 }, data: { orgId: otherOrg.id } })
    await seedCard(boardId)
    expect(await repo().claim(boardId, live)).toEqual([])
  })
})

describe('PgKanbanDispatchRepo.claim — caps (real Postgres)', () => {
  it('honors maxInProgress across claims, counting unacked leases', async () => {
    const boardId = await seedBoard({ maxInProgress: 2 })
    for (let i = 0; i < 4; i++) await seedCard(boardId, { agentId: i % 2 ? A2 : A1 })
    expect(await repo().claim(boardId, live)).toHaveLength(2)
    expect(await repo().claim(boardId, live)).toHaveLength(0)
  })

  it('honors maxInProgressPerAgent while other agents still fill the board', async () => {
    const boardId = await seedBoard({ maxInProgress: 10, maxInProgressPerAgent: 1 })
    await seedCard(boardId, { agentId: A1, priority: 3 })
    await seedCard(boardId, { agentId: A1, priority: 2 })
    await seedCard(boardId, { agentId: A2, priority: 1 })
    const claimed = await repo().claim(boardId, live)
    expect(claimed.map((c) => c.agentId).sort()).toEqual([A1, A2])
    expect(await repo().claim(boardId, live)).toHaveLength(0)
  })

  it('frees the slot when a run ends', async () => {
    const boardId = await seedBoard({ maxInProgress: 1 })
    await seedCard(boardId)
    await seedCard(boardId)
    const [first] = await repo().claim(boardId, live)
    expect(await repo().claim(boardId, live)).toHaveLength(0)
    expect((await repo().endRun(end(first!.leaseId, 'transient'))).accepted).toBe(true)
    expect(await repo().claim(boardId, live)).toHaveLength(1)
  })

  it('respects a per-call limit', async () => {
    const boardId = await seedBoard()
    for (let i = 0; i < 3; i++) await seedCard(boardId)
    expect(await repo().claim(boardId, { ...live, limit: 1 })).toHaveLength(1)
  })
})

describe('PgKanbanDispatchRepo.claim — concurrency (FOR UPDATE SKIP LOCKED, real Postgres)', () => {
  it('concurrent claimers never double-lease a card or exceed the board cap', async () => {
    const boardId = await seedBoard({ maxInProgress: 3 })
    for (let i = 0; i < 8; i++) await seedCard(boardId, { agentId: i % 2 ? A2 : A1 })

    // Several CP replicas tick the same board at once; the losers skip the locked board and retry next tick.
    for (let round = 0; round < 3; round++) {
      await Promise.all(Array.from({ length: 6 }, () => repo().claim(boardId, live)))
    }
    const open = await prisma.kanbanRun.findMany({ where: { endedAt: null }, select: { cardId: true } })
    expect(open).toHaveLength(3)
    expect(new Set(open.map((r) => r.cardId)).size).toBe(3)
    expect(await prisma.kanbanCard.count({ where: { boardId, status: 'running' } })).toBe(3)
  })

  it('skips a board another claimer holds instead of waiting on it', async () => {
    const boardId = await seedBoard()
    await seedCard(boardId)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let locked!: () => void
    const lockTaken = new Promise<void>((r) => (locked = r))
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "kanban_board" WHERE "id" = ${boardId}::uuid FOR UPDATE`
        locked()
        await held
      },
      { timeout: 20_000 }
    )
    await lockTaken
    const started = Date.now()
    expect(await repo().claim(boardId, live)).toEqual([])
    expect(Date.now() - started).toBeLessThan(5_000)
    release()
    await holder
    expect(await repo().claim(boardId, live)).toHaveLength(1)
  })

  it('skips a card row another writer holds and claims the next one', async () => {
    const boardId = await seedBoard()
    const busy = await seedCard(boardId, { priority: 9 })
    const next = await seedCard(boardId, { priority: 1 })
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let locked!: () => void
    const lockTaken = new Promise<void>((r) => (locked = r))
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "kanban_card" WHERE "id" = ${busy.id}::uuid FOR UPDATE`
        locked()
        await held
      },
      { timeout: 20_000 }
    )
    await lockTaken
    const claimed = await repo().claim(boardId, live)
    release()
    await holder
    expect(claimed.map((c) => c.cardId)).toEqual([next.id])
  })

  it('the storage layer refuses a second open run on one card', async () => {
    const boardId = await seedBoard()
    await seedCard(boardId)
    const [lease] = await repo().claim(boardId, live)
    await expect(
      prisma.kanbanRun.create({
        data: {
          cardId: lease!.cardId,
          attempt: 2,
          agentId: A1,
          daemonId: D1,
          leaseId: crypto.randomUUID(),
          dispatchRevision: lease!.dispatchRevision,
          dispatchedAt: NOW
        }
      })
    ).rejects.toThrow()
  })
})

describe('PgKanbanDispatchRepo.endRun — the lease fence (real Postgres)', () => {
  async function leased() {
    const boardId = await seedBoard()
    await seedCard(boardId)
    const [lease] = await repo().claim(boardId, live)
    await repo().markAcked(lease!.leaseId, 'read', NOW)
    return lease!
  }
  const fenceOf = (l: Awaited<ReturnType<typeof leased>>) => ({
    daemonId: l.daemonId,
    cardId: l.cardId,
    attempt: l.attempt,
    dispatchRevision: l.dispatchRevision
  })

  it('accepts the live holder once, then rejects its late duplicate', async () => {
    const lease = await leased()
    const first = await repo().endRun(end(lease.leaseId, 'failed', { fence: fenceOf(lease) }))
    expect(first).toMatchObject({ accepted: true, card: { from: 'running', to: 'ready' } })
    expect((await repo().endRun(end(lease.leaseId, 'completed', { fence: fenceOf(lease) }))).accepted).toBe(false)
    const card = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: lease.cardId } })
    expect(card).toMatchObject({
      status: 'ready',
      consecutiveFailures: 1,
      dispatchRevision: lease.dispatchRevision + 1n
    })
  })

  it('rejects a write from another daemon, attempt, card, or dispatch revision', async () => {
    const lease = await leased()
    const fence = fenceOf(lease)
    for (const bad of [
      { ...fence, daemonId: D2 },
      { ...fence, attempt: 2 },
      { ...fence, cardId: crypto.randomUUID() },
      { ...fence, boardId: crypto.randomUUID() },
      { ...fence, agentId: A2 },
      { ...fence, dispatchRevision: lease.dispatchRevision - 1n }
    ]) {
      expect((await repo().endRun(end(lease.leaseId, 'completed', { fence: bad }))).accepted).toBe(false)
    }
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: lease.cardId } })).status).toBe('running')
  })

  it("a reclaimed lease's late report cannot touch the card's next run", async () => {
    const lease = await leased()
    const reaped = await repo().endRun(end(lease.leaseId, 'reclaimed', { reasonCode: 'stale_heartbeat' }))
    expect(reaped).toMatchObject({ accepted: true, card: { to: 'ready' }, plan: { countsAsFailure: false } })
    const [next] = await repo().claim(lease.boardId, live)
    expect(next?.attempt).toBe(2)

    expect((await repo().endRun(end(lease.leaseId, 'completed', { fence: fenceOf(lease) }))).accepted).toBe(false)
    const card = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: lease.cardId } })
    expect(card).toMatchObject({ status: 'running', consecutiveFailures: 0 })
    const run = await prisma.kanbanRun.findUniqueOrThrow({ where: { leaseId: lease.leaseId } })
    expect(run).toMatchObject({ outcome: 'reclaimed', reasonCode: 'stale_heartbeat' })
  })

  it('unknown leases are rejected', async () => {
    await seedBoard()
    expect((await repo().endRun(end(crypto.randomUUID(), 'completed'))).accepted).toBe(false)
  })
})

describe('PgKanbanDispatchRepo.heartbeat and open leases (real Postgres)', () => {
  it('stamps live leases, re-stamps the epoch, and reports superseded ones', async () => {
    const boardId = await seedBoard()
    await seedCard(boardId)
    await seedCard(boardId)
    const [a, b] = await repo().claim(boardId, live)
    await repo().markAcked(a!.leaseId, 'write', NOW)
    await repo().markAcked(b!.leaseId, 'read', NOW)
    await repo().endRun(end(b!.leaseId, 'reclaimed'))

    const later = new Date(NOW.getTime() + 30_000)
    await prisma.daemon.update({ where: { id: D1 }, data: { sessionEpoch: 8n } })
    const superseded = await repo().heartbeat(
      D1,
      8n,
      [
        { leaseId: a!.leaseId, cardId: a!.cardId, dispatchRevision: a!.dispatchRevision, sessionId: 'acp-1' },
        { leaseId: b!.leaseId, cardId: b!.cardId, dispatchRevision: b!.dispatchRevision }
      ],
      later
    )
    expect(superseded).toEqual([b!.leaseId])
    const run = await prisma.kanbanRun.findUniqueOrThrow({ where: { leaseId: a!.leaseId } })
    expect(run).toMatchObject({ heartbeatAt: later, daemonEpoch: 8n, sessionId: 'acp-1', mode: 'write' })

    // Another daemon, or a stale revision, cannot keep someone else's lease alive.
    expect(
      await repo().heartbeat(
        D2,
        3n,
        [{ leaseId: a!.leaseId, cardId: a!.cardId, dispatchRevision: a!.dispatchRevision }],
        later
      )
    ).toEqual([a!.leaseId])
    expect(
      await repo().heartbeat(D1, 8n, [{ leaseId: a!.leaseId, cardId: a!.cardId, dispatchRevision: 1n }], later)
    ).toEqual([a!.leaseId])
  })

  it('lists open leases with the facts the reaper predicate needs', async () => {
    const boardId = await seedBoard()
    await seedCard(boardId)
    const [lease] = await repo().claim(boardId, live)
    await prisma.daemon.update({ where: { id: D1 }, data: { sessionEpoch: 9n } })
    let [open] = await repo().listOpenLeases(10)
    expect(open).toMatchObject({
      leaseId: lease!.leaseId,
      daemonId: D1,
      daemonEpoch: 7n,
      currentDaemonEpoch: 9n,
      agentDaemonId: D1,
      ackedAt: null,
      staleLeaseSec: 14_400
    })
    await prisma.agent.update({ where: { id: A1 }, data: { daemonId: D2 } })
    ;[open] = await repo().listOpenLeases(10)
    expect(open?.agentDaemonId).toBe(D2)
    await prisma.agent.delete({ where: { id: A1 } })
    ;[open] = await repo().listOpenLeases(10)
    expect(open?.agentDaemonId).toBeUndefined()
  })
})

it('scans beyond a full page of capped or offline agents instead of starving eligible cards', async () => {
  const boardId = await seedBoard({ maxInProgress: 3, maxInProgressPerAgent: 1 })
  for (let i = 0; i < 51; i++) await seedCard(boardId, { priority: 5 })
  const eligible = await seedCard(boardId, { agentId: A2 })
  const claims = await repo().claim(boardId, live)
  expect(claims.map((c) => c.cardId)).toContain(eligible.id)
  expect(claims).toHaveLength(2)
})

it('does not reclaim a lease refreshed after the stale scan', async () => {
  const boardId = await seedBoard()
  await seedCard(boardId)
  const [lease] = await repo().claim(boardId, live)
  await repo().markAcked(lease!.leaseId, 'read', NOW)
  const later = new Date(NOW.getTime() + 5 * 60 * 60_000)
  const opts = { unackedGraceMs: 120_000, epochGraceMs: 180_000 }
  const [sample] = await repo().listOpenLeases(10)
  expect(staleLeaseReason(sample!, later, opts)).toBe('stale_heartbeat')
  await repo().heartbeat(
    D1,
    7n,
    [{ leaseId: lease!.leaseId, cardId: lease!.cardId, dispatchRevision: lease!.dispatchRevision }],
    later
  )
  const result = await repo().endRun(
    end(lease!.leaseId, 'reclaimed', {
      now: later,
      reclaimIf: (facts) => staleLeaseReason(facts, later, opts) !== null
    })
  )
  expect(result.accepted).toBe(false)
  expect((await prisma.kanbanRun.findUniqueOrThrow({ where: { leaseId: lease!.leaseId } })).endedAt).toBeNull()
})

it('rejects old-epoch heartbeats and moved-agent writes before the reaper runs', async () => {
  const boardId = await seedBoard()
  await seedCard(boardId)
  const [lease] = await repo().claim(boardId, live)
  const beats = [{ leaseId: lease!.leaseId, cardId: lease!.cardId, dispatchRevision: lease!.dispatchRevision }]
  await prisma.daemon.update({ where: { id: D1 }, data: { sessionEpoch: 8n } })
  expect(await repo().heartbeat(D1, 7n, beats, NOW)).toEqual([lease!.leaseId])
  await prisma.agent.update({ where: { id: A1 }, data: { daemonId: D2 } })
  expect(await repo().heartbeat(D1, 8n, beats, NOW)).toEqual([lease!.leaseId])
  expect(
    (
      await repo().endRun(
        end(lease!.leaseId, 'completed', {
          fence: { daemonId: D1, cardId: lease!.cardId, attempt: 1, dispatchRevision: lease!.dispatchRevision }
        })
      )
    ).accepted
  ).toBe(false)
})
