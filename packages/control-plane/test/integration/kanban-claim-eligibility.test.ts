// The pure claim-eligibility predicate agrees with the SQL claim gate-for-gate on real Postgres.
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import { explainClaim, type ClaimAgentFacts, type ClaimEligibilityInput } from '../../src/kanban/claim-eligibility.js'
import type { KanbanStatus } from '../../src/kanban/card-state.js'

const D1 = 'd1111111-1111-4111-8111-111111111111'
const D2 = 'd2222222-2222-4222-8222-222222222222'
const A1 = 'a1111111-1111-4111-8111-111111111111'
const A2 = 'a2222222-2222-4222-8222-222222222222'
const A3 = 'a3333333-3333-4333-8333-333333333333'
const A4 = 'a4444444-4444-4444-8444-444444444444'
const MISSING = 'a9999999-9999-4999-8999-999999999999'
const REPO_ID = 987654321n
const NOW = new Date('2026-10-15T12:00:00.000Z')
const LIVE = new Set([D1])

async function board(maxInProgress = 100, maxPerAgent = 100, enabled = true, verifierAgentId: string | null = null) {
  return prisma.kanbanBoard.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      name: 'parity',
      // One board per repository per org, so each extra board takes the next repo id.
      repoId: REPO_ID + BigInt(await prisma.kanbanBoard.count()),
      repoFullName: 'acme/web',
      maxInProgress,
      maxInProgressPerAgent: maxPerAgent,
      enabled,
      verifierAgentId
    }
  })
}

/** A run on a card: an ended work run by default, or an open one when `open` is set. */
async function run(
  cardId: string,
  attempt: number,
  agentId: string,
  opts: { open?: boolean; role?: 'work' | 'verify' } = {}
) {
  return prisma.kanbanRun.create({
    data: {
      cardId,
      attempt,
      agentId,
      daemonId: D1,
      role: opts.role ?? 'work',
      leaseId: randomUUID(),
      dispatchRevision: BigInt(attempt),
      dispatchedAt: NOW,
      endedAt: opts.open ? null : NOW,
      mode: 'read'
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
      ...data
    }
  })
}

/** A card whose assignee names no agent row: the FK makes a normal create impossible, so insert with triggers off. */
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

/** The same facts the SQL claim reads, reconstructed from the database for one card. */
async function factsFor(boardId: string, cardId: string): Promise<ClaimEligibilityInput> {
  const b = await prisma.kanbanBoard.findUniqueOrThrow({ where: { id: boardId } })
  const c = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: cardId } })
  const agentFor = async (agentId: string | null): Promise<ClaimAgentFacts | null> => {
    if (!agentId) return null
    const agent = await prisma.agent.findUnique({ where: { id: agentId } })
    if (!agent) return null
    return {
      exists: true,
      paused: agent.status === 'paused',
      daemonId: agent.daemonId,
      daemonLive: agent.daemonId !== null && LIVE.has(agent.daemonId)
    }
  }
  const open = await prisma.kanbanRun.findMany({
    where: { endedAt: null, card: { boardId } },
    select: { agentId: true }
  })
  return {
    board: {
      enabled: b.enabled,
      verifierAgentId: b.verifierAgentId,
      maxInProgress: b.maxInProgress,
      maxInProgressPerAgent: b.maxInProgressPerAgent
    },
    card: {
      status: c.status,
      assigneeAgentId: c.assigneeAgentId,
      promotionPending: c.promotionPending,
      cooldownUntil: c.cooldownUntil,
      notBefore: c.notBefore,
      verifiedAt: c.verifiedAt,
      needsAttention: c.needsAttention,
      hasOpenLease: (await prisma.kanbanRun.count({ where: { cardId, endedAt: null } })) > 0
    },
    assignee: await agentFor(c.assigneeAgentId),
    verifier: await agentFor(b.verifierAgentId),
    workAgentIds: (
      await prisma.kanbanRun.findMany({ where: { cardId, role: 'work' }, orderBy: { attempt: 'asc' } })
    ).map((r) => r.agentId),
    openRunCount: open.length,
    openRunCountForAssignee: open.filter((r) => r.agentId === c.assigneeAgentId).length,
    openRunCountForVerifier: open.filter((r) => r.agentId === b.verifierAgentId).length,
    now: NOW
  }
}

/** Snapshot every card's facts, run one claim, and assert the predicate's verdict (and gate) matches what SQL did. */
async function expectParity(boardId: string, cards: Record<string, { id: string }>, expected: Record<string, string>) {
  const repo = new PgKanbanDispatchRepo(prisma)
  const snapshots = new Map<string, ClaimEligibilityInput>()
  for (const c of Object.values(cards)) snapshots.set(c.id, await factsFor(boardId, c.id))
  const claimed = await repo.claim(boardId, { now: NOW, isDaemonLive: (id) => LIVE.has(id) })
  const leases = new Map(claimed.leases.map((l) => [l.cardId, l]))
  for (const [name, c] of Object.entries(cards)) {
    const verdict = explainClaim(snapshots.get(c.id)!)
    const lease = leases.get(c.id)
    expect(
      verdict.eligible === (lease !== undefined),
      `card ${name}: explainClaim said ${verdict.eligible ? 'eligible' : `gate ${verdict.gate}`} but SQL ${lease ? 'claimed' : 'skipped'} it`
    ).toBe(true)
    if (verdict.eligible) expect(verdict, name).toEqual({ eligible: true, role: lease!.role, agentId: lease!.agentId })
    expect(verdict.eligible ? 'eligible' : verdict.gate, name).toBe(expected[name])
  }
  return claimed
}

describe('claim eligibility parity (real Postgres)', () => {
  it('vera-414: agrees with the SQL claim on review cards routed to the verifier', async () => {
    await seedDaemon(prisma, D1, { sessionEpoch: 1n })
    await seedDaemon(prisma, D2, { sessionEpoch: 1n })
    await seedAgent(prisma, A1, { daemonId: D1 })
    await seedAgent(prisma, A2, { daemonId: D1 })
    await seedAgent(prisma, A3, { daemonId: D1 })
    await prisma.agent.update({ where: { id: A3 }, data: { status: 'paused' } })
    await seedAgent(prisma, A4, { daemonId: D2 })

    const unset = await board(100, 100, true, null)
    await expectParity(
      unset.id,
      { verifier_unset: await card(unset.id, 1, { status: 'review' }) },
      {
        verifier_unset: 'verifier_unset'
      }
    )

    const live = await board(100, 100, true, A2)
    const pastWorker = await card(live.id, 3, { status: 'review' })
    await run(pastWorker.id, 1, A2)
    // The verifier wrote attempt 1 and someone else the latest attempt: B8 still refuses it.
    const earlierWorker = await card(live.id, 5, { status: 'review' })
    await run(earlierWorker.id, 1, A2)
    await run(earlierWorker.id, 2, A1)
    const claimed = await expectParity(
      live.id,
      {
        verify: await card(live.id, 1, { status: 'review' }),
        work: await card(live.id, 2),
        latest_worker: pastWorker,
        earlier_worker: earlierWorker,
        parked_review: await card(live.id, 6, {
          status: 'review',
          needsAttention: true,
          attentionReason: 'verifier_is_worker'
        }),
        parked_ready: await card(live.id, 7, { needsAttention: true, attentionReason: 'unresolved' }),
        verified: await card(live.id, 4, { status: 'review', verifiedAt: NOW })
      },
      {
        verify: 'eligible',
        work: 'eligible',
        latest_worker: 'verifier_is_worker',
        earlier_worker: 'verifier_is_worker',
        parked_review: 'needs_attention',
        parked_ready: 'needs_attention',
        verified: 'verified'
      }
    )
    expect(claimed.flaggedSelfVerify.map((f) => f.cardId).sort()).toEqual([pastWorker.id, earlierWorker.id].sort())

    const self = await board(100, 100, true, A1)
    await expectParity(
      self.id,
      { assignee: await card(self.id, 1, { status: 'review' }) },
      {
        assignee: 'verifier_is_worker'
      }
    )

    const paused = await board(100, 100, true, A3)
    await expectParity(
      paused.id,
      { paused: await card(paused.id, 1, { status: 'review' }) },
      {
        paused: 'agent_paused'
      }
    )

    const offline = await board(100, 100, true, A4)
    await expectParity(
      offline.id,
      { offline: await card(offline.id, 1, { status: 'review' }) },
      {
        offline: 'daemon_offline'
      }
    )

    // The verifier already holds its one share on this board, so a second review card waits.
    const capped = await board(100, 1, true, A2)
    const held = await card(capped.id, 1, { status: 'review' })
    await run(held.id, 1, A2, { open: true, role: 'verify' })
    await expectParity(
      capped.id,
      { held, at_cap: await card(capped.id, 2, { status: 'review' }) },
      {
        held: 'open_lease',
        at_cap: 'agent_cap'
      }
    )
  })

  it('agrees with the SQL claim for one card per gate plus eligible cards', async () => {
    await seedDaemon(prisma, D1, { sessionEpoch: 1n })
    await seedDaemon(prisma, D2, { sessionEpoch: 1n })
    await seedAgent(prisma, A1, { daemonId: D1 })
    await seedAgent(prisma, A2, { daemonId: D1 })
    await prisma.agent.update({ where: { id: A2 }, data: { status: 'paused' } })
    await seedAgent(prisma, A3)
    await seedAgent(prisma, A4, { daemonId: D2 })

    const b = await board()
    const cards = {
      eligible: await card(b.id, 1),
      status_not_claimable: await card(b.id, 2, { status: 'todo' }),
      no_assignee: await card(b.id, 3, { assigneeAgentId: null }),
      agent_missing: await danglingAssigneeCard(b.id, 4),
      agent_paused: await card(b.id, 5, { assigneeAgentId: A2 }),
      agent_unplaced: await card(b.id, 6, { assigneeAgentId: A3 }),
      daemon_offline: await card(b.id, 7, { assigneeAgentId: A4 }),
      cooldown: await card(b.id, 8, { cooldownUntil: new Date(NOW.getTime() + 60_000) }),
      not_before: await card(b.id, 9, { notBefore: new Date(NOW.getTime() + 60_000) }),
      promotion_pending: await card(b.id, 10, { promotionPending: true })
    }

    const repo = new PgKanbanDispatchRepo(prisma)
    // Snapshot the facts first: the claim flips a claimed card to `running`, which would change its verdict.
    const snapshots = new Map<string, ClaimEligibilityInput>()
    for (const c of Object.values(cards)) snapshots.set(c.id, await factsFor(b.id, c.id))
    const claimed = await repo.claim(b.id, { now: NOW, isDaemonLive: (id) => LIVE.has(id) })
    const claimedIds = new Set(claimed.leases.map((l) => l.cardId))

    for (const [name, c] of Object.entries(cards)) {
      const verdict = explainClaim(snapshots.get(c.id)!)
      const wasClaimed = claimedIds.has(c.id)
      expect(
        verdict.eligible === wasClaimed,
        `card ${name}: explainClaim said ${verdict.eligible ? 'eligible' : `gate ${verdict.gate}`} but SQL ${wasClaimed ? 'claimed' : 'skipped'} it`
      ).toBe(true)
      if (verdict.eligible) expect(verdict).toEqual({ eligible: true, role: 'work', agentId: A1 })
    }

    // The board's total is one (the eligible card): nothing else was claimed.
    expect(claimed.leases).toHaveLength(1)
  })

  it('explains a disabled board and never claims from it', async () => {
    await seedDaemon(prisma, D1, { sessionEpoch: 1n })
    await seedAgent(prisma, A1, { daemonId: D1 })
    const b = await board(100, 100, false)
    const c = await card(b.id, 1)
    const repo = new PgKanbanDispatchRepo(prisma)
    expect((await repo.claim(b.id, { now: NOW, isDaemonLive: () => true })).leases).toEqual([])
    expect(explainClaim(await factsFor(b.id, c.id))).toEqual({ eligible: false, gate: 'board_disabled' })
  })

  it('reports board_cap when the board is full of open runs', async () => {
    await seedDaemon(prisma, D1, { sessionEpoch: 1n })
    await seedAgent(prisma, A1, { daemonId: D1 })
    const b = await board(1, 100)
    const held = await card(b.id, 1)
    await prisma.kanbanCard.update({ where: { id: held.id }, data: { status: 'running' } })
    await prisma.kanbanRun.create({
      data: {
        cardId: held.id,
        attempt: 1,
        agentId: A1,
        daemonId: D1,
        leaseId: 'b1111111-1111-4111-8111-111111111111',
        dispatchRevision: 1n,
        dispatchedAt: NOW,
        mode: 'read'
      }
    })
    const waiting = await card(b.id, 2)
    const repo = new PgKanbanDispatchRepo(prisma)
    expect((await repo.claim(b.id, { now: NOW, isDaemonLive: () => true })).leases).toEqual([])
    expect(explainClaim(await factsFor(b.id, waiting.id))).toEqual({ eligible: false, gate: 'board_cap' })
  })

  it('reports agent_cap when the assignee already holds a full share of open runs', async () => {
    await seedDaemon(prisma, D1, { sessionEpoch: 1n })
    await seedAgent(prisma, A1, { daemonId: D1 })
    const b = await board(100, 1)
    const held = await card(b.id, 1)
    await prisma.kanbanCard.update({ where: { id: held.id }, data: { status: 'running' } })
    await prisma.kanbanRun.create({
      data: {
        cardId: held.id,
        attempt: 1,
        agentId: A1,
        daemonId: D1,
        leaseId: 'c1111111-1111-4111-8111-111111111111',
        dispatchRevision: 1n,
        dispatchedAt: NOW,
        mode: 'read'
      }
    })
    const waiting = await card(b.id, 2)
    const repo = new PgKanbanDispatchRepo(prisma)
    expect((await repo.claim(b.id, { now: NOW, isDaemonLive: () => true })).leases).toEqual([])
    expect(explainClaim(await factsFor(b.id, waiting.id))).toEqual({ eligible: false, gate: 'agent_cap' })
  })
})
