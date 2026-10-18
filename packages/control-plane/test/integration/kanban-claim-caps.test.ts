// Claim caps serialize cross-board daemon counts and bound active epic children.
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import type { Prisma } from '../../src/generated/prisma/client.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { prisma } from '../setup.db.js'

const REPO_ID = 990002n

describe('PgKanbanDispatchRepo claim caps (real Postgres)', () => {
  it('epicMaxActive skips a ready child while its epic already has enough open runs', async () => {
    const daemonId = randomUUID()
    const agentId = randomUUID()
    await seedDaemon(prisma, daemonId, { sessionEpoch: 1n })
    await seedAgent(prisma, agentId, { daemonId })
    const board = await prisma.kanbanBoard.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        name: 'caps-epic',
        repoId: REPO_ID,
        repoFullName: 'acme/web',
        maxInProgress: 10,
        maxInProgressPerAgent: 10,
        epicMaxActive: 1
      }
    })
    const epic = await prisma.kanbanCard.create({
      data: { boardId: board.id, issueId: 9_001n, issueNumber: 1, status: 'todo' }
    })
    const mk = (issueNumber: number) =>
      prisma.kanbanCard.create({
        data: {
          boardId: board.id,
          issueId: BigInt(9_000 + issueNumber),
          issueNumber,
          status: 'ready',
          assigneeAgentId: agentId,
          epicCardId: epic.id
        }
      })
    const c1 = await mk(2)
    const c2 = await mk(3)
    const repo = new PgKanbanDispatchRepo(prisma)
    const opts = { now: new Date(), isDaemonLive: () => true }

    const first = await repo.claim(board.id, opts)
    expect(first.map((l) => l.cardId)).toEqual([c1.id])
    // The epic now has one open run (c1); c2 is ready but the epic is at its active cap.
    const second = await repo.claim(board.id, opts)
    expect(second).toEqual([])
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: c2.id } })).status).toBe('ready')
  })

  it('vera-349: per-daemon cap serializes overlapping claims until the first transaction commits', async () => {
    const daemonId = randomUUID()
    await seedDaemon(prisma, daemonId, { sessionEpoch: 1n })
    const mk = async (boardId: string, issueNumber: number) => {
      const agentId = randomUUID()
      await seedAgent(prisma, agentId, { daemonId })
      return prisma.kanbanCard.create({
        data: {
          boardId,
          issueId: BigInt(9_500 + issueNumber),
          issueNumber,
          status: 'ready',
          assigneeAgentId: agentId
        }
      })
    }
    const boardA = await prisma.kanbanBoard.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        name: 'caps-a',
        repoId: REPO_ID,
        repoFullName: 'acme/web',
        maxInProgress: 10,
        maxInProgressPerAgent: 10
      }
    })
    const boardB = await prisma.kanbanBoard.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        name: 'caps-b',
        repoId: REPO_ID + 1n,
        repoFullName: 'acme/api',
        maxInProgress: 10,
        maxInProgressPerAgent: 10
      }
    })
    await mk(boardA.id, 1)
    await mk(boardB.id, 1)
    const repo = new PgKanbanDispatchRepo(prisma)
    const opts = { now: new Date(), isDaemonLive: () => true, maxPerDaemon: 1 }

    let releaseA!: () => void
    const barrier = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    let readyA!: () => void
    const claimedA = new Promise<void>((resolve) => {
      readyA = resolve
    })
    let pidA = 0
    const claimA = prisma.$transaction(async (tx) => {
      pidA = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid
      const leases = await new PgKanbanDispatchRepo(tx).claim(boardA.id, opts)
      expect(leases).toHaveLength(1)
      readyA()
      await barrier
      return leases
    })
    let claimB: Promise<unknown> | undefined
    let completedB = false
    let pidB = 0
    try {
      await claimedA
      claimB = prisma
        .$transaction(async (tx) => {
          pidB = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid
          return new PgKanbanDispatchRepo(tx).claim(boardB.id, opts)
        })
        .then((leases) => {
          completedB = true
          return leases
        })
      await vi.waitFor(
        async () => {
          expect(completedB).toBe(false)
          expect(pidB).toBeGreaterThan(0)
          const [state] = await prisma.$queryRaw<
            Array<{ blockers: number[] }>
          >`SELECT pg_blocking_pids(${pidB}::int) AS blockers`
          expect(state!.blockers).toContain(pidA)
        },
        { timeout: 2_000, interval: 10 }
      )
    } finally {
      releaseA()
      await claimA
      if (claimB) await claimB
    }
    expect(completedB).toBe(true)
    expect(await claimB).toEqual([])
    expect(await prisma.kanbanRun.count({ where: { daemonId, endedAt: null } })).toBe(1)
  })

  it('per-daemon cap counts open runs across boards, not just the claimed one', async () => {
    const daemonId = randomUUID()
    await seedDaemon(prisma, daemonId, { sessionEpoch: 1n })
    const mk = async (boardId: string, issueNumber: number) => {
      const agentId = randomUUID()
      await seedAgent(prisma, agentId, { daemonId })
      return prisma.kanbanCard.create({
        data: {
          boardId,
          issueId: BigInt(9_800 + issueNumber),
          issueNumber,
          status: 'ready',
          assigneeAgentId: agentId
        }
      })
    }
    const boardA = await prisma.kanbanBoard.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        name: 'caps2-a',
        repoId: REPO_ID + 2n,
        repoFullName: 'acme/web',
        maxInProgress: 10,
        maxInProgressPerAgent: 10
      }
    })
    const boardB = await prisma.kanbanBoard.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        name: 'caps2-b',
        repoId: REPO_ID + 3n,
        repoFullName: 'acme/api',
        maxInProgress: 10,
        maxInProgressPerAgent: 10
      }
    })
    await mk(boardA.id, 1)
    await mk(boardB.id, 1)
    const repo = new PgKanbanDispatchRepo(prisma)
    // Cap of 2: first board claims its one, second board also fits.
    const opts = { now: new Date(), isDaemonLive: () => true, maxPerDaemon: 2 }
    const a = await repo.claim(boardA.id, opts)
    const b = await repo.claim(boardB.id, opts)
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    // With no cap, a board with room claims freely.
    const uncapped = await repo.claim(boardA.id, { now: new Date(), isDaemonLive: () => true })
    expect(uncapped).toEqual([]) // its only card is already running
  })
  it('per-daemon cap skips a candidate whose agent moved to a daemon the claim did not lock', async () => {
    const locked = randomUUID()
    const moved = randomUUID()
    await seedDaemon(prisma, locked, { sessionEpoch: 1n })
    await seedDaemon(prisma, moved, { sessionEpoch: 1n })
    const stays = randomUUID()
    const mover = randomUUID()
    await seedAgent(prisma, stays, { daemonId: locked })
    await seedAgent(prisma, mover, { daemonId: locked })
    const board = await prisma.kanbanBoard.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        name: 'caps-moved',
        repoId: REPO_ID + 4n,
        repoFullName: 'acme/moved',
        maxInProgress: 10,
        maxInProgressPerAgent: 10
      }
    })
    const mk = (issueNumber: number, agentId: string, priority: number) =>
      prisma.kanbanCard.create({
        data: {
          boardId: board.id,
          issueId: BigInt(9_900 + issueNumber),
          issueNumber,
          status: 'ready',
          priority,
          assigneeAgentId: agentId
        }
      })
    const kept = await mk(1, stays, 2)
    const skipped = await mk(2, mover, 1)
    // Between the advisory-lock pass and the candidate scan, the second agent moves to a daemon nobody locked.
    const leases = await prisma.$transaction(async (tx) => {
      let moveDone = false
      // Hiding $transaction makes the repo run on this client instead of opening its own transaction.
      const spy = new Proxy(tx, {
        has: (target, prop) => prop !== '$transaction' && Reflect.has(target, prop),
        get(target, prop, receiver) {
          if (prop !== '$queryRaw') return Reflect.get(target, prop, receiver)
          return async (...args: unknown[]) => {
            const first = args[0] as { sql?: string } | TemplateStringsArray
            const text =
              'sql' in first && typeof first.sql === 'string' ? first.sql : [...(first as string[])].join('?')
            if (!moveDone && text.includes('"sessionEpoch"') && text.includes('SKIP LOCKED')) {
              moveDone = true
              await prisma.agent.update({ where: { id: mover }, data: { daemonId: moved } })
            }
            return (target.$queryRaw as (...a: unknown[]) => Promise<unknown>)(...args)
          }
        }
      }) as Prisma.TransactionClient
      return new PgKanbanDispatchRepo(spy).claim(board.id, {
        now: new Date(),
        isDaemonLive: () => true,
        maxPerDaemon: 8
      })
    })
    expect(leases.map((l) => l.cardId)).toEqual([kept.id])
    expect(await prisma.kanbanRun.count({ where: { daemonId: moved, endedAt: null } })).toBe(0)
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: skipped.id } })).status).toBe('ready')
    // The next claim locks the new daemon and admits the card.
    const next = await new PgKanbanDispatchRepo(prisma).claim(board.id, {
      now: new Date(),
      isDaemonLive: () => true,
      maxPerDaemon: 8
    })
    expect(next.map((l) => l.cardId)).toEqual([skipped.id])
  })
})
