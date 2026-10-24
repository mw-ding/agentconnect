// Comment-command and PR-contract status moves commit their anchor-channel outbox row in the move's own transaction (#454).
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { PgKanbanCardRepo } from '../../src/persistence/repositories/kanban.repo.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import { attestHumanAuthority } from '../../src/kanban/human-authority.js'
import type { KanbanStatus } from '../../src/kanban/card-state.js'

async function harness(headless = false) {
  const board = await prisma.kanbanBoard.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      name: 'notify-moves',
      repoId: 454n,
      repoFullName: 'acme/web',
      completionContract: 'pr_merged',
      targetPlatform: 'slack',
      targetChannel: headless ? null : 'C0ANCHOR'
    }
  })
  let issue = 1
  const card = (status: KanbanStatus, data: Record<string, unknown> = {}) => {
    const n = issue++
    return prisma.kanbanCard.create({
      data: { boardId: board.id, issueId: BigInt(n), issueNumber: n, status, ...data }
    })
  }
  const rows = (cardId: string) =>
    prisma.kanbanNotification.findMany({ where: { cardId }, orderBy: { stateRevision: 'asc' } })
  const command = (
    db: ConstructorParameters<typeof PgKanbanCardRepo>[0],
    c: { id: string; stateRevision: bigint },
    from: KanbanStatus,
    commentId: bigint,
    command: 'unblock' | 'reopen' | 'ready' = 'unblock',
    refusal?: string
  ) =>
    new PgKanbanCardRepo(db).recordCommand({
      boardId: board.id,
      cardId: c.id,
      commentId,
      command,
      humanAuthority: refusal ? undefined : attestHumanAuthority('octocat', 'write'),
      actorLogin: 'octocat',
      from,
      expectedStateRevision: c.stateRevision,
      ...(refusal ? { refusal: refusal as 'wrong_status' } : { to: 'ready' as const })
    })
  const settle = (
    db: ConstructorParameters<typeof PgKanbanDispatchRepo>[0],
    c: { id: string; stateRevision: bigint },
    to: 'done' | 'triage'
  ) =>
    new PgKanbanDispatchRepo(db).settleContract({
      cardId: c.id,
      expectedStateRevision: c.stateRevision,
      expectedConfigRevision: board.configRevision,
      to,
      reason: to === 'done' ? 'pr_merged' : 'pr_closed_unmerged',
      prNumber: 7
    })
  return { board, card, rows, command, settle }
}

describe('#454 comment-command moves write one notification row', () => {
  it.each([
    ['unblock', 'blocked'],
    ['reopen', 'done'],
    ['ready', 'todo']
  ] as const)('/kanban %s writes one row at stateRevision + 1 in the move transaction', async (name, from) => {
    const h = await harness()
    const c = await h.card(from)
    expect(await h.command(prisma, c, from, 454_001n, name)).toMatchObject({ kind: 'recorded' })
    expect(await h.rows(c.id)).toMatchObject([
      {
        stateRevision: c.stateRevision + 1n,
        fromStatus: from,
        toStatus: 'ready',
        reasonCode: 'comment_command',
        mention: false
      }
    ])
  })

  it('a replayed delivery and a refusal write no row', async () => {
    const h = await harness()
    const c = await h.card('blocked')
    await h.command(prisma, c, 'blocked', 454_002n)
    expect(await h.command(prisma, c, 'blocked', 454_002n)).toMatchObject({ kind: 'duplicate' })
    expect(await h.rows(c.id)).toHaveLength(1)
    const other = await h.card('review')
    expect(await h.command(prisma, other, 'review', 454_003n, 'unblock', 'wrong_status')).toMatchObject({
      kind: 'recorded'
    })
    expect(await h.rows(other.id)).toEqual([])
  })

  it('a stale CAS writes no row', async () => {
    const h = await harness()
    const c = await h.card('blocked')
    expect(await h.command(prisma, { id: c.id, stateRevision: 99n }, 'blocked', 454_004n)).toEqual({ kind: 'stale' })
    expect(await h.rows(c.id)).toEqual([])
  })

  it('a headless board writes no row', async () => {
    const h = await harness(true)
    const c = await h.card('blocked')
    expect(await h.command(prisma, c, 'blocked', 454_005n)).toMatchObject({ kind: 'recorded' })
    expect(await h.rows(c.id)).toEqual([])
  })

  it('a rollback after the move removes the row with it', async () => {
    const h = await harness()
    const c = await h.card('blocked')
    await expect(
      prisma.$transaction(async (tx) => {
        await h.command(tx, c, 'blocked', 454_006n)
        expect(await tx.kanbanNotification.count({ where: { cardId: c.id } })).toBe(1)
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(await h.rows(c.id)).toEqual([])
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: 'blocked' })
  })
})

describe('#454 PR-contract settles write one notification row', () => {
  it.each(['done', 'triage'] as const)('a settle to %s writes one row at stateRevision + 1', async (to) => {
    const h = await harness()
    const c = await h.card('review', { linkedPrNumber: 7 })
    expect(await h.settle(prisma, c, to)).toBe(true)
    expect(await h.rows(c.id)).toMatchObject([
      { stateRevision: c.stateRevision + 1n, fromStatus: 'review', toStatus: to, mention: false }
    ])
  })

  it('a refused settle (stale revision) and a replay write no extra row', async () => {
    const h = await harness()
    const c = await h.card('review', { linkedPrNumber: 7 })
    expect(await h.settle(prisma, { id: c.id, stateRevision: 99n }, 'done')).toBe(false)
    expect(await h.rows(c.id)).toEqual([])
    expect(await h.settle(prisma, c, 'done')).toBe(true)
    expect(await h.settle(prisma, c, 'done')).toBe(false)
    expect(await h.rows(c.id)).toHaveLength(1)
  })

  it('a headless board writes no row', async () => {
    const h = await harness(true)
    const c = await h.card('review', { linkedPrNumber: 7 })
    expect(await h.settle(prisma, c, 'done')).toBe(true)
    expect(await h.rows(c.id)).toEqual([])
  })

  it('a rollback after the settle removes the row with it', async () => {
    const h = await harness()
    const c = await h.card('review', { linkedPrNumber: 7 })
    await expect(
      prisma.$transaction(async (tx) => {
        expect(await h.settle(tx, c, 'done')).toBe(true)
        expect(await tx.kanbanNotification.count({ where: { cardId: c.id } })).toBe(1)
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(await h.rows(c.id)).toEqual([])
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: 'review' })
  })
})
