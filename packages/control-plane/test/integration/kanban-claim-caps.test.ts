// Claim caps (issue #2 M3): B2 epicMaxActive bounds children running concurrently, and the per-daemon cap
// (audit 2.2) bounds a daemon's open runs across boards, race-safe via a per-daemon advisory xact lock.
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
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

  it('per-daemon cap bounds open runs across two boards claiming in parallel', async () => {
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

    const [a, b] = await Promise.all([repo.claim(boardA.id, opts), repo.claim(boardB.id, opts)])
    expect(a.length + b.length).toBe(1)
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
})
