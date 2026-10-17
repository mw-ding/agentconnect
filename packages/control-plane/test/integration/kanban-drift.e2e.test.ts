import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { enabled, FULL, gh, ensureLabels, createIssue, closeIssues, record } from '../fixtures/kanban-live.js'
import { liveSync } from '../fixtures/kanban-sync-live.js'
import { prisma } from '../setup.db.js'

describe.skipIf(!enabled)('Kanban drift and graph E2E (live GitHub)', () => {
  const issues: number[] = []
  const boards: string[] = []
  beforeAll(ensureLabels, 120_000)
  afterAll(async () => {
    await closeIssues(issues)
    await prisma.kanbanBoard.deleteMany({ where: { id: { in: boards } } })
  }, 120_000)

  it('repairs a failed CP label projection on the existing dispatcher tick', async () => {
    const started = Date.now()
    const f = await liveSync()
    boards.push(f.board.id)
    const issue = await createIssue(issues, 'failed projection drift', ['ac/status:ready'])
    const card = await prisma.kanbanCard.create({
      data: {
        boardId: f.board.id,
        issueId: BigInt(issue.id),
        issueNumber: issue.number,
        status: 'review',
        labelWritePending: true
      }
    })
    await f.dispatcher.tick()
    await f.dispatcher.settle()
    expect(await f.cards.getCard(card.id)).toMatchObject({ status: 'review' })
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).labelWritePending).toBe(false)
    const current = await gh<{ labels: { name: string }[] }>('GET', `/repos/${FULL}/issues/${issue.number}`)
    expect(current.labels.map((l) => l.name).filter((l) => l.startsWith('ac/status:'))).toEqual(['ac/status:review'])
    record('dispatcher tick repairs committed status after failed GitHub write', [issue.number], started)
  }, 120_000)

  it.each(['closed_doorbell', 'tick'] as const)(
    'promotes a dependent after its blocker completes via %s',
    async (source) => {
      const started = Date.now()
      const f = await liveSync()
      boards.push(f.board.id)
      const blocker = await createIssue(issues, `blocker ${source}`, ['ac/status:todo'])
      const dependent = await createIssue(issues, `dependent ${source}`, ['ac/status:todo'])
      await gh('POST', `/repos/${FULL}/issues/${dependent.number}/dependencies/blocked_by`, { issue_id: blocker.id })
      const { card } = await f.cards.upsertCard({
        boardId: f.board.id,
        issueId: BigInt(dependent.id),
        issueNumber: dependent.number,
        status: 'todo',
        source: 'e2e'
      })
      await gh('PATCH', `/repos/${FULL}/issues/${blocker.number}`, { state: 'closed', state_reason: 'completed' })
      if (source === 'closed_doorbell') await f.ring(blocker.number, 'closed')
      else await f.dispatcher.tick()
      await f.dispatcher.settle()
      expect((await f.cards.getCard(card.id))?.status).toBe('ready')
      const audit = await prisma.auditEvent.findMany({ where: { kind: 'kanban_card_change' } })
      expect(
        audit.some(
          (row) =>
            (row.details as { change?: string; from?: string; to?: string }).change === 'status' &&
            (row.details as { to?: string }).to === 'ready'
        )
      ).toBe(true)
      record(`completed blocker promotes dependent through ${source}`, [blocker.number, dependent.number], started)
    },
    120_000
  )
})
