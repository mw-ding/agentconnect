// Live GitHub + Postgres + in-process CP: Kanban M4 controls (issue #2 B5 pause/resume, skip, restart; B3 synthesizer).
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp, type App } from '../../src/app.js'
import { AppConfigSchema } from '../../src/config/env.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'
import type { Daemon } from '../../../daemon/src/daemon.js'
import type { KanbanWorker } from '../../../daemon/src/kanban/kanban-worker.js'
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
const PEPPER = 'kanban-m4-e2e-pepper-0123456789abcdef'
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
  let root: string | undefined
  let linkedApp: App | undefined
  let daemon: Daemon | undefined
  let worker: KanbanWorker | undefined
  let epoch = 0
  let httpClose: (() => Promise<void>) | undefined
  const pendingPrompts = new Map<string, () => void>()
  const prompts: Array<{ sid: string; text: string }> = []
  const host = {
    start: async () => {},
    newSession: async () => randomUUID(),
    loadSession: async () => {},
    modelOptions: () => null,
    hasSession: () => true,
    permissionModeOptions: () => ({ current: 'agent', modes: ['read-only', 'agent'] }),
    setSessionPermissionMode: async () => true,
    setSessionModel: async () => true,
    setSessionEffort: async () => true,
    setSessionFastMode: async () => true,
    prompt: async (sid: string, blocks: Array<{ text?: string }>) => {
      prompts.push({ sid, text: blocks.map((b) => b.text ?? '').join('\n') })
      await new Promise<void>((resolve) => pendingPrompts.set(sid, resolve))
      pendingPrompts.delete(sid)
      return { stopReason: 'end_turn' }
    },
    cancel: async () => {
      for (const resolve of pendingPrompts.values()) resolve()
    },
    forgetSession: () => {},
    stop: async () => {
      for (const resolve of pendingPrompts.values()) resolve()
    }
  }
  let sent: Array<{ daemonId: string; d: KanbanDispatch }>

  const store = new GithubCardStore({
    tokens: { mintKanbanCard: async () => ({ token: process.env.GITHUB_TOKEN! }) } as never
  })
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (o: unknown, m?: string) => {
      const err = (o as { err?: { name?: string; status?: number; code?: string } })?.err
      console.log('warn', m, { name: err?.name, status: err?.status, code: err?.code })
    }
  }

  const issue = (n: number) =>
    gh<{ state: string; state_reason: string | null; labels: Array<{ name: string }> }>(
      'GET',
      `/repos/${FULL}/issues/${n}`
    )
  const labelNames = async (n: number) => (await issue(n)).labels.map((l) => l.name).sort()
  const comments = (n: number) => gh<Array<{ body: string }>>('GET', `/repos/${FULL}/issues/${n}/comments`)

  async function startLinkedDaemon() {
    root = mkdtempSync(join(tmpdir(), 'kanban-m4-controls-'))
    const workspace = join(root, 'agents', AGENT, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(
      join(root, 'agents', AGENT, 'agent.json'),
      JSON.stringify({
        id: AGENT,
        name: 'kanban-m4-e2e',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: workspace },
        integrations: [],
        output: { mode: 'medium' }
      })
    )
    linkedApp = buildApp({
      prisma,
      config: AppConfigSchema.parse({
        DATABASE_URL: 'postgresql://e2e/ignored',
        API_KEY_PEPPER: PEPPER,
        RELAY_TOKEN: randomBytes(24).toString('hex'),
        SECRETS_PROVIDER: 'memory',
        NODE_ENV: 'test'
      }),
      clock: systemClock,
      secretsProvider: new MemorySecretsProvider()
    })
    const origin = await linkedApp.http.listen({ port: 0, host: '127.0.0.1' })
    linkedApp.mountWs()
    const minted = new ApiKeyCodec({ API_KEY_PEPPER: PEPPER }).mint()
    await prisma.apiKey.create({
      data: {
        principalType: 'daemon',
        orgId: DEFAULT_ORG_ID,
        daemonId: DAEMON,
        hash: minted.hash,
        displayTail: minted.displayTail
      }
    })
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: true, url: origin, key: minted.token },
        logging: { level: 'error' },
        runtimes: { claude: { command: 'node', args: ['unused'] } }
      })
    )
    const { Daemon } = await import('../../../daemon/src/daemon.js')
    daemon = new Daemon({ root, hostFactory: () => host as never })
    await daemon.start()
    worker = (daemon as any).kanbanWorker()
    await vi.waitFor(() => expect((daemon as any).cpClient?.state).toBe('READY'), { timeout: 20_000, interval: 250 })
    epoch = Number((await prisma.daemon.findUniqueOrThrow({ where: { id: DAEMON } })).sessionEpoch)
    ;(worker as any).deps.cp = () => ({
      ready: () => true,
      heartbeat: async (payload: { leases: Parameters<KanbanDispatcher['onHeartbeat']>[2] }) => ({
        superseded: await dispatcher.onHeartbeat(DAEMON, epoch, payload.leases)
      }),
      report: (report: KanbanReport) => dispatcher.onReport(DAEMON, epoch, report)
    })
  }

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
      await prisma.kanbanCard.deleteMany({ where: { boardId, issueNumber: result.issue ?? -1 } })
      await worker?.tick()
      await vi.waitFor(() => expect(pendingPrompts.size).toBe(0), { timeout: 10_000, interval: 100 })
    }
  }

  beforeAll(async () => {
    await ensureLabels()
    oidc = await startKanbanOidc('kanban-m4-controls-live')
  }, 120_000)

  afterAll(async () => {
    const cleanup = await Promise.allSettled([
      (async () => {
        await closeIssues(issues)
        for (const n of issues)
          await vi.waitFor(
            async () => expect(await issue(n)).toMatchObject({ state: 'closed', state_reason: 'not_planned' }),
            { timeout: 30_000, interval: 1_000 }
          )
        console.log(`KANBAN_M4_E2E_CLEANUP ${JSON.stringify(issues)}`)
      })(),
      (async () => {
        dispatcher?.stop()
        await dispatcher?.settle()
        await daemon?.stop()
        await httpClose?.()
        if (linkedApp) {
          await linkedApp.drainWs()
          await linkedApp.http.close()
        }
        if (root) rmSync(root, { recursive: true, force: true })
      })()
    ])
    await prisma.kanbanBoard.deleteMany({ where: { id: boardId } }).catch(() => {})
    await oidc?.close()
    for (const result of cleanup) if (result.status === 'rejected') throw result.reason
  }, 120_000)

  it('pause gates claims, skip archives and fences, restart resets, synthesizer promotes', async () => {
    await seedDaemon(prisma, DAEMON, { sessionEpoch: 4n })
    await seedAgent(prisma, AGENT, { daemonId: DAEMON, runtime: 'claude' })
    await startLinkedDaemon()
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
        return worker!.dispatch(d)
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
    httpClose = close
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
      const pause = await post(`/api/v1/orgs/${DEFAULT_ORG_ID}/kanban/boards/${boardId}/pause`)
      expect(pause.statusCode).toBe(200)

      await dispatcher.reconcileBoard(boardId)
      await dispatcher.settle()
      await dispatcher.reconcileBoard(boardId)
      await dispatcher.settle()
      expect(sent).toEqual([])
      expect(prompts).toEqual([])
      expect((await cardRow(c.number)).status).toBe('ready')

      const resume = await post(`/api/v1/orgs/${DEFAULT_ORG_ID}/kanban/boards/${boardId}/resume`)
      expect(resume.statusCode).toBe(200)
      expect(resume.json()).toMatchObject({ paused: false })

      await dispatcher.reconcileBoard(boardId)
      await dispatcher.settle()
      expect(sent.map(({ d }) => d.cardId)).toEqual([(await cardRow(c.number)).id])
      await vi.waitFor(() => expect(prompts).toHaveLength(1), { timeout: 30_000, interval: 100 })
      expect(prompts[0]!.text).toContain(String(c.number))
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

      await vi.waitFor(() => expect(pendingPrompts.size).toBe(1), { timeout: 30_000, interval: 100 })
      const skip = await post(
        `/api/v1/orgs/${DEFAULT_ORG_ID}/kanban/boards/${boardId}/cards/${(await cardRow(c.number)).id}/skip`
      )
      expect(skip.statusCode).toBe(200)
      expect(skip.json()).toMatchObject({ status: 'archived' })

      await vi.waitFor(
        async () => {
          expect((await issue(c.number)).state).toBe('closed')
          expect((await issue(c.number)).state_reason).toBe('not_planned')
          expect(await labelNames(c.number)).toEqual(['ac/status:archived'])
          const posted = await comments(c.number)
          expect(posted).toHaveLength(1)
          expect(posted[0]!.body).toContain('via AgentConnect')
        },
        { timeout: 60_000, interval: 1_000 }
      )
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
      expect((await dispatcher.onReport(DAEMON, epoch, late)).accepted).toBe(false)
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
      expect((await post(`/api/v1/orgs/${DEFAULT_ORG_ID}/kanban/boards/${boardId}/pause`)).statusCode).toBe(200)
      const restart = await post(`/api/v1/orgs/${DEFAULT_ORG_ID}/kanban/boards/${boardId}/cards/${card.id}/restart`)
      expect(restart.statusCode).toBe(200)
      expect(restart.json()).toMatchObject({ status: 'ready' })
      expect(await cardRow(c.number)).toMatchObject({ status: 'ready', consecutiveFailures: 0, blockKind: null })
      await vi.waitFor(async () => expect(await labelNames(c.number)).toEqual(['ac/status:ready']))

      const before = prompts.length
      expect((await post(`/api/v1/orgs/${DEFAULT_ORG_ID}/kanban/boards/${boardId}/resume`)).statusCode).toBe(200)
      await dispatcher.reconcileBoard(boardId)
      await dispatcher.settle()
      await vi.waitFor(() => expect(prompts.length).toBe(before + 1), { timeout: 30_000, interval: 100 })
      expect(sent.some(({ d }) => d.cardId === card.id && d.attempt >= 1)).toBe(true)
    })

    await scenario('y1 synthesizer promotes a completed epic', async (record) => {
      const epic = await createIssue(issues, 'lane3c y1 epic', ['ac/status:todo'])
      record(epic.number)
      const sub1 = await createIssue(issues, 'lane3c y1 sub1', [])
      const sub2 = await createIssue(issues, 'lane3c y1 sub2', [])
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
        agentSlug: async (orgId, id) =>
          (await prisma.agent.findFirst({ where: { orgId, id }, select: { name: true } }))?.name ?? null,
        cards: new PgKanbanCardRepo(prisma),
        store,
        log: { debug: vi.fn() }
      })
      const bell = new KanbanGraphDoorbell({
        boards: new PgKanbanBoardRepo(prisma),
        installations: { getByInstallationId: async () => installation },
        store,
        onCard: async (board, repo, n, action) => {
          if (action === 'closed') await reconciler.apply(board, repo, n, await store.readGraph(repo, n))
        },
        log: { debug: vi.fn(), warn: (_o, m) => console.log('warn', m) }
      })
      // A sub-issue closing re-reads its graph, whose parent is the epic.
      await vi.waitFor(
        async () => {
          bell.poke({
            deliveryKey: `y1-${Date.now()}`,
            installationId: '1',
            repoId: REPO_ID.toString(),
            event: 'issues',
            action: 'closed',
            ids: [String(sub2.id)],
            numbers: [sub2.number]
          })
          await bell.settle()
          expect(await cardRow(epic.number)).toMatchObject({ status: 'ready', assigneeAgentId: SYNTH })
        },
        { timeout: 60_000, interval: 2_000 }
      )
      await vi.waitFor(
        async () => expect(await labelNames(epic.number)).toEqual(['ac/agent:synthesizer', 'ac/status:ready']),
        { timeout: 60_000, interval: 2_000 }
      )
      expect(epicCard.id).toBeTruthy()
    })

    for (const r of results) console.log(`KANBAN_M4_E2E_RESULT ${JSON.stringify(r)}`)
    const failed = results.filter((r) => !r.pass)
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([])
  }, 600_000)
})
