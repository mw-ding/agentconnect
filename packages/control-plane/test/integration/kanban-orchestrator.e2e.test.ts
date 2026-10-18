// Live GitHub and Postgres exercise real daemon orchestration and a held fake ACP worker turn.
import { randomBytes, randomUUID } from 'node:crypto'
import type { KanbanReport } from '@agentconnect.md/protocol'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { buildApp, type App } from '../../src/app.js'
import { AppConfigSchema } from '../../src/config/env.js'
import { systemClock } from '../../src/domain/clock.js'
import { GithubCardStore } from '../../src/kanban/card-store.js'
import { KanbanDispatcher } from '../../src/kanban/dispatcher.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'
import type { Daemon } from '../../../daemon/src/daemon.js'
import type { KanbanWorker } from '../../../daemon/src/kanban/kanban-worker.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { prisma } from '../setup.db.js'

const TOKEN = process.env.GITHUB_TOKEN
const enabled = !process.env.CI && process.env.KANBAN_E2E === '1' && !!TOKEN
const OWNER = 'mw-ding'
const FULL = `${OWNER}/agentconnect`
const REPO_ID = 1332342098n
const PEPPER = 'kanban-e2e-pepper-0123456789abcdef'
const INSTALLATION_ID = 424242n

async function gh<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status}`)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

interface Issue {
  id: number
  number: number
  title: string
  body?: string | null
  state: string
  state_reason: string | null
  labels: Array<{ name: string }>
}

interface ScenarioResult {
  name: string
  ms: number
  pass: boolean
  error?: string
  issues?: number[]
}

describe.skipIf(!enabled)('kanban orchestrator e2e (live GitHub)', () => {
  const started = Date.now()
  const daemonId = randomUUID()
  const agentId = randomUUID()
  const workerId = randomUUID()
  const otherAgentId = randomUUID()
  const issues: number[] = []
  const results: ScenarioResult[] = []
  let boardId = ''
  let epicIssue = 0
  let aIssue = 0
  let bIssue = 0
  let root: string | undefined
  let daemon: Daemon | undefined
  let app: App | undefined
  let cpOrigin = ''
  let dispatcher: KanbanDispatcher | undefined
  let releaseTurn: (() => void) | undefined
  let script = async () => {}
  const phase = (name: string, observed: unknown = {}) =>
    console.log(`${new Date().toISOString()} +${Date.now() - started}ms ${name}`, observed)

  const issue = (number: number) => gh<Issue>('GET', `/repos/${FULL}/issues/${number}`)
  const labelNames = async (number: number) => (await issue(number)).labels.map((l) => l.name).sort()

  beforeAll(async () => {
    phase('setup: live repository and human token')
    expect(BigInt((await gh<{ id: number }>('GET', `/repos/${FULL}`)).id)).toBe(REPO_ID)
    const existing = new Set<string>()
    for (let page = 1; ; page++) {
      const labels = await gh<Array<{ name: string }>>('GET', `/repos/${FULL}/labels?per_page=100&page=${page}`)
      for (const label of labels) existing.add(label.name)
      if (labels.length < 100) break
    }
    for (const status of ['triage', 'todo', 'ready', 'running', 'review', 'done', 'blocked']) {
      const name = `ac/status:${status}`
      expect(existing.has(name), `required repository label ${name}`).toBe(true)
    }
    // Reuse existing labels so the E2E writes only to its scratch issues.
    for (const slug of ['lane1-next', 'lane1-old']) {
      const name = `ac/agent:${slug}`
      expect(existing.has(name), `required repository label ${name}`).toBe(true)
    }
    root = mkdtempSync(join(tmpdir(), 'kanban-orch-e2e-'))
    for (const [id, name] of [
      [agentId, 'lane1-next'],
      [workerId, 'lane1-old']
    ]) {
      const workspace = join(root, 'agents', id!, 'workspace')
      mkdirSync(workspace, { recursive: true })
      writeFileSync(
        join(root, 'agents', id!, 'agent.json'),
        JSON.stringify({
          id,
          name,
          runtime: 'claude',
          workspace: { mode: 'from-scratch', path: workspace },
          integrations: [],
          output: { mode: 'medium' }
        })
      )
    }
    app = buildApp({
      prisma,
      config: AppConfigSchema.parse({
        DATABASE_URL: 'postgresql://e2e/ignored',
        API_KEY_PEPPER: PEPPER,
        RELAY_TOKEN: randomBytes(24).toString('hex'),
        SECRETS_PROVIDER: 'memory',
        NODE_ENV: 'test'
      }),
      clock: systemClock,
      secretsProvider: new MemorySecretsProvider(),
      kanbanAccessToken: TOKEN!
    })
    cpOrigin = await app.http.listen({ port: 0, host: '127.0.0.1' })
    app.mountWs()
    phase('setup: control plane listening', { cpOrigin })
  }, 120_000)

  afterAll(async () => {
    const cleanup = await Promise.allSettled([
      (async () => {
        releaseTurn?.()
        dispatcher?.stop()
        await dispatcher?.settle()
        await daemon?.stop()
      })(),
      ...issues.map(async (number) => {
        await gh('PATCH', `/repos/${FULL}/issues/${number}`, { state: 'closed', state_reason: 'not_planned' })
        phase('cleanup: closed not_planned', { issue: number })
      })
    ])
    if (root) rmSync(root, { recursive: true, force: true })
    if (app) {
      await app.drainWs()
      await app.http.close()
    }
    for (const result of cleanup) if (result.status === 'rejected') throw result.reason
  }, 120_000)

  async function startLinkedDaemon(): Promise<void> {
    const minted = new ApiKeyCodec({ API_KEY_PEPPER: PEPPER }).mint()
    await prisma.apiKey.create({
      data: {
        principalType: 'daemon',
        orgId: DEFAULT_ORG_ID,
        daemonId,
        hash: minted.hash,
        displayTail: minted.displayTail
      }
    })
    writeFileSync(
      join(root!, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: true, url: cpOrigin, key: minted.token },
        logging: { level: 'error' },
        runtimes: { claude: { command: 'node', args: ['unused'] } }
      })
    )
    const { Daemon } = await import('../../../daemon/src/daemon.js')
    daemon = new Daemon({ root, hostFactory: () => host as never })
    await daemon.start()
    await vi.waitFor(() => expect((daemon as any).cpClient?.state).toBe('READY'), { timeout: 20_000, interval: 250 })
    // No App: the PAT stands in for the orchestrator's issues-only token, exactly like the worker harness's comment token.
    ;(daemon as any).gitCreds.getKanbanOrchestratorToken = async () => ({ token: TOKEN! })
    phase('setup: daemon connected over the CP WebSocket')
  }

  const host = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => randomUUID()),
    loadSession: vi.fn(async () => {}),
    modelOptions: () => null,
    hasSession: () => true,
    permissionModeOptions: () => ({ current: 'agent', modes: ['read-only', 'agent'] }),
    setSessionPermissionMode: vi.fn(async () => true),
    setSessionModel: async () => true,
    setSessionEffort: async () => true,
    setSessionFastMode: async () => true,
    prompt: vi.fn(async () => {
      await script()
      return { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(async () => {
      releaseTurn?.()
    }),
    forgetSession: () => {},
    stop: async () => {}
  }

  const orch = (
    name: 'kanbanCreate' | 'kanbanList' | 'kanbanLink' | 'kanbanUnblock' | 'kanbanAssign',
    args: Record<string, unknown>
  ) => (daemon as any).mcp.deps[name]({ agentId, ...args })

  async function scenario(name: string, fn: () => Promise<number[] | undefined>) {
    const t0 = Date.now()
    const result: ScenarioResult = { name, ms: 0, pass: false }
    try {
      result.issues = (await fn()) ?? []
      result.pass = true
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err)
      console.error(`KANBAN_ORCH_E2E scenario failed: ${name}`, err)
    } finally {
      result.ms = Date.now() - t0
      results.push(result)
      phase(`scenario ${result.pass ? 'PASS' : 'FAIL'}: ${name}`, result)
    }
  }

  const waitFor = (fn: () => Promise<void>, timeout = 45_000) => vi.waitFor(fn, { timeout, interval: 1_000 })

  const subIssueNumbers = async (n: number) =>
    (await gh<Issue[]>('GET', `/repos/${FULL}/issues/${n}/sub_issues?per_page=100`))
      .map((i) => i.number)
      .sort((x, y) => x - y)
  const blockedByNumbers = async (n: number) =>
    (await gh<Issue[]>('GET', `/repos/${FULL}/issues/${n}/dependencies/blocked_by?per_page=100`))
      .map((i) => i.number)
      .sort((x, y) => x - y)

  it('drives the orchestrator tools end to end against real GitHub', async () => {
    await seedDaemon(prisma, daemonId, { sessionEpoch: 1n })
    await seedAgent(prisma, agentId, { daemonId, name: 'lane1-next' })
    await seedAgent(prisma, workerId, { daemonId, name: 'lane1-old' })
    await seedAgent(prisma, otherAgentId, { daemonId, name: 'other-e2e' })
    await prisma.githubInstallation.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        installationId: INSTALLATION_ID,
        accountLogin: OWNER,
        accountType: 'User',
        repositorySelection: 'selected',
        permissions: { issues: 'write', metadata: 'read' }
      }
    })
    await startLinkedDaemon()
    boardId = (
      await prisma.kanbanBoard.create({
        data: {
          orgId: DEFAULT_ORG_ID,
          name: `orch-e2e ${started}`,
          repoId: REPO_ID,
          repoFullName: FULL,
          orchestratorAgentId: agentId,
          epicMaxCards: 2
        }
      })
    ).id

    // o1 create: an epic issue+card, then children A and B (B blocked_by A, assignee lane1-old).
    await scenario('o1 create epic + children A/B', async () => {
      const epic = await gh<Issue>('POST', `/repos/${FULL}/issues`, { title: `[kanban-e2e] orch epic ${started}` })
      epicIssue = epic.number
      issues.push(epicIssue)
      const epicCard = await prisma.kanbanCard.create({
        data: { boardId, issueId: BigInt(epic.id), issueNumber: epic.number, status: 'todo' }
      })
      const a = await orch('kanbanCreate', {
        board: boardId,
        title: `[kanban-e2e] orch child A ${started}`,
        body: 'child A body',
        epic: epicIssue,
        step: 'child-a',
        assignee: 'lane1-old'
      })
      expect(a).toMatchObject({ created: true })
      aIssue = a.issueNumber as number
      issues.push(aIssue)
      const b = await orch('kanbanCreate', {
        board: boardId,
        title: `[kanban-e2e] orch child B ${started}`,
        body: 'child B body',
        epic: epicIssue,
        step: 'child-b',
        assignee: 'lane1-old',
        blockedBy: [aIssue]
      })
      expect(b).toMatchObject({ created: true })
      bIssue = b.issueNumber as number
      issues.push(bIssue)
      await waitFor(async () => {
        expect(await labelNames(aIssue)).toEqual(['ac/agent:lane1-old', 'ac/status:todo'])
        expect(await labelNames(bIssue)).toEqual(['ac/agent:lane1-old', 'ac/status:todo'])
      })
      const dbCards = await prisma.kanbanCard.findMany({
        where: { boardId, issueNumber: { in: [aIssue, bIssue] } },
        select: { idempotencyKey: true, epicCardId: true }
      })
      expect(dbCards.every((c) => c.idempotencyKey !== null && c.epicCardId === epicCard.id)).toBe(true)
      expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: epicCard.id } })).epicCardsCreated).toBe(2)
      // Neither create is partial: the sub-issue and blocked_by writes (addressed by numeric issue id) landed on GitHub.
      expect(a.partial).toBeUndefined()
      expect(b.partial).toBeUndefined()
      await waitFor(async () => {
        expect(await subIssueNumbers(epicIssue)).toEqual([aIssue, bIssue].sort((x, y) => x - y))
        expect(await blockedByNumbers(bIssue)).toEqual([aIssue])
      })
      return [epicIssue, aIssue, bIssue]
    })

    // o2 replay: the same create returns the existing card, no new issue.
    await scenario('o2 replay', async () => {
      const again = await orch('kanbanCreate', {
        board: boardId,
        title: `[kanban-e2e] orch child A ${started}`,
        body: 'child A body',
        epic: epicIssue,
        step: 'child-a',
        assignee: 'lane1-old'
      })
      expect(again).toMatchObject({ existing: true, issueNumber: aIssue })
      const matches = (await gh<Issue[]>('GET', `/repos/${FULL}/issues?state=all&per_page=100`)).filter(
        (i) => i.title === `[kanban-e2e] orch child A ${started}`
      )
      expect(matches).toHaveLength(1)
      return [aIssue]
    })

    // o3 budget: epicMaxCards=2, a third child is refused and the epic moves to triage.
    await scenario('o3 budget', async () => {
      const third = await orch('kanbanCreate', {
        board: boardId,
        title: `[kanban-e2e] orch child C ${started}`,
        body: 'child C body',
        epic: epicIssue,
        step: 'child-c'
      })
      expect(third).toMatchObject({ refused: expect.stringContaining('budget') })
      const epicCard = await prisma.kanbanCard.findUniqueOrThrow({
        where: { boardId_issueNumber: { boardId, issueNumber: epicIssue } }
      })
      await waitFor(async () => {
        expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: epicCard.id } })).status).toBe('triage')
        expect(await labelNames(epicIssue)).toEqual(['ac/status:triage'])
      })
      return [epicIssue]
    })

    // o4 role gate: a non-orchestrator agent's create is refused, nothing filed.
    await scenario('o4 role gate', async () => {
      const denied = await (daemon as any).mcp.deps.kanbanCreate({
        agentId: otherAgentId,
        board: boardId,
        title: `[kanban-e2e] orch denied ${started}`,
        body: 'nope'
      })
      expect(denied).toMatchObject({ refused: expect.stringContaining('not the orchestrator') })
      return []
    })

    // o5 link/unblock: refusals, then a real blocked_by edge added by kanbanLink and removed by kanbanUnblock.
    await scenario('o5 link/unblock', async () => {
      const missing = await orch('kanbanLink', { board: boardId, issue: bIssue, blockedBy: [999999] })
      expect(missing).toMatchObject({ refused: expect.any(String) })
      const self = await orch('kanbanLink', { board: boardId, issue: bIssue, blockedBy: [bIssue] })
      expect(self).toMatchObject({ refused: expect.stringContaining('self-link') })
      expect(await orch('kanbanLink', { board: boardId, issue: bIssue, blockedBy: [epicIssue] })).toEqual({
        linked: true
      })
      await waitFor(async () =>
        expect(await blockedByNumbers(bIssue)).toEqual([aIssue, epicIssue].sort((x, y) => x - y))
      )
      expect(await orch('kanbanUnblock', { board: boardId, issue: bIssue, blockers: [epicIssue] })).toMatchObject({
        unblocked: true
      })
      await waitFor(async () => expect(await blockedByNumbers(bIssue)).toEqual([aIssue]))
      expect(await orch('kanbanUnblock', { board: boardId, issue: bIssue })).toMatchObject({ unblocked: true })
      await waitFor(async () => expect(await blockedByNumbers(bIssue)).toEqual([]))
      return [bIssue]
    })

    // o6 assign: unleased reassign mirrors the ac/agent label and null clears it.
    await scenario('o6 assign', async () => {
      await orch('kanbanAssign', { board: boardId, issue: aIssue, assignee: null })
      await waitFor(async () => expect(await labelNames(aIssue)).toEqual(['ac/status:todo']))
      await orch('kanbanAssign', { board: boardId, issue: aIssue, assignee: 'lane1-old' })
      await waitFor(async () => expect(await labelNames(aIssue)).toEqual(['ac/agent:lane1-old', 'ac/status:todo']))
      return [aIssue]
    })

    // o7 masking: a seeded model secret never reaches GitHub.
    await scenario('o7 masking', async () => {
      const apiKey = 'sk-e2e-model-api-key-secret'
      ;(daemon as any).modelProviderSecrets.set(agentId, [{ name: 'MODEL_API_KEY', value: apiKey }])
      const masked = await orch('kanbanCreate', {
        board: boardId,
        title: `[kanban-e2e] orch masked ${started}`,
        body: `leak ${apiKey}`,
        step: 'masked'
      })
      expect(masked).toMatchObject({ created: true })
      issues.push(masked.issueNumber as number)
      const body = await gh<{ body: string }>('GET', `/repos/${FULL}/issues/${masked.issueNumber}`)
      expect(body.body).not.toContain(apiKey)
      expect(body.body).toContain('[secret:MODEL_API_KEY]')
      return [masked.issueNumber as number]
    })

    await scenario('X2 leased reassign', async () => {
      const created = await orch('kanbanCreate', {
        board: boardId,
        title: `[kanban-e2e] orch leased reassign ${started}`,
        body: 'Scratch held worker turn for leased reassignment.',
        step: 'leased-reassign',
        assignee: 'lane1-old'
      })
      expect(created).toMatchObject({ created: true })
      const number = created.issueNumber as number
      issues.push(number)
      const worker: KanbanWorker = (daemon as any).kanbanWorker()
      const epoch = Number((await prisma.daemon.findUniqueOrThrow({ where: { id: daemonId } })).sessionEpoch)
      dispatcher = new KanbanDispatcher({
        repo: new PgKanbanDispatchRepo(prisma),
        installations: {
          liveByOrgAndAccount: async () =>
            ({
              installationId: INSTALLATION_ID,
              revokedAt: null,
              suspendedAt: null
            }) as never
        },
        store: new GithubCardStore({ tokens: { mintKanbanCard: async () => ({ token: TOKEN! }) } as never }),
        send: async (id, dispatch) => {
          expect(id).toBe(daemonId)
          return worker.dispatch(dispatch)
        },
        isDaemonLive: (id) => id === daemonId,
        clock: systemClock,
        log: { debug: () => {}, info: () => {}, warn: (_o: unknown, m?: string) => phase(`WARN ${m ?? ''}`) }
      })
      const heartbeat = vi.fn(async (payload: { leases: Parameters<KanbanDispatcher['onHeartbeat']>[2] }) => ({
        superseded: await dispatcher!.onHeartbeat(daemonId, epoch, payload.leases)
      }))
      ;(worker as any).deps.cp = () => ({
        ready: () => true,
        heartbeat,
        report: (report: KanbanReport) => dispatcher!.onReport(daemonId, epoch, report)
      })
      const held = new Promise<void>((resolve) => {
        releaseTurn = resolve
      })
      script = () => held
      const promptsBefore = host.prompt.mock.calls.length
      const card = await prisma.kanbanCard.update({
        where: { boardId_issueNumber: { boardId, issueNumber: number } },
        data: { status: 'ready' }
      })
      await gh('PATCH', `/repos/${FULL}/issues/${number}`, { labels: ['ac/status:ready', 'ac/agent:lane1-old'] })
      // Pause the target to observe revocation without another claim racing the assertions.
      await prisma.agent.update({ where: { id: agentId }, data: { status: 'paused' } })
      try {
        await dispatcher.reconcileBoard(boardId)
        await waitFor(async () => {
          expect(host.prompt.mock.calls.length).toBe(promptsBefore + 1)
          expect(await prisma.kanbanRun.count({ where: { cardId: card.id, endedAt: null } })).toBe(1)
        })
        const run = await prisma.kanbanRun.findFirstOrThrow({ where: { cardId: card.id, endedAt: null } })
        expect(run.agentId).toBe(workerId)
        const lease = worker.get(run.leaseId)!
        expect(lease).toBeDefined()
        expect(await worker.liveness(lease)).toBe('turn')
        const before = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })
        expect(before.status).toBe('running')
        expect(await orch('kanbanAssign', { board: boardId, issue: number, assignee: 'lane1-next' })).toEqual({
          assigned: true
        })
        const ended = await prisma.kanbanRun.findUniqueOrThrow({ where: { leaseId: run.leaseId } })
        expect(ended).toMatchObject({ outcome: 'reclaimed', reasonCode: 'reassigned' })
        expect(ended.endedAt).not.toBeNull()
        const reassigned = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })
        expect(reassigned).toMatchObject({ assigneeAgentId: agentId, status: 'ready', consecutiveFailures: 0 })
        expect(reassigned.dispatchRevision).toBe(before.dispatchRevision + 1n)
        await waitFor(async () => {
          const comments = await gh<Array<{ body: string }>>('GET', `/repos/${FULL}/issues/${number}/comments`)
          expect(
            comments.some(
              (c) =>
                c.body === 'AgentConnect Kanban: reassigned from lane1-old to lane1-next; restarting in a new session.'
            )
          ).toBe(true)
          expect(await labelNames(number)).toEqual(['ac/agent:lane1-next', 'ac/status:ready'])
        })
        await worker.tick()
        expect(heartbeat).toHaveBeenCalled()
        // The worker also beats on its own timer, so find the beat that carried the stale lease.
        expect(
          heartbeat.mock.calls.some((call) =>
            (call[0].leases as Array<{ leaseId: string; dispatchRevision: string }>).some(
              (beat) => beat.leaseId === run.leaseId && beat.dispatchRevision === String(run.dispatchRevision)
            )
          )
        ).toBe(true)
        expect(worker.get(run.leaseId)).toBeUndefined()
        expect(worker.credentialScopes().some((scope) => scope.leaseId === run.leaseId)).toBe(false)
        await waitFor(async () => expect(host.cancel).toHaveBeenCalled(), 10_000)
        return [number]
      } finally {
        releaseTurn?.()
        script = async () => {}
        await prisma.kanbanCard.deleteMany({ where: { id: card.id } })
        await prisma.agent.update({ where: { id: agentId }, data: { status: 'active' } })
      }
    })

    await scenario('o8 crash-before-commit retry', async () => {
      const req = {
        board: boardId,
        title: `[kanban-e2e] orch crash retry ${started}`,
        body: 'Scratch durable marker recovery after a daemon crash.',
        step: 'crash-retry'
      }
      const cp = (daemon as any).cpClient
      const original = cp.kanbanOrchestrate.bind(cp)
      const crashed = vi.spyOn(cp, 'kanbanOrchestrate').mockImplementation(async (payload: any) => {
        if (payload.op === 'commit_create') throw new Error('simulated daemon crash before commit')
        return original(payload)
      })
      let number = 0
      try {
        const filed = await orch('kanbanCreate', req)
        number = filed.issueNumber as number
        if (number) issues.push(number)
        expect(filed).toMatchObject({ filed: true, retryable: true })
        expect(await prisma.kanbanCard.count({ where: { boardId, issueNumber: number } })).toBe(0)
      } finally {
        crashed.mockRestore()
      }
      // Discard the toolset to lose the in-memory pending map, as a daemon restart would.
      // The on-disk journal survives this, so the retry must reuse the filed issue without a second POST.
      ;(daemon as any).kanbanOrchestratorToolset = undefined
      expect(await orch('kanbanCreate', req)).toMatchObject({ created: true, issueNumber: number })
      expect(await prisma.kanbanCard.count({ where: { boardId, issueNumber: number } })).toBe(1)
      const matches = (await gh<Issue[]>('GET', `/repos/${FULL}/issues?state=all&per_page=100`)).filter(
        (i) => i.title === req.title
      )
      expect(matches.map((i) => i.number)).toEqual([number])
      expect(matches[0]!.body).toMatch(/<!-- agentconnect:kanban-card-key:[0-9a-f]{64} -->/)
      return [number]
    })

    await scenario('o8b marker recovery without the journal', async () => {
      const req = {
        board: boardId,
        title: `[kanban-e2e] orch marker recovery ${started}`,
        body: 'Scratch marker recovery after losing both the toolset and the journal.',
        step: 'marker-recovery'
      }
      const { kanbanPendingCreatesPath } = await import('../../../daemon/src/paths.js')
      const cp = (daemon as any).cpClient
      const original = cp.kanbanOrchestrate.bind(cp)
      const crashed = vi.spyOn(cp, 'kanbanOrchestrate').mockImplementation(async (payload: any) => {
        if (payload.op === 'commit_create') throw new Error('simulated daemon crash before commit')
        return original(payload)
      })
      let number = 0
      try {
        const filed = await orch('kanbanCreate', req)
        number = filed.issueNumber as number
        if (number) issues.push(number)
        expect(filed).toMatchObject({ filed: true, retryable: true })
        expect(await prisma.kanbanCard.count({ where: { boardId, issueNumber: number } })).toBe(0)
      } finally {
        crashed.mockRestore()
      }
      // Lose both the in-memory map and the journal, so only the marker lookup can recover.
      ;(daemon as any).kanbanOrchestratorToolset = undefined
      rmSync(kanbanPendingCreatesPath(root!), { force: true })
      // Wait out the listing lag before retrying, so the lookup can see the orphan.
      await waitFor(async () => {
        await gh('GET', `/repos/${FULL}/issues/${number}`)
        const listed = await gh<Issue[]>(
          'GET',
          `/repos/${FULL}/issues?state=all&sort=created&direction=desc&per_page=100`
        )
        expect(listed.some((i) => i.number === number)).toBe(true)
      }, 30_000)
      expect(await orch('kanbanCreate', req)).toMatchObject({ created: true, issueNumber: number })
      expect(await prisma.kanbanCard.count({ where: { boardId, issueNumber: number } })).toBe(1)
      const matches = (await gh<Issue[]>('GET', `/repos/${FULL}/issues?state=all&per_page=100`)).filter(
        (i) => i.title === req.title
      )
      expect(matches.map((i) => i.number)).toEqual([number])
      for (const dup of matches.map((i) => i.number)) if (!issues.includes(dup)) issues.push(dup)
      return [number]
    })

    for (const r of results) console.log(`KANBAN_ORCH_E2E_RESULT ${JSON.stringify(r)}`)
    const failed = results.filter((r) => !r.pass)
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([])
  }, 600_000)
})
