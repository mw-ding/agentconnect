import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { enabled, FULL, gh, ensureLabels, createIssue, closeIssues, record, repoRef } from '../fixtures/kanban-live.js'
import { liveSync } from '../fixtures/kanban-sync-live.js'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'

const DAEMON = 'd6666666-6666-4666-8666-666666666666'
const AGENT = 'a6666666-6666-4666-8666-666666666666'
const NEXT = 'a7777777-7777-4777-8777-777777777777'

describe.skipIf(!enabled)('Kanban human sync E2E (live GitHub)', () => {
  const issues: number[] = []
  const boards: string[] = []
  beforeAll(ensureLabels, 120_000)
  afterAll(async () => {
    await closeIssues(issues)
    await prisma.kanbanBoard.deleteMany({ where: { id: { in: boards } } })
    await prisma.agent.deleteMany({ where: { id: { in: [AGENT, NEXT] } } })
    await prisma.daemon.deleteMany({ where: { id: DAEMON } })
  }, 120_000)

  it.each(['todo', 'done'] as const)(
    'syncs a human relabel of a %s card to ready, reopening it when needed',
    async (status) => {
      const started = Date.now()
      const f = await liveSync()
      boards.push(f.board.id)
      const issue = await createIssue(issues, `sync ${status} to ready`, [`ac/status:${status}`])
      // Seeded directly: upsertCard's initial status is import policy, not a test seam.
      const card = await prisma.kanbanCard.create({
        data: { boardId: f.board.id, issueId: BigInt(issue.id), issueNumber: issue.number, status }
      })
      if (status === 'done')
        await gh('PATCH', `/repos/${FULL}/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' })
      await gh('PUT', `/repos/${FULL}/issues/${issue.number}/labels`, { labels: ['ac/status:ready'] })
      // GitHub adds ready and removes the old label as separate events; either may be the newest one.
      await expect
        .poll(
          async () =>
            (
              await f.store.managedEdits(
                { installationId: 1n, repoId: f.board.repoId, repoFullName: FULL },
                issue.number
              )
            ).status?.actor?.login,
          { timeout: 30_000 }
        )
        .toBe('mw-ding')
      await expect
        .poll(
          async () => {
            await f.ring(issue.number)
            return (await f.cards.getCard(card.id))?.status
          },
          { timeout: 30_000, interval: 500 }
        )
        .toBe('ready')
      expect(await gh('GET', `/repos/${FULL}/issues/${issue.number}`)).toMatchObject({ state: 'open' })
      record(`human ${status} to ready and reopen`, [issue.number], started)
    },
    120_000
  )

  it('refuses a relabel by an actor without write access, restoring the status with a comment', async () => {
    const started = Date.now()
    const f = await liveSync()
    boards.push(f.board.id)
    // One real account: the seam answers 'read' for the PAT's own login to model a triage/read collaborator.
    f.permission.override = 'read'
    const issue = await createIssue(issues, 'non-write relabel refused', ['ac/status:todo'])
    const card = await prisma.kanbanCard.create({
      data: { boardId: f.board.id, issueId: BigInt(issue.id), issueNumber: issue.number, status: 'todo' }
    })
    await gh('PUT', `/repos/${FULL}/issues/${issue.number}/labels`, { labels: ['ac/status:ready'] })
    // GitHub records the ready add and the todo removal separately; either may be the newest status event.
    await expect
      .poll(
        async () => {
          const e = (await f.store.managedEdits(repoRef, issue.number)).status
          return e?.label?.name === (e?.event === 'labeled' ? 'ac/status:ready' : 'ac/status:todo')
        },
        { timeout: 30_000, interval: 500 }
      )
      .toBe(true)
    await f.ring(issue.number)
    expect(f.permission.logins).toContain('mw-ding')
    await expect
      .poll(
        async () => {
          await f.ring(issue.number)
          return prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })
        },
        { timeout: 30_000, interval: 500 }
      )
      .toMatchObject({ status: 'todo', stateRevision: card.stateRevision, labelWritePending: false })
    const live = await gh<{ labels: { name: string }[] }>('GET', `/repos/${FULL}/issues/${issue.number}`)
    expect(live.labels.map((l) => l.name).filter((l) => l.startsWith('ac/status:'))).toEqual(['ac/status:todo'])
    const comments = await gh<{ body: string }[]>('GET', `/repos/${FULL}/issues/${issue.number}/comments`)
    expect(comments.some((c) => c.body.includes('only collaborators with write access'))).toBe(true)
    record('non-write relabel refused and reverted with comment', [issue.number], started)
  }, 120_000)

  it('repairs multi-status drift with one status and an explanatory comment', async () => {
    const started = Date.now()
    const f = await liveSync()
    boards.push(f.board.id)
    const issue = await createIssue(issues, 'multi-status drift', ['ac/status:todo'])
    await prisma.kanbanCard.create({
      data: { boardId: f.board.id, issueId: BigInt(issue.id), issueNumber: issue.number, status: 'todo' }
    })
    await gh('POST', `/repos/${FULL}/issues/${issue.number}/labels`, {
      labels: ['ac/status:ready', 'ac/status:blocked']
    })
    await expect
      .poll(
        async () => {
          await f.ring(issue.number)
          const live = await gh<{ labels: { name: string }[] }>('GET', `/repos/${FULL}/issues/${issue.number}`)
          return live.labels.map((l) => l.name).filter((l) => l.startsWith('ac/status:'))
        },
        { timeout: 30_000, interval: 500 }
      )
      .toEqual(['ac/status:todo'])
    const comments = await gh<{ body: string }[]>('GET', `/repos/${FULL}/issues/${issue.number}/comments`)
    expect(comments.some((c) => c.body.includes('exactly one status label'))).toBe(true)
    record('multi-status drift repaired with comment', [issue.number], started)
  }, 120_000)

  it.each(['ready', 'blocked'] as const)(
    'handles a leased human %s edit with a refusal or lease revocation',
    async (status) => {
      const started = Date.now()
      const f = await liveSync()
      boards.push(f.board.id)
      await seedDaemon(prisma, DAEMON)
      await seedAgent(prisma, AGENT, { daemonId: DAEMON })
      const issue = await createIssue(issues, `leased move ${status}`, ['ac/status:running'])
      const card = await prisma.kanbanCard.create({
        data: {
          boardId: f.board.id,
          issueId: BigInt(issue.id),
          issueNumber: issue.number,
          status: 'running',
          assigneeAgentId: AGENT
        }
      })
      const run = await prisma.kanbanRun.create({
        data: {
          cardId: card.id,
          attempt: 1,
          agentId: AGENT,
          daemonId: DAEMON,
          leaseId: crypto.randomUUID(),
          dispatchRevision: 1n,
          dispatchedAt: new Date()
        }
      })
      await gh('PUT', `/repos/${FULL}/issues/${issue.number}/labels`, { labels: [`ac/status:${status}`] })
      await expect
        .poll(
          async () => {
            await f.ring(issue.number)
            return (await f.cards.getCard(card.id))?.status
          },
          { timeout: 30_000, interval: 500 }
        )
        .toBe(status === 'ready' ? 'running' : 'blocked')
      const saved = await prisma.kanbanRun.findUniqueOrThrow({ where: { id: run.id } })
      if (status === 'blocked') {
        expect(saved.outcome).toBe('reclaimed')
        expect(f.revoked).toHaveLength(1)
      } else {
        expect(saved.endedAt).toBe(null)
        // The refusal posts the explanation after the label write lands; a lagging events read can defer a ring.
        await expect
          .poll(
            async () => {
              await f.ring(issue.number)
              const comments = await gh<{ body: string }[]>('GET', `/repos/${FULL}/issues/${issue.number}/comments`)
              return comments.some((c) => c.body.includes('leased to a running agent'))
            },
            { timeout: 30_000, interval: 500 }
          )
          .toBe(true)
      }
      record(`leased ${status}: ${status === 'ready' ? 'refused with comment' : 'revoked'}`, [issue.number], started)
    },
    120_000
  )

  it('reassigns ac/agent from a live human event, revoking the old lease and requesting a fresh session', async () => {
    const started = Date.now()
    const f = await liveSync()
    boards.push(f.board.id)
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedAgent(prisma, NEXT, { daemonId: DAEMON })
    await prisma.agent.update({ where: { id: AGENT }, data: { name: 'lane1-old' } })
    await prisma.agent.update({ where: { id: NEXT }, data: { name: 'lane1-next' } })
    for (const name of ['ac/agent:lane1-old', 'ac/agent:lane1-next']) {
      try {
        await gh('POST', `/repos/${FULL}/labels`, { name, color: 'ededed' })
      } catch (err) {
        if (!String(err).includes('422')) throw err
      }
    }
    const issue = await createIssue(issues, 'agent reassignment', ['ac/status:running', 'ac/agent:lane1-old'])
    const card = await prisma.kanbanCard.create({
      data: {
        boardId: f.board.id,
        issueId: BigInt(issue.id),
        issueNumber: issue.number,
        status: 'running',
        assigneeAgentId: AGENT
      }
    })
    const run = await prisma.kanbanRun.create({
      data: {
        cardId: card.id,
        attempt: 1,
        agentId: AGENT,
        daemonId: DAEMON,
        leaseId: crypto.randomUUID(),
        dispatchRevision: 1n,
        dispatchedAt: new Date()
      }
    })
    await gh('PUT', `/repos/${FULL}/issues/${issue.number}/labels`, {
      labels: ['ac/status:running', 'ac/agent:lane1-next']
    })
    await expect
      .poll(
        async () => {
          await f.ring(issue.number)
          return f.cards.getCard(card.id)
        },
        { timeout: 90_000, interval: 500 }
      )
      .toMatchObject({
        assigneeAgentId: NEXT,
        status: 'ready',
        dispatchRevision: 2n
      })
    expect(await prisma.kanbanRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      outcome: 'reclaimed',
      reasonCode: 'reassigned'
    })
    expect(f.revoked[0]?.leaseId).toBe(run.leaseId)
    const comments = await gh<{ body: string }[]>('GET', `/repos/${FULL}/issues/${issue.number}/comments`)
    expect(comments.some((c) => c.body.includes('reassigned from') && c.body.includes('new session'))).toBe(true)
    record('human agent reassignment revokes lease with restart comment', [issue.number], started)
  }, 120_000)
})
