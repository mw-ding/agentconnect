// Live GitHub + Postgres + in-process CP: Kanban M4 controls (issue #2 B5 pause/resume, skip, restart; B3 synthesizer).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { KanbanDispatch, KanbanReport } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { systemClock } from '../../src/domain/clock.js'
import { KanbanControls } from '../../src/kanban/controls.js'
import { KanbanDispatcher } from '../../src/kanban/dispatcher.js'
import { KanbanGraphDoorbell } from '../../src/kanban/graph-doorbell.js'
import { KanbanGraphReconciler } from '../../src/kanban/graph-reconciler.js'
import { GithubCardStore } from '../../src/kanban/card-store.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import { PgKanbanBoardRepo, PgKanbanCardRepo } from '../../src/persistence/repositories/kanban.repo.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { prisma } from '../setup.db.js'
import { startKanbanOidc, ownerBearer, type KanbanOidc } from '../fixtures/kanban-oidc.js'
import {
  enabled,
  FULL,
  REPO_ID,
  gh,
  createIssue,
  closeIssues,
  ensureLabels,
  installation
} from '../fixtures/kanban-live.js'

const DAEMON = 'd0000000-0000-4000-8000-000000000003'
const AGENT = 'a0000000-0000-4000-8000-000000000003'
const SYNTH = 'a0000000-0000-4000-8000-000000000004'

interface ScenarioResult {
  name: string
  pass: boolean
  issue?: number
  ms: number
  error?: string
}

describe.skipIf(!enabled)('kanban M4 controls e2e (live GitHub)', () => {
  const started = Date.now()
  const results: ScenarioResult[] = []
  const issues: number[] = []
  let oidc: KanbanOidc
  let boardId = ''
  let headers: Record<string, string>
  let controls: KanbanControls
  let dispatcher: KanbanDispatcher
  let sent: Array<{ daemonId: string; d: KanbanDispatch }>

  const store = new GithubCardStore({
    tokens: { mintKanbanCard: async () => ({ token: process.env.GITHUB_TOKEN! }) } as never
  })
  const log = { debug: vi.fn(), info: vi.fn(), warn: (_o: unknown, m?: string) => console.log('warn', m) }

  const issue = (n: number) =>
    gh<{ state: string; state_reason: string | null; labels: Array<{ name: string }> }>(
      'GET',
      `/repos/${FULL}/issues/${n}`
    )
  const labelNames = async (n: number) => (await issue(n)).labels.map((l) => l.name).sort()
  const comments = (n: number) => gh<Array<{ body: string }>>('GET', `/repos/${FULL}/issues/${n}/comments`)

  async function scenario(name: string, fn: (record: (n: number) => void) => Promise<void>) {
    const t0 = Date.now()
    const result: ScenarioResult = { name, pass: false, ms: 0 }
    try {
      await fn((n) => (result.issue = n))
      result.pass = true
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err)
      console.error(`KANBAN_M4_E2E scenario failed: ${name}`, err)
    } finally {
      result.ms = Date.now() - t0
      results.push(result)
      console.log(`KANBAN_M4_E2E_RESULT ${JSON.stringify(result)}`)
    }
  }

  beforeAll(async () => {
    await ensureLabels()
    oidc = await startKanbanOidc('kanban-m4-controls-live')
  }, 120_000)

  afterAll(async () => {
    const cleanup = await Promise.allSettled([
      closeIssues(issues),
      (async () => {
        dispatcher?.stop()
        await dispatcher?.settle()
      })()
    ])
    await prisma.kanbanBoard.deleteMany({ where: { id: boardId } }).catch(() => {})
    await oidc.close()
    for (const result of cleanup) if (result.status === 'rejected') throw result.reason
  }, 120_000)

  it('pause gates claims, skip archives and fences, restart resets, synthesizer promotes', async () => {
    await seedDaemon(prisma, DAEMON, { sessionEpoch: 4n })
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedAgent(prisma, SYNTH, { daemonId: DAEMON, name: 'synthesizer' })
    boardId = (
      await prisma.kanbanBoard.create({
        data: {
          orgId: DEFAULT_ORG_ID,
          name: `m4-controls ${started}`,
          repoId: REPO_ID,
          repoFullName: FULL,
          synthesizerAgentId: SYNTH
        }
      })
    ).id

    const repo = new PgKanbanDispatchRepo(prisma)
    sent = []
    dispatcher = new KanbanDispatcher({
      repo,
      installations: { liveByOrgAndAccount: async () => installation },
      store,
      send: async (daemonId, d) => {
        sent.push({ daemonId, d })
        return { leaseId: d.leaseId, accepted: true }
      },
      isDaemonLive: () => true,
      clock: systemClock,
      log
    })

    controls = new KanbanControls({
      boards: new PgKanbanBoardRepo(prisma),
      cards: new PgKanbanCardRepo(prisma),
      installations: { liveByOrgAndAccount: async () => installation },
      store,
      resolveLogin: async () => 'mw-ding',
      poke: (boardId) => dispatcher.poke(boardId),
      log
    })

    const { app, close } = buildHttpApp(
      prisma,
      { OIDC_ISSUER: oidc.issuer, OIDC_AUDIENCE: oidc.audience },
      undefined,
      undefined,
      { kanbanControls: controls }
    )
    headers = await ownerBearer(prisma, oidc)
    const post = (url: string) => app.inject({ method: 'POST', url, headers })

    const cardRow = (issueNumber: number) =>
      prisma.kanbanCard.findUniqueOrThrow({ where: { boardId_issueNumber: { boardId, issueNumber } } })

    await scenario('p1 pause gates and resume re-arms', async (record) => {
      const c = await createIssue(issues, 'lane3c p1', ['ac/status:ready'])
      record(c.number)
      await prisma.kanbanCard.create({
        data: { boardId, issueId: BigInt(c.id), issueNumber: c.number, status: 'ready', assigneeAgentId: AGENT }
      })
      await prisma.kanbanBoard.update({ where: { id: boardId }, data: { paused: true, pausedAt: new Date() } })

      await dispatcher.reconcileBoard(boardId)
      await dispatcher.settle()
      expect(sent).toEqual([])
      expect((await cardRow(c.number)).status).toBe('ready')

      const resume = await post(`/api/v1/orgs/${DEFAULT_ORG_ID}/kanban/boards/${boardId}/resume`)
      expect(resume.statusCode).toBe(200)
      expect(resume.json()).toMatchObject({ paused: false })

      await dispatcher.reconcileBoard(boardId)
      await dispatcher.settle()
      expect(sent.map(({ d }) => d.cardId)).toEqual([(await cardRow(c.number)).id])
    })

    await scenario('s1 skip archives, closes not_planned, and fences the lease', async (record) => {
      const c = await createIssue(issues, 'lane3c s1', ['ac/status:ready'])
      record(c.number)
      await prisma.kanbanCard.create({
        data: { boardId, issueId: BigInt(c.id), issueNumber: c.number, status: 'ready', assigneeAgentId: AGENT }
      })
      await dispatcher.reconcileBoard(boardId)
      await dispatcher.settle()
      const run = await prisma.kanbanRun.findFirstOrThrow({
        where: { cardId: (await cardRow(c.number)).id, endedAt: null }
      })

      const skip = await post(
        `/api/v1/orgs/${DEFAULT_ORG_ID}/kanban/boards/${boardId}/cards/${(await cardRow(c.number)).id}/skip`
      )
      expect(skip.statusCode).toBe(200)
      expect(skip.json()).toMatchObject({ status: 'archived' })

      await vi.waitFor(async () => {
        expect((await issue(c.number)).state).toBe('closed')
        expect((await issue(c.number)).state_reason).toBe('not_planned')
        expect(await labelNames(c.number)).toEqual(['ac/status:archived'])
        const posted = await comments(c.number)
        expect(posted).toHaveLength(1)
        expect(posted[0]!.body).toContain('via AgentConnect')
      })
      expect((await prisma.kanbanRun.findUniqueOrThrow({ where: { id: run.id } })).outcome).toBe('reclaimed')
      // The superseded lease's late report fails the fence.
      const late: KanbanReport = {
        boardId,
        cardId: (await cardRow(c.number)).id,
        agentId: AGENT,
        leaseId: run.leaseId,
        attempt: run.attempt,
        dispatchRevision: run.dispatchRevision.toString(),
        outcome: 'completed'
      }
      expect((await dispatcher.onReport(DAEMON, 4, late)).accepted).toBe(false)
    })

    await scenario('r1 restart resets counters and re-dispatches', async (record) => {
      const c = await createIssue(issues, 'lane3c r1', ['ac/status:triage'])
      record(c.number)
      const card = await prisma.kanbanCard.create({
        data: {
          boardId,
          issueId: BigInt(c.id),
          issueNumber: c.number,
          status: 'triage',
          assigneeAgentId: AGENT,
          consecutiveFailures: 2,
          blockKind: 'needs_input'
        }
      })
      const restart = await post(`/api/v1/orgs/${DEFAULT_ORG_ID}/kanban/boards/${boardId}/cards/${card.id}/restart`)
      expect(restart.statusCode).toBe(200)
      expect(restart.json()).toMatchObject({ status: 'ready' })
      expect(await cardRow(c.number)).toMatchObject({ status: 'ready', consecutiveFailures: 0, blockKind: null })
      await vi.waitFor(async () => expect(await labelNames(c.number)).toEqual(['ac/status:ready']))

      await dispatcher.reconcileBoard(boardId)
      await dispatcher.settle()
      expect(sent.some(({ d }) => d.cardId === card.id && d.attempt >= 1)).toBe(true)
    })

    await scenario('y1 synthesizer promotes a completed epic', async (record) => {
      const epic = await createIssue(issues, 'lane3c y1 epic', ['ac/status:todo'])
      record(epic.number)
      const sub1 = await gh<{ id: number; number: number }>('POST', `/repos/${FULL}/issues`, {
        title: `[kanban-e2e] lane3c y1 sub1 ${started}`,
        body: 'scratch sub-issue'
      })
      const sub2 = await gh<{ id: number; number: number }>('POST', `/repos/${FULL}/issues`, {
        title: `[kanban-e2e] lane3c y1 sub2 ${started}`,
        body: 'scratch sub-issue'
      })
      issues.push(sub1.number, sub2.number)
      await gh('POST', `/repos/${FULL}/issues/${epic.number}/sub_issues`, { sub_issue_id: sub1.id })
      await gh('POST', `/repos/${FULL}/issues/${epic.number}/sub_issues`, { sub_issue_id: sub2.id })
      const epicCard = await prisma.kanbanCard.create({
        data: { boardId, issueId: BigInt(epic.id), issueNumber: epic.number, status: 'todo' }
      })

      await vi.waitFor(
        async () => {
          const subs = await gh<Array<{ number: number }>>('GET', `/repos/${FULL}/issues/${epic.number}/sub_issues`)
          expect(subs.map((s) => s.number).sort()).toEqual([sub1.number, sub2.number].sort())
        },
        { timeout: 30_000, interval: 1_000 }
      )

      await gh('PATCH', `/repos/${FULL}/issues/${sub1.number}`, { state: 'closed', state_reason: 'completed' })
      await gh('PATCH', `/repos/${FULL}/issues/${sub2.number}`, { state: 'closed', state_reason: 'completed' })

      const reconciler = new KanbanGraphReconciler({
        cards: new PgKanbanCardRepo(prisma),
        store,
        log: { debug: vi.fn() }
      })
      const bell = new KanbanGraphDoorbell({
        boards: new PgKanbanBoardRepo(prisma),
        installations: { getByInstallationId: async () => installation },
        store,
        onGraph: (board, repo, n, graph) => reconciler.apply(board, repo, n, graph),
        log: { debug: vi.fn(), warn: (_o, m) => console.log('warn', m) }
      })
      // A sub-issue closing re-reads its graph, whose parent is the epic.
      bell.poke({
        deliveryKey: 'y1',
        installationId: '1',
        repoId: REPO_ID.toString(),
        event: 'issue_dependencies',
        action: 'blocked_by_added',
        ids: [],
        numbers: [sub1.number]
      })
      await bell.settle()

      await vi.waitFor(
        async () => {
          expect(await cardRow(epic.number)).toMatchObject({ status: 'ready', assigneeAgentId: SYNTH })
        },
        { timeout: 60_000, interval: 2_000 }
      )
      await vi.waitFor(async () => expect(await labelNames(epic.number)).toEqual(['ac/status:ready']), {
        timeout: 60_000,
        interval: 2_000
      })
      expect(epicCard.id).toBeTruthy()
    })

    for (const r of results) console.log(`KANBAN_M4_E2E_RESULT ${JSON.stringify(r)}`)
    const failed = results.filter((r) => !r.pass)
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([])
    await close()
  }, 600_000)
})
