// PgKanbanDispatchRepo (issue #2 M2) against real Postgres: claim order, caps, SKIP LOCKED, the lease fence, and heartbeats.
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import { PgKanbanCardRepo } from '../../src/persistence/repositories/kanban.repo.js'
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
    await repo().markAcked(lease!.leaseId, 'read', NOW, 7n)
    return lease!
  }
  const fenceOf = (l: Awaited<ReturnType<typeof leased>>) => ({
    daemonId: l.daemonId,
    daemonEpoch: l.daemonEpoch,
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
      { ...fence, daemonEpoch: 6n },
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
    const first = await seedCard(boardId)
    await prisma.kanbanCard.update({ where: { id: first.id }, data: { mode: 'write' } })
    await seedCard(boardId)
    const [a, b] = await repo().claim(boardId, live)
    await repo().markAcked(a!.leaseId, 'write', NOW, 7n)
    await repo().markAcked(b!.leaseId, 'read', NOW, 7n)
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
  await repo().markAcked(lease!.leaseId, 'read', NOW, 7n)
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
          fence: {
            daemonId: D1,
            daemonEpoch: 8n,
            cardId: lease!.cardId,
            attempt: 1,
            dispatchRevision: lease!.dispatchRevision
          }
        })
      )
    ).accepted
  ).toBe(false)
})

it('rechecks an unacked stale scan after a fenced heartbeat implicitly acknowledges the lease', async () => {
  const boardId = await seedBoard()
  await seedCard(boardId)
  const r = repo()
  const [lease] = await r.claim(boardId, live)
  const later = new Date(NOW.getTime() + 180_000)
  const opts = { unackedGraceMs: 120_000, epochGraceMs: 180_000 }
  const [sample] = await r.listOpenLeases(10)
  expect(staleLeaseReason(sample!, later, opts)).toBe('dispatch_unacked')
  await r.heartbeat(
    D1,
    7n,
    [{ leaseId: lease!.leaseId, cardId: lease!.cardId, dispatchRevision: lease!.dispatchRevision }],
    later
  )
  expect(
    await r.endRun(
      end(lease!.leaseId, 'reclaimed', {
        now: later,
        reclaimIf: (facts) => staleLeaseReason(facts, later, opts) !== null
      })
    )
  ).toEqual({ accepted: false })
  expect(await prisma.kanbanRun.findUniqueOrThrow({ where: { leaseId: lease!.leaseId } })).toMatchObject({
    ackedAt: later,
    heartbeatAt: later,
    endedAt: null
  })
  expect(await r.claim(boardId, { ...live, now: later })).toEqual([])
})

it('fences ACK writes against ended leases, stale epochs, and superseded revisions', async () => {
  const boardId = await seedBoard()
  await seedCard(boardId)
  await prisma.kanbanBoard.update({ where: { id: boardId }, data: { defaultMode: 'write' } })
  const r = repo()
  const [lease] = await r.claim(boardId, live)
  expect(await r.isCurrentLease(lease!.leaseId, 'write', 6n)).toBe(false)
  expect(await r.isCurrentLease(lease!.leaseId, 'read', 7n)).toBe(false)
  expect(await r.isCurrentLease(lease!.leaseId, 'write', 7n)).toBe(true)
  expect(await r.markAcked(lease!.leaseId, 'write', NOW, 6n)).toBe(false)
  expect(await r.markAcked(lease!.leaseId, 'write', NOW, 7n)).toBe(true)
  await prisma.kanbanCard.update({ where: { id: lease!.cardId }, data: { dispatchRevision: { increment: 1 } } })
  expect(await r.markAcked(lease!.leaseId, 'write', NOW, 7n)).toBe(false)
  await prisma.kanbanCard.update({ where: { id: lease!.cardId }, data: { dispatchRevision: { decrement: 1 } } })
  await prisma.daemon.update({ where: { id: D1 }, data: { sessionEpoch: 8n } })
  expect(await r.markAcked(lease!.leaseId, 'write', NOW, 7n)).toBe(false)
  await r.endRun(end(lease!.leaseId, 'completed'))
  expect(await r.markAcked(lease!.leaseId, 'read', NOW, 8n)).toBe(false)
  expect((await prisma.kanbanRun.findUniqueOrThrow({ where: { leaseId: lease!.leaseId } })).mode).toBe('write')
})

it('reads lease time from the database clock', async () => {
  const before = await prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`
  const now = await repo().now()
  const after = await prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`
  expect(now.getTime()).toBeGreaterThanOrEqual(before[0]!.now.getTime())
  expect(now.getTime()).toBeLessThanOrEqual(after[0]!.now.getTime())
})

describe('PgKanbanDispatchRepo mismatch recovery bounds (real Postgres)', () => {
  // A card whose latest run ended as a pre-dispatch mismatch, parked in `status`.
  async function park(boardId: string, status: 'blocked' | 'triage' | 'todo' | 'done' | 'archived' | 'ready') {
    const card = await seedCard(boardId)
    const [lease] = await repo().claim(boardId, { ...live, limit: 1 })
    await repo().endRun({
      leaseId: lease!.leaseId,
      outcome: 'transient',
      reasonCode: 'github_state_mismatch',
      now: NOW,
      plan: (c) => ({ ...c, status, cooldownUntil: null, blockKind: null, countsAsFailure: false })
    })
    return card
  }

  it('lists only due, non-terminal, mismatch-parked cards up to the limit', async () => {
    const boardId = await seedBoard()
    const blocked = await park(boardId, 'blocked')
    const triage = await park(boardId, 'triage')
    const todo = await park(boardId, 'todo')
    await park(boardId, 'done')
    await park(boardId, 'archived')
    await park(boardId, 'ready')
    await seedCard(boardId, { status: 'todo' })
    const listed = await repo().listRecoveryDue(boardId, NOW, 10)
    expect(listed.map((c) => c.issueNumber)).toEqual([blocked, triage, todo].map((c) => c.issueNumber))
    expect(listed[0]).toEqual({
      cardId: blocked.id,
      issueNumber: blocked.issueNumber,
      promotion: false,
      promotionEventCursor: null,
      promotionPostAccepted: false,
      promotionStartedAt: null,
      promotionChecks: 0,
      recoveryCheckAt: null
    })
    expect(await repo().listRecoveryDue(boardId, NOW, 2)).toHaveLength(2)
    expect(await repo().getParkedStatus(boardId, blocked.issueNumber)).toBe('blocked')
  })

  it('backs a card off exponentially to a one-hour ceiling and lists the most overdue first', async () => {
    const boardId = await seedBoard()
    const a = await park(boardId, 'blocked')
    const b = await park(boardId, 'blocked')
    const expected = [60, 120, 240, 480, 960, 1920, 3600, 3600]
    for (const sec of expected) {
      await repo().deferRecovery(a.id, NOW)
      expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: a.id } })).recoveryCheckAt).toEqual(
        new Date(NOW.getTime() + sec * 1000)
      )
    }
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: a.id } })).recoveryChecks).toBe(expected.length)
    expect((await repo().listRecoveryDue(boardId, NOW, 10)).map((c) => c.cardId)).toEqual([b.id])
    await repo().deferRecovery(b.id, new Date(NOW.getTime() - 3600_000))
    const later = new Date(NOW.getTime() + 3600_000)
    expect((await repo().listRecoveryDue(boardId, later, 10)).map((c) => c.cardId)).toEqual([b.id, a.id])
  })

  it('applies a recovery move only from the expected parked status and resets the backoff', async () => {
    const boardId = await seedBoard()
    const c = await park(boardId, 'blocked')
    await repo().deferRecovery(c.id, NOW)
    expect(await repo().ingestStatus(boardId, c.issueNumber, 'triage', 'ready')).toBe(false)
    expect(await repo().ingestStatus(boardId, c.issueNumber, 'blocked', 'ready')).toBe(true)
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      status: 'ready',
      recoveryCheckAt: null,
      recoveryChecks: 0
    })
    expect(await repo().ingestStatus(boardId, c.issueNumber, 'blocked', 'ready')).toBe(false)
  })

  it('restarts the backoff when the observed GitHub fingerprint changes, and on a webhook reset', async () => {
    const boardId = await seedBoard()
    const c = await park(boardId, 'blocked')
    const checkAt = async () => (await prisma.kanbanCard.findUniqueOrThrow({ where: { id: c.id } })).recoveryCheckAt
    for (const sec of [60, 120, 240]) {
      await repo().deferRecovery(c.id, NOW, 'blocked')
      expect(await checkAt()).toEqual(new Date(NOW.getTime() + sec * 1000))
    }
    await repo().deferRecovery(c.id, NOW, 'triage+blocked')
    expect(await checkAt()).toEqual(new Date(NOW.getTime() + 60_000))
    await repo().deferRecovery(c.id, NOW, 'triage+blocked')
    expect(await checkAt()).toEqual(new Date(NOW.getTime() + 120_000))
    // An unread (failed) check keeps the fingerprint and keeps backing off.
    await repo().deferRecovery(c.id, NOW)
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      recoveryObserved: 'triage+blocked',
      recoveryChecks: 3
    })
    await repo().resetRecovery(boardId, c.issueNumber)
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      recoveryCheckAt: null,
      recoveryChecks: 0,
      recoveryObserved: null
    })
    expect((await repo().listRecoveryDue(boardId, NOW, 10)).map((d) => d.cardId)).toEqual([c.id])
  })

  // Open a promotion intent on a fresh todo card, as the graph reconciler does just before its POST.
  async function begin(boardId: string, cursor = 42n, startedAt = NOW) {
    const card = await seedCard(boardId, { status: 'todo' })
    const { stateRevision } = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })
    expect(await new PgKanbanCardRepo(prisma).beginPromotion(card.id, stateRevision, cursor, startedAt)).toBe(true)
    return { ...card, stateRevision: stateRevision + 1n }
  }

  it('lists a todo card with a reverted promotion and adopts or clears it exactly once', async () => {
    const boardId = await seedBoard()
    const plain = await seedCard(boardId, { status: 'todo' })
    const cards = new PgKanbanCardRepo(prisma)
    const pending = await begin(boardId)
    await cards.notePromotionPosted(pending.id)
    expect(await cards.revertPromotion(pending.id, 0n)).toBe(false)
    expect(await cards.revertPromotion(pending.id, pending.stateRevision)).toBe(true)
    const due = {
      cardId: pending.id,
      issueNumber: pending.issueNumber,
      promotion: true,
      promotionEventCursor: 42n,
      promotionPostAccepted: true,
      promotionStartedAt: NOW,
      promotionChecks: 0,
      recoveryCheckAt: null
    }
    expect(await repo().listRecoveryDue(boardId, NOW, 10)).toEqual([due])
    // A doorbell looks the pending card up by issue number; a plain todo card has nothing pending.
    expect(await repo().getPendingPromotion(boardId, pending.issueNumber)).toEqual(due)
    expect(await repo().getPendingPromotion(boardId, plain.issueNumber)).toBeNull()
    expect(await repo().settlePromotion(plain.id, true)).toBe(false)
    expect(await repo().settlePromotion(pending.id, true)).toBe(true)
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({
      status: 'ready',
      promotionPending: false,
      promotionEventCursor: null,
      promotionPostAccepted: false,
      stateRevision: pending.stateRevision + 2n
    })
    expect(await repo().settlePromotion(pending.id, true)).toBe(false)
    expect(await repo().listRecoveryDue(boardId, NOW, 10)).toEqual([])
    expect(await repo().getPendingPromotion(boardId, pending.issueNumber)).toBeNull()

    const cleared = await begin(boardId)
    await cards.revertPromotion(cleared.id, cleared.stateRevision)
    expect(await repo().settlePromotion(cleared.id, false)).toBe(true)
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: cleared.id } })).toMatchObject({
      status: 'todo',
      promotionPending: false
    })
    // Any later status move settles a pending flag, so a stale one can never promote a card that came back to todo.
    const rev = cleared.stateRevision + 1n
    expect(await cards.beginPromotion(cleared.id, rev, 7n, NOW)).toBe(true)
    expect(await cards.revertPromotion(cleared.id, rev + 1n)).toBe(true)
    expect(await cards.casStatus(cleared.id, rev + 2n, 'blocked')).toBe(true)
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: cleared.id } })).promotionPending).toBe(false)
  })

  it('does not claim a ready card with an open promotion intent, and lists it for recovery', async () => {
    const boardId = await seedBoard()
    const c = await seedCard(boardId, { status: 'todo' })
    const cards = new PgKanbanCardRepo(prisma)
    const rev = (await prisma.kanbanCard.findUniqueOrThrow({ where: { id: c.id } })).stateRevision
    const startedAt = new Date('2026-10-16T00:00:00.000Z')
    expect(await cards.beginPromotion(c.id, rev, 99n, startedAt)).toBe(true)
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      status: 'ready',
      stateRevision: rev + 1n,
      promotionPending: true,
      promotionPostAccepted: false
    })
    // A stale revision or a card that is no longer todo loses the CAS and opens no intent.
    expect(await cards.beginPromotion(c.id, rev, 99n, startedAt)).toBe(false)
    expect(await repo().claim(boardId, live)).toEqual([])
    // The in-flight intent is not due yet, so a tick cannot settle it under the write.
    expect(await repo().listRecoveryDue(boardId, startedAt, 10)).toEqual([])
    const due = new Date(startedAt.getTime() + 60_000)
    expect(await repo().listRecoveryDue(boardId, due, 10)).toEqual([
      {
        cardId: c.id,
        issueNumber: c.issueNumber,
        promotion: true,
        promotionEventCursor: 99n,
        promotionPostAccepted: false,
        promotionStartedAt: startedAt,
        promotionChecks: 0,
        recoveryCheckAt: due
      }
    ])
    await cards.notePromotionPosted(c.id)
    expect(await repo().getPendingPromotion(boardId, c.issueNumber)).toMatchObject({ promotionPostAccepted: true })
    expect(await cards.clearPromotionIntent(c.id)).toBe(true)
    expect(await repo().claim(boardId, live)).toHaveLength(1)
  })

  it('counts pending-promotion checks on deferral, and escalates once to a human-only attention park', async () => {
    const boardId = await seedBoard()
    const cards = new PgKanbanCardRepo(prisma)
    const c = await begin(boardId)
    await cards.revertPromotion(c.id, c.stateRevision)
    await repo().deferRecovery(c.id, NOW, 'a')
    await repo().deferRecovery(c.id, NOW, 'b')
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      promotionChecks: 2,
      recoveryChecks: 1
    })
    expect(await repo().escalatePromotion(c.id, 'unattributed')).toBe(true)
    expect(await repo().escalatePromotion(c.id, 'unattributed')).toBe(false)
    const flagged = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: c.id } })
    expect(flagged).toMatchObject({
      status: 'todo',
      stateRevision: c.stateRevision + 2n,
      needsAttention: true,
      attentionReason: 'unattributed',
      promotionPending: false,
      promotionEventCursor: null,
      promotionChecks: 0,
      recoveryCheckAt: null
    })
    // A stale graph CAS from before the escalation cannot re-promote it.
    expect(await cards.beginPromotion(c.id, c.stateRevision + 1n, 1n, NOW)).toBe(false)
    expect(await repo().claim(boardId, live)).toEqual([])
    // It is parked like a mismatch: listed for recovery, ingestible only from its parked status, and cleared by the move.
    expect(await repo().listRecoveryDue(boardId, NOW, 10)).toMatchObject([{ cardId: c.id, promotion: false }])
    expect(await repo().getParkedStatus(boardId, c.issueNumber)).toBe('todo')
    await repo().deferRecovery(c.id, NOW)
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: c.id } })).promotionChecks).toBe(0)
    expect(await repo().ingestStatus(boardId, c.issueNumber, 'blocked', 'ready')).toBe(false)
    expect(await repo().ingestStatus(boardId, c.issueNumber, 'todo', 'ready')).toBe(true)
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      status: 'ready',
      needsAttention: false,
      attentionReason: null
    })
    expect(await repo().getParkedStatus(boardId, c.issueNumber)).toBeNull()
    expect(await repo().claim(boardId, live)).toHaveLength(1)
  })

  it('never lets a concurrent claim land between the ready CAS and the promotion intent', async () => {
    const boardId = await seedBoard()
    const cards = new PgKanbanCardRepo(prisma)
    const todo = await Promise.all(Array.from({ length: 8 }, () => seedCard(boardId, { status: 'todo' })))
    const claims: Promise<unknown[]>[] = []
    const begins = todo.map(async (c, i) => {
      if (i % 2 === 0) claims.push(repo().claim(boardId, live))
      return cards.beginPromotion(c.id, 1n, 5n, NOW)
    })
    expect(await Promise.all(begins)).toEqual(todo.map(() => true))
    claims.push(repo().claim(boardId, live))
    expect((await Promise.all(claims)).flat()).toEqual([])
    const rows = await prisma.kanbanCard.findMany({
      where: { boardId },
      select: { status: true, promotionPending: true }
    })
    expect(rows.every((r) => r.status === 'ready' && r.promotionPending)).toBe(true)
    expect(await prisma.kanbanRun.count()).toBe(0)
  })

  it('resets the backoff when the card is claimed again', async () => {
    const boardId = await seedBoard()
    const c = await park(boardId, 'blocked')
    await repo().deferRecovery(c.id, NOW)
    await prisma.kanbanCard.update({ where: { id: c.id }, data: { status: 'ready' } })
    expect(await repo().claim(boardId, live)).toHaveLength(1)
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      recoveryCheckAt: null,
      recoveryChecks: 0
    })
    expect(await repo().getParkedStatus(boardId, c.issueNumber)).toBeNull()
  })
})
