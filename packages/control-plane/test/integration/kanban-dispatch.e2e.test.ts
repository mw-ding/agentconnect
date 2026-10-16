// Live GitHub + Postgres + daemon/ACP. Doorbells arrive via GitHub→smee→relay→CP. The model calls the real terminal tool.
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import SmeeClient from 'smee-client'
import type { KanbanDispatch, KanbanReport } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { buildApp, type App } from '../../src/app.js'
import { AppConfigSchema } from '../../src/config/env.js'
import { systemClock } from '../../src/domain/clock.js'
import { OrgId } from '../../src/domain/ids.js'
import { mintAppJwt } from '../../src/github/api.js'
import { resolveGithubAppConfig, type GithubAppConfig } from '../../src/github/config.js'
import { InstallationTokenService } from '../../src/github/installation-token.service.js'
import { GithubCardStore } from '../../src/kanban/card-store.js'
import { KanbanDispatcher } from '../../src/kanban/dispatcher.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import type { GithubInstallationRecord } from '../../src/persistence/ports.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'
import type { Daemon } from '../../../daemon/src/daemon.js'
import type { KanbanWorker } from '../../../daemon/src/kanban/kanban-worker.js'
import type { LocalStore } from '../../../daemon/src/store/local-store.js'
import { kanbanLeaseMarker } from '../../../daemon/src/kanban/kanban-comments.js'
import { writeGhShim } from '../../../daemon/src/cp/gh-shim.js'
import { AcpHost } from '../../../daemon/src/acp/acp-host.js'
import { postGithubWebhook, startRelayCpLink, type RelayCpLink } from '../fixtures/relay-link.js'
import { isLeakedAgentEnvKey, stripLeakedAgentEnv } from '../kanban-agent-env.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { prisma } from '../setup.db.js'

const TOKEN = process.env.GITHUB_TOKEN
const enabled = !process.env.CI && process.env.KANBAN_E2E === '1' && !!TOKEN
const OWNER = 'mw-ding'
const FULL = `${OWNER}/agentconnect`
const REPO_ID = 1332342098n
const PEPPER = 'kanban-e2e-pepper-0123456789abcdef'
const RELAY_TOKEN = 'kanban-e2e-relay-token-0123456789ab'

function githubAppFromEnv(): GithubAppConfig | undefined {
  const id = process.env.GITHUB_APP_ID
  const key = process.env.GITHUB_APP_PRIVATE_KEY_B64
  const slug = process.env.GITHUB_APP_SLUG
  if (!id || !key || !slug) return undefined
  return resolveGithubAppConfig({
    GITHUB_APP_ID: Number(id),
    GITHUB_APP_PRIVATE_KEY_B64: key,
    GITHUB_APP_SLUG: slug,
    GITHUB_APP_CLIENT_ID: process.env.GITHUB_APP_CLIENT_ID
  })
}

function agentEnv(): NodeJS.ProcessEnv {
  return stripLeakedAgentEnv({
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=development`.trim()
  })
}

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
  // Hook delivery ids exceed 2^53; keep 16+ digit integers as strings so they round-trip into URLs.
  const text = (await response.text()).replace(/("id":\s*)(\d{16,})/g, '$1"$2"')
  return JSON.parse(text) as T
}

interface Issue {
  id: number
  number: number
  state: string
  state_reason: string | null
  labels: Array<{ name: string }>
}

describe.skipIf(!enabled)('kanban dispatch e2e (live GitHub)', () => {
  const started = Date.now()
  const daemonId = randomUUID()
  const agentId = randomUUID()
  let epoch = 4
  const issues: number[] = []
  const sends: KanbanDispatch[] = []
  const reports: KanbanReport[] = []
  const permissionDenials: string[] = []
  const deliveryIds: string[] = []
  let boardId = ''
  let root: string | undefined
  let daemon: Daemon | undefined
  let worker: KanbanWorker
  let local: LocalStore
  let dispatcher: KanbanDispatcher | undefined
  let app: App | undefined
  let link: RelayCpLink | undefined
  let smee: SmeeClient | undefined
  let hookId: number | undefined
  const createdHookIds: number[] = []
  const createdLabels: string[] = []
  const hookMarker = `kanban-e2e-${randomUUID()}`
  let smeeUp = false
  let smeeSkipReason = ''
  let webhookSecret = ''
  let installationGithubId: bigint | undefined
  let appConfigured = false
  let webhookMode: 'real' | 'injected' = 'injected'
  let webhookWhy = 'webhook path has not run'
  let terminalMode: 'real' | 'injected' = 'injected'
  let terminalWhy = 'terminal tool has not run'
  let terminalFellBack = false
  let tokenMode: 'real' | 'injected' = 'injected'
  let tokenWhy = 'no GitHub App configured'
  let commentMode: 'real' | 'injected' = 'injected'
  let commentWhy = 'final comment has not been posted'
  let shellRefusalObserved = false
  let shellWhy = 'shell probe has not run'
  let shellChecks = 0
  let summarized = false
  let cpReady = false
  let cpOrigin = ''
  let selectedRuntime: { id: string; adapter: string } | undefined
  let releaseTurn: (() => void) | undefined
  let modelTurn: Promise<unknown> | undefined
  let runtimeId = 'claude'
  let realAgent = false
  let workspace = ''
  let daemonEntry = ''
  let terminalInstruction =
    'call exactly one Kanban terminal tool, kanbanRequestReview or kanbanComplete, with a one-line summary.'
  const updates: unknown[] = []
  const phase = (name: string, observed: unknown = {}) =>
    console.log(`${new Date().toISOString()} +${Date.now() - started}ms ${name}`, observed)
  const log = {
    debug: () => {},
    info: (_obj: unknown, message?: string) => phase(message ?? 'info'),
    warn: (_obj: unknown, message?: string) => phase(`WARN ${message ?? ''}`)
  }
  const installation: GithubInstallationRecord = {
    id: 'e2e',
    orgId: OrgId(DEFAULT_ORG_ID),
    installationId: 1n,
    accountLogin: OWNER,
    accountType: 'User',
    permissions: { issues: 'write' },
    repositorySelection: 'selected',
    suspendedAt: null,
    revokedAt: null,
    createdAt: new Date(0)
  }
  // App minting when GITHUB_APP_* is complete; otherwise the PAT, logged as injected.
  let store = new GithubCardStore({ tokens: { mintKanbanCard: async () => ({ token: TOKEN! }) } as never })
  const ref = { installationId: 1n, repoId: REPO_ID, repoFullName: FULL }
  let host: any = {
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
      await new Promise<void>((resolve) => {
        releaseTurn = resolve
      })
      return { stopReason: 'end_turn' }
    }),
    cancel: async () => {},
    forgetSession: () => {},
    stop: async () => {}
  }

  const issue = (number: number) => gh<Issue>('GET', `/repos/${FULL}/issues/${number}`)
  const card = (id: string) => prisma.kanbanCard.findUniqueOrThrow({ where: { id } })
  const run = (leaseId: string) => prisma.kanbanRun.findUniqueOrThrow({ where: { leaseId } })
  async function snapshot(name: string, id: string, number: number) {
    const [db, remote] = await Promise.all([card(id), issue(number)])
    phase(name, {
      issue: number,
      db: db.status,
      stateRevision: String(db.stateRevision),
      dispatchRevision: String(db.dispatchRevision),
      labels: remote.labels.map((label) => label.name),
      state: remote.state,
      reason: remote.state_reason
    })
  }

  beforeAll(async () => {
    phase('setup: live repository and human token')
    expect(BigInt((await gh<{ id: number }>('GET', `/repos/${FULL}`)).id)).toBe(REPO_ID)
    expect((await gh<{ type: string }>('GET', '/user')).type).toBe('User')
    for (const name of ['triage', 'ready', 'running', 'review', 'done'].map((s) => `ac/status:${s}`)) {
      // Read before creating so existing repository labels are never modified.
      const labels = await gh<Array<{ name: string }>>('GET', `/repos/${FULL}/labels?per_page=100`)
      if (!labels.some((label) => label.name === name)) {
        await gh('POST', `/repos/${FULL}/labels`, { name, color: 'ededed' })
        createdLabels.push(name)
      }
    }
    root = mkdtempSync(join(tmpdir(), 'kanban-dispatch-e2e-'))
    const agentDir = join(root, 'agents', agentId)
    workspace = join(agentDir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    const candidates = [
      {
        id: 'claude-acp',
        cli: 'claude',
        args: ['-p', '--permission-mode', 'plan', '--tools', '', '--no-session-persistence'],
        adapter: '@agentclientprotocol/claude-agent-acp@0.91.0'
      },
      {
        id: 'codex-acp',
        cli: 'codex',
        args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral'],
        adapter: '@agentclientprotocol/codex-acp@2.2.2'
      }
    ]
    let selected: (typeof candidates)[number] | undefined
    for (const candidate of candidates) {
      const result = await new Promise<{ ok: boolean; quota: boolean }>((resolve) => {
        const child = execFile(
          candidate.cli,
          [...candidate.args, 'Reply only kanban-e2e-ok. Do not use any tools.'],
          { cwd: workspace, env: agentEnv(), timeout: 30_000, maxBuffer: 1024 * 1024 },
          (error, stdout, stderr) =>
            resolve({
              ok: !error && stdout.includes('kanban-e2e-ok'),
              quota: /quota|limit|credit/i.test(stdout + stderr)
            })
        )
        child.stdin?.end()
      })
      phase('setup: agent CLI availability', { cli: candidate.cli, ...result })
      if (result.ok) {
        selected = candidate
        // Prefer Codex's explicit read-only mode, with Claude plan as the fallback.
        if (candidate.cli === 'codex') break
      }
    }
    realAgent = !!selected
    runtimeId = selected?.id ?? 'claude'
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: false },
        logging: { level: 'error' },
        runtimes: { [runtimeId]: { command: 'node', args: ['unused'] } }
      })
    )
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({
        id: agentId,
        name: 'kanban-e2e',
        runtime: runtimeId,
        workspace: { mode: 'from-scratch', path: workspace },
        integrations: [],
        output: { mode: 'medium' }
      })
    )
    const { Daemon } = await import('../../../daemon/src/daemon.js')
    // Real helpers need tsx for source imports; Vitest's argv[1] and loader hooks are not a daemon CLI.
    daemonEntry = join(root, 'daemon-entry.mjs')
    const tsxApi = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href
    const sourceEntry = new URL('../../../daemon/src/index.ts', import.meta.url).href
    writeFileSync(
      daemonEntry,
      `import { register } from ${JSON.stringify(tsxApi)}; register(); await import(${JSON.stringify(sourceEntry)});`
    )
    vi.stubEnv('AGENTCONNECT_DAEMON_ENTRY', daemonEntry)
    appConfigured = !!githubAppFromEnv()
    if (!appConfigured) {
      tokenMode = 'injected'
      tokenWhy = 'no GitHub App configured'
      console.log('KANBAN_E2E INJECTED token: no GitHub App configured')
    } else {
      tokenMode = 'real'
      tokenWhy = 'card and comment tokens are repository-scoped installation tokens'
      phase('setup: GitHub App configured; card and comment tokens are installation tokens')
    }
    const githubApp = githubAppFromEnv()
    if (githubApp) {
      store = new GithubCardStore({
        tokens: new InstallationTokenService(githubApp, systemClock),
        appSlug: process.env.GITHUB_APP_SLUG
      })
    }
    webhookSecret = randomBytes(32).toString('hex')
    const cpConfig = AppConfigSchema.parse({
      DATABASE_URL: 'postgresql://e2e/ignored',
      API_KEY_PEPPER: PEPPER,
      RELAY_TOKEN,
      SECRETS_PROVIDER: 'memory',
      NODE_ENV: 'test',
      ...(githubApp
        ? {
            GITHUB_APP_ID: Number(process.env.GITHUB_APP_ID),
            GITHUB_APP_PRIVATE_KEY_B64: process.env.GITHUB_APP_PRIVATE_KEY_B64,
            GITHUB_APP_SLUG: process.env.GITHUB_APP_SLUG,
            ...(process.env.GITHUB_APP_CLIENT_ID ? { GITHUB_APP_CLIENT_ID: process.env.GITHUB_APP_CLIENT_ID } : {})
          }
        : {})
    })
    app = buildApp({
      prisma,
      config: cpConfig,
      clock: systemClock,
      secretsProvider: new MemorySecretsProvider(),
      ...(!githubApp && TOKEN ? { kanbanAccessToken: TOKEN } : {})
    })
    const cpUrl = await app.http.listen({ port: 0, host: '127.0.0.1' })
    app.mountWs()
    link = await startRelayCpLink({
      cpUrl,
      relayCredential: RELAY_TOKEN,
      webhookSecret,
      log: {
        debug: () => {},
        info: (message) => phase(`relay ${message}`),
        warn: (message) => phase(`relay WARN ${message}`),
        error: (message) => phase(`relay ERROR ${message}`)
      }
    })
    phase('setup: real relay linked to the CP doorbell', { webhookUrl: link.webhookUrl })
    installationGithubId = await discoverInstallationId(githubApp)
    try {
      const channel = await newSmeeChannel()
      smee = new SmeeClient({
        source: channel,
        target: link.webhookUrl,
        logger: {
          info: (message) => phase('smee', { message: String(message ?? '') }),
          error: (message) => phase('smee error', { message: String(message ?? '') })
        }
      })
      await smee.start()
      smeeUp = true
      webhookMode = 'real'
      webhookWhy =
        'GitHub delivers to smee, which forwards to the relay; the relay verifies the signature and rings the CP'
      phase('setup: smee channel forwarding to the relay', { channel })
      await createHook(channel)
    } catch (err) {
      smeeUp = false
      smeeSkipReason = err instanceof Error ? err.message : String(err)
      webhookMode = 'injected'
      webhookWhy = `smee unreachable (${smeeSkipReason}); the real GitHub delivery payload is signed and posted to the relay`
      console.error(`KANBAN_E2E smee unreachable: ${smeeSkipReason}`)
      phase('setup: smee unreachable', { reason: smeeSkipReason })
      await createHook('https://example.invalid/kanban-e2e-webhook')
    }
    if (installationGithubId === undefined) installationGithubId = await installationIdFromPing()
    if (installationGithubId !== undefined) {
      installation.installationId = installationGithubId
      ref.installationId = installationGithubId
      phase('setup: github installation', { installationId: String(installationGithubId) })
    }
    // The daemon starts in the test, after the truncated database has the API key.
    selectedRuntime = selected
    cpOrigin = cpUrl
    phase('setup: relay and webhook ready; daemon starts after the database seed', { agent: selected?.id ?? 'stub' })
  }, 180_000)

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
        runtimes: { [runtimeId]: { command: 'node', args: ['unused'] } }
      })
    )
    const { Daemon } = await import('../../../daemon/src/daemon.js')
    const selected = selectedRuntime
    daemon = new Daemon({
      root,
      hostFactory: (_agent, onUpdate) => {
        if (selected) {
          const adapterEnv = { ...agentEnv(), PATH: `${join(root!, 'run', 'bin')}:${process.env.PATH}` }
          expect(Object.keys(adapterEnv).filter(isLeakedAgentEnvKey)).toEqual([])
          const runtime = new AcpHost(
            { command: 'npx', args: ['-y', selected.adapter], env: [] },
            {
              env: adapterEnv,
              inheritProcessEnv: false,
              suppressChildStderr: true,
              onUpdate: (sid, update) => {
                updates.push(update)
                onUpdate(sid, update)
              },
              onPermission: async (sid, params) => {
                const tool = JSON.stringify(params.toolCall ?? {})
                const decision = await (daemon as any).onAcpPermission(agentId, sid, params)
                if (decision?.outcome?.outcome === 'cancelled') permissionDenials.push(tool)
                return decision
              }
            }
          )
          const start = runtime.start.bind(runtime)
          vi.spyOn(runtime, 'start').mockImplementation(async () => {
            phase('c: real ACP adapter starting')
            await start()
            phase('c: real ACP adapter initialized')
          })
          const newSession = runtime.newSession.bind(runtime)
          vi.spyOn(runtime, 'newSession').mockImplementation(async (...args) => {
            phase('c: real ACP session creating')
            const sid = await newSession(...args)
            phase('c: real ACP session ready', { sessionId: sid })
            return sid
          })
          const prompt = runtime.prompt.bind(runtime)
          vi.spyOn(runtime, 'prompt').mockImplementation(async (sid, blocks) => {
            phase('c: real ACP model prompt started', { sessionId: sid })
            const held = new Promise<void>((resolve) => {
              releaseTurn = resolve
            })
            modelTurn = prompt(sid, [
              ...blocks,
              {
                type: 'text',
                text: `Live test instruction: no GitHub credentials are provided. Do not inspect credentials or contact GitHub. To verify read-only enforcement, use your shell tool once to attempt \`printf kanban-e2e > kanban-write-probe.txt\` in this workspace. Do not request escalation or retry. Report the observed refusal and include KANBAN_READ_ONLY_REFUSED. The filesystem probe is the only workspace write. Then ${terminalInstruction} Do not post a GitHub comment and do not change labels.`
              }
            ])
            const result = await modelTurn
            phase('c: real ACP model prompt finished', { sessionId: sid })
            await held
            return result as Awaited<ReturnType<AcpHost['prompt']>>
          })
          vi.spyOn(runtime, 'setSessionPermissionMode')
          host = runtime
        }
        return host as never
      }
    })
    await daemon.start()
    worker = (daemon as any).kanbanWorker()
    local = (daemon as any).store
    const original = worker.dispatch.bind(worker)
    worker.dispatch = (dispatch) => {
      sends.push(dispatch)
      phase('c: real daemon worker dispatch', {
        issue: dispatch.issueNumber,
        mode: dispatch.mode,
        attempt: dispatch.attempt
      })
      return original(dispatch)
    }
    await vi.waitFor(() => expect((daemon as any).cpClient?.state).toBe('READY'), { timeout: 20_000, interval: 250 })
    epoch = Number((await prisma.daemon.findUniqueOrThrow({ where: { id: daemonId } })).sessionEpoch)
    phase('setup: daemon connected to the CP', { epoch, agent: selected?.id ?? 'stub' })
  }

  afterAll(async () => {
    const cleanup = await Promise.allSettled([
      (async () => {
        dispatcher?.stop()
        await dispatcher?.settle()
        cpReady = false
        releaseTurn?.()
        await daemon?.stop()
        await smee?.stop()
        await link?.close()
      })(),
      deleteCreatedHooks(),
      ...createdLabels.map(async (name) => {
        await gh('DELETE', `/repos/${FULL}/labels/${encodeURIComponent(name)}`)
        phase('cleanup: deleted label this run created', { label: name })
      }),
      ...issues.map(async (number) => {
        await gh('PATCH', `/repos/${FULL}/issues/${number}`, { state: 'closed', state_reason: 'not_planned' })
        const closed = await issue(number)
        expect(closed).toMatchObject({ state: 'closed', state_reason: 'not_planned' })
        phase('cleanup: confirmed closed/not_planned', { issue: number })
      })
    ])
    const dbCleanup = await Promise.allSettled([
      (async () => {
        if (boardId) {
          await prisma.kanbanBoard.deleteMany({ where: { id: boardId } })
          expect(await prisma.kanbanCard.count({ where: { boardId } })).toBe(0)
        }
        await prisma.agent.deleteMany({ where: { id: agentId } })
        await prisma.daemon.deleteMany({ where: { id: daemonId } })
        expect(await prisma.kanbanRun.count({ where: { daemonId } })).toBe(0)
        phase('cleanup: board, cards, runs, agent and daemon rows deleted')
      })()
    ])
    if (root) rmSync(root, { recursive: true, force: true })
    vi.unstubAllEnvs()
    if (!summarized) printSummary()
    if (app) {
      await app.drainWs()
      await app.http.close()
    }
    for (const result of [...cleanup, ...dbCleanup]) if (result.status === 'rejected') throw result.reason
  }, 120_000)

  it('recovers human-readied cards, dispatches fenced read leases, refuses writes, and reports review/done', async () => {
    // The integration harness truncates before each test, so seed all DB fixtures here.
    await seedDaemon(prisma, daemonId, { sessionEpoch: BigInt(epoch) })
    await seedAgent(prisma, agentId, { daemonId, runtime: runtimeId })
    if (installationGithubId !== undefined) await ensureInstallation(installationGithubId)
    await startLinkedDaemon()
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: `dispatch-e2e ${started}`, repoId: REPO_ID, repoFullName: FULL }
    })
    boardId = board.id
    dispatcher = new KanbanDispatcher({
      repo: new PgKanbanDispatchRepo(prisma),
      installations: { liveByOrgAndAccount: async () => installation },
      store,
      // The live claim is the CP dispatcher behind the webhook. This one only parks the initial mismatch and accepts reports.
      send: async (id, dispatch) => {
        expect(id).toBe(daemonId)
        return worker.dispatch(dispatch)
      },
      isDaemonLive: (id) => id === daemonId,
      clock: systemClock,
      log
    })
    const cp = {
      ready: () => cpReady,
      heartbeat: async (payload: { leases: Parameters<KanbanDispatcher['onHeartbeat']>[2] }) => ({
        superseded: await dispatcher!.onHeartbeat(daemonId, epoch, payload.leases)
      }),
      report: async (report: KanbanReport) => {
        reports.push(report)
        return dispatcher!.onReport(daemonId, epoch, report)
      }
    }
    // Heartbeats and reports stay on this in-process fence. Dispatch and gitcred use the live CP socket.
    ;(worker as any).deps.cp = () => cp
    if (!appConfigured) {
      ;(daemon as any).gitCreds.getKanbanCommentToken = async (id: string, repo: string, leaseId: string) => {
        const allowed = await dispatcher!.commentGrant(daemonId, id, leaseId, repo)
        if (!allowed) throw new Error(`kanban comment refused for lease ${leaseId} on ${repo}`)
        return { token: TOKEN }
      }
    }
    for (const outcome of ['review_requested', 'completed'] as const) {
      permissionDenials.length = 0
      const toolName = outcome === 'completed' ? 'kanbanComplete' : 'kanbanRequestReview'
      const created = await gh<Issue>('POST', `/repos/${FULL}/issues`, {
        title: `[kanban-e2e] dispatch ${outcome} ${started}`,
        body: 'Scratch issue for the opt-in Kanban M2 live integration check. No repository changes are requested.',
        labels: ['ac/status:triage']
      })
      issues.push(created.number)
      const c = await prisma.kanbanCard.create({
        data: {
          boardId,
          issueId: BigInt(created.id),
          issueNumber: created.number,
          status: 'ready',
          assigneeAgentId: agentId
        }
      })
      const summary = `KANBAN_E2E_TERMINAL ${outcome} #${created.number}`
      terminalInstruction = `call the \`${toolName}\` tool exactly once. Pass summary exactly: ${summary}. Do not call any other Kanban terminal tool.`
      await dispatcher.reconcileBoard(boardId)
      await dispatcher.settle()
      const parkedRun = await prisma.kanbanRun.findFirstOrThrow({ where: { cardId: c.id } })
      expect(parkedRun).toMatchObject({ reasonCode: 'github_state_mismatch', outcome: 'transient', ackedAt: null })
      expect((await card(c.id)).status).toBe('triage')
      expect(sends.filter((d) => d.cardId === c.id)).toHaveLength(0)
      await snapshot('a: mismatch parked; no daemon dispatch', c.id, created.number)

      cpReady = true
      const promptCount = host.prompt.mock.calls.length
      const pokeMark = link?.graphPokes.length ?? 0
      await gh('PUT', `/repos/${FULL}/issues/${created.number}/labels`, { labels: ['ac/status:ready'] })
      await vi.waitFor(async () => expect(await store.statusSetByHuman(ref, created.number, 'ready')).toBe(true), {
        timeout: 30_000,
        interval: 1_000
      })
      const deliveryId = await deliverReady(created.number, pokeMark)
      deliveryIds.push(deliveryId)
      phase('a: relay delivery landed', { deliveryId, via: webhookMode })
      console.log(`KANBAN_E2E X-GitHub-Delivery ${deliveryId} via ${webhookMode}`)
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(promptCount + 1), { timeout: 60_000 })
      const d = sends.at(-1)!
      expect(d).toMatchObject({ cardId: c.id, attempt: 2, mode: 'read' })
      expect(await run(d.leaseId)).toMatchObject({
        ackedAt: expect.any(Date),
        endedAt: null,
        daemonEpoch: BigInt(epoch)
      })
      expect((await card(c.id)).status).toBe('running')
      await vi.waitFor(
        async () =>
          expect((await issue(created.number)).labels.map((label) => label.name)).toEqual(['ac/status:running']),
        { timeout: 20_000, interval: 500 }
      )
      await snapshot('b/c: lease ACK persisted and running label observed', c.id, created.number)
      const lease = worker.get(d.leaseId)!
      expect(lease.sessionId).toBeTruthy()
      expect(local.getSession(lease.sessionKey)).toMatchObject({
        externalProvider: 'github',
        externalResourceKey: String(REPO_ID)
      })
      expect(host.setSessionPermissionMode).toHaveBeenLastCalledWith(
        lease.sessionId,
        expect.stringMatching(/^(read-only|plan)$/)
      )
      expect(worker.dispatch(d)).toEqual({ leaseId: d.leaseId, accepted: true })
      expect(host.prompt).toHaveBeenCalledTimes(promptCount + 1)
      await worker.tick()
      expect(await run(d.leaseId)).toMatchObject({ heartbeatAt: expect.any(Date), sessionId: lease.sessionId })
      phase('b/c: duplicate dispatch deduplicated; live heartbeat persisted', {
        leaseId: d.leaseId,
        sessionId: lease.sessionId
      })

      const report: KanbanReport = { ...d, outcome, sessionId: lease.sessionId }
      for (const [id, reportEpoch, fenced] of [
        [randomUUID(), epoch, report],
        [daemonId, epoch - 1, report],
        [daemonId, epoch, { ...report, dispatchRevision: String(BigInt(d.dispatchRevision) + 1n) }]
      ] as const) {
        expect(await dispatcher.onReport(id, reportEpoch, fenced)).toMatchObject({
          accepted: false,
          reason: 'superseded'
        })
      }
      expect((await run(d.leaseId)).endedAt).toBeNull()
      phase('b: wrong daemon, epoch and revision reports refused; lease remains open')

      const permission = await (daemon as any).onAcpPermission(agentId, lease.sessionId, {
        sessionId: lease.sessionId,
        toolCall: {
          title: 'gh issue edit',
          rawInput: { command: `gh issue edit ${created.number} -R ${FULL} --add-label ac/mode:write` }
        },
        options: [{ kind: 'allow_once', optionId: 'allow', name: 'Allow' }]
      })
      expect(permission).toEqual({ outcome: { outcome: 'cancelled' } })
      expect((daemon as any).setPermissionModeByKey(lease.sessionKey, 'agent-full-access')).toBe(false)
      // Exercise the real generated shell shim with no credential ever copied into the child environment.
      const shim = join(writeGhShim(root!, daemonEntry), 'gh')
      const env: NodeJS.ProcessEnv = { ...agentEnv(), AC_AGENT_ID: agentId }
      const refused = await new Promise<{ code: number | string | null | undefined; stderr: string }>((resolve) => {
        execFile(
          shim,
          ['issue', 'comment', String(created.number), '-R', FULL, '--body', 'This write must be refused.'],
          { env, timeout: 30_000 },
          (error, _stdout, stderr) => resolve({ code: error?.code, stderr })
        )
      })
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain('no gh credentials for agent')
      expect(refused.stderr).toContain('daemon could not provide GitHub credentials; refusing stored gh authentication')
      expect(await gh<unknown[]>('GET', `/repos/${FULL}/issues/${created.number}/comments`)).toEqual([])
      phase(
        'd: read-only mode selected; permission escalation and label mutation denied; real gh write refused (no daemon grant)'
      )

      if (realAgent) {
        await modelTurn
        const probeAbsent = !existsSync(join(workspace, 'kanban-write-probe.txt'))
        expect(probeAbsent).toBe(true)
        const evidence = observeShellRefusal(updates, permissionDenials, probeAbsent)
        shellChecks += 1
        shellRefusalObserved = (shellChecks === 1 || shellRefusalObserved) && evidence.observed
        shellWhy = evidence.why
        if (!evidence.observed) console.log(`KANBAN_E2E shell refusal unobserved: ${evidence.why}`)
        phase('d: probe file absent; shell refusal taken from ACP or permission evidence', {
          runtime: runtimeId,
          shellRefusalObserved: evidence.observed,
          why: evidence.why
        })
        updates.length = 0
        permissionDenials.length = 0
      }

      cpReady = false
      const live = worker.get(d.leaseId)
      if (!live?.terminal) {
        terminalFellBack = true
        terminalMode = 'injected'
        terminalWhy = `model did not call ${toolName}; the test recorded the outcome directly`
        console.error(
          `KANBAN_E2E FALLBACK: model did not call ${toolName} for ${outcome} on ${FULL}#${created.number}; recording the outcome directly`
        )
        phase('e: FALLBACK recordTerminal; the model did not call the terminal tool', {
          outcome,
          issue: created.number
        })
        expect(worker.recordTerminal(d.leaseId, { outcome, summary }).recorded).toBe(true)
      } else {
        // A fallback on an earlier card keeps the seam marked injected.
        if (!terminalFellBack) {
          terminalMode = 'real'
          terminalWhy = 'the agent called the Kanban terminal MCP tool'
        }
        expect(live.terminal).toMatchObject({ outcome, summary: expect.stringContaining('KANBAN_E2E_TERMINAL') })
        phase('e: model called the terminal tool', { outcome, issue: created.number, tool: toolName })
      }
      const summaryUsed = worker.get(d.leaseId)?.terminal?.summary ?? ''
      expect(summaryUsed).toContain('KANBAN_E2E_TERMINAL')
      expect(await gh<unknown[]>('GET', `/repos/${FULL}/issues/${created.number}/comments`)).toEqual([])
      releaseTurn!()
      releaseTurn = undefined
      await vi.waitFor(() => expect(local.listKanbanReports(10)).toHaveLength(1), { timeout: 30_000 })
      expect(local.listKanbanReports(10)[0]).toMatchObject({ leaseId: d.leaseId, outcome })
      expect((await run(d.leaseId)).endedAt).toBeNull()
      phase('e: terminal outcome persisted to real SQLite outbox while CP link offline', { outcome })
      cpReady = true
      await worker.flush()
      await dispatcher.settle()
      expect(reports.at(-1)).toMatchObject({ leaseId: d.leaseId, outcome })
      expect(local.listKanbanReports(10)).toHaveLength(0)
      expect(local.hasKanbanReport(d.leaseId)).toBe(true)
      expect(await run(d.leaseId)).toMatchObject({ outcome, endedAt: expect.any(Date) })
      const target = outcome === 'completed' ? 'done' : 'review'
      expect((await card(c.id)).status).toBe(target)
      const moved = await issue(created.number)
      expect(moved.labels.map((label) => label.name)).toEqual([`ac/status:${target}`])
      expect(moved.state).toBe(outcome === 'completed' ? 'closed' : 'open')
      if (outcome === 'completed') expect(moved.state_reason).toBe('completed')
      expect(await dispatcher.onReport(daemonId, epoch, report)).toEqual({ leaseId: d.leaseId, accepted: true })
      expect((await issue(created.number)).labels.map((label) => label.name)).toEqual([`ac/status:${target}`])
      await snapshot('e: fenced report accepted, identical replay accepted, outbox ACK retained', c.id, created.number)

      const marker = kanbanLeaseMarker(d.leaseId)
      await vi.waitFor(
        async () => {
          const comments = await gh<Array<{ body: string }>>('GET', `/repos/${FULL}/issues/${created.number}/comments`)
          expect(comments).toHaveLength(1)
          expect(comments[0]?.body).toContain(summaryUsed)
          expect(comments[0]?.body).toContain(marker)
        },
        { timeout: 30_000, interval: 1_000 }
      )
      await (daemon as any).kanbanCommentPoster.drain()
      const comments = await gh<Array<{ body: string }>>('GET', `/repos/${FULL}/issues/${created.number}/comments`)
      expect(comments).toHaveLength(1)
      commentMode = 'real'
      commentWhy = appConfigured
        ? 'the daemon posted the accepted summary with a kanban_card_write installation token'
        : 'the daemon posted the accepted summary; the token itself is the injected PAT'
      phase('e: automatic final comment posted once', { issue: created.number })
    }
    if (!realAgent) {
      shellWhy =
        'no real agent runtime ran, so there is no ACP tool_call, permission denial, or sandbox log for the shell probe'
      console.log(`KANBAN_E2E shell refusal unobserved: ${shellWhy}`)
    }
    printSummary()
  }, 360_000)

  function printSummary(): void {
    summarized = true
    const shellMode = !realAgent ? 'injected' : shellRefusalObserved ? 'real' : 'unobserved'
    console.log(
      `KANBAN_E2E_SUMMARY ${JSON.stringify({
        doorbell: { mode: webhookMode, why: webhookWhy, deliveries: deliveryIds },
        terminal: { mode: terminalMode, why: terminalWhy },
        token: { mode: tokenMode, why: tokenWhy },
        shell: { mode: shellMode, why: shellWhy, shellRefusalObserved },
        comment: { mode: commentMode, why: commentWhy }
      })}`
    )
  }

  async function newSmeeChannel(): Promise<string> {
    const response = await fetch('https://smee.io/new', { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    const location = response.headers.get('location')
    if (!location || ![301, 302, 303, 307, 308].includes(response.status)) {
      throw new Error(`GET https://smee.io/new returned ${response.status} without a Location`)
    }
    return new URL(location, 'https://smee.io').href
  }

  function markWebhookUrl(url: string): string {
    const marked = new URL(url)
    marked.searchParams.set('ac-kanban-e2e', hookMarker)
    return marked.href
  }

  async function deleteCreatedHooks(): Promise<void> {
    for (const id of createdHookIds) {
      const hook = await gh<{ config?: { url?: string } }>('GET', `/repos/${FULL}/hooks/${id}`).catch(() => undefined)
      if (!hook?.config?.url?.includes(hookMarker)) continue
      await gh('DELETE', `/repos/${FULL}/hooks/${id}`)
      phase('cleanup: temporary repository webhook deleted', { hookId: id })
    }
    createdHookIds.length = 0
    hookId = undefined
  }

  async function createHook(url: string): Promise<void> {
    const marked = markWebhookUrl(url)
    const created = await gh<{ id: number }>('POST', `/repos/${FULL}/hooks`, {
      name: 'web',
      active: true,
      events: ['issues', 'issue_comment', 'label'],
      config: { url: marked, content_type: 'json', secret: webhookSecret, insecure_ssl: '0' }
    })
    createdHookIds.push(created.id)
    hookId = created.id
    phase('setup: temporary repository webhook created', { hookId, url: marked })
  }

  async function discoverInstallationId(appCfg: GithubAppConfig | undefined): Promise<bigint | undefined> {
    const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
    const read = async (authorization: string): Promise<bigint | undefined> => {
      const response = await fetch(`https://api.github.com/repos/${FULL}/installation`, {
        headers: { ...headers, authorization },
        signal: AbortSignal.timeout(15_000)
      })
      if (!response.ok) {
        phase('setup: installation lookup', { status: response.status })
        return undefined
      }
      const body = (await response.json()) as { id?: number }
      return body.id ? BigInt(body.id) : undefined
    }
    if (appCfg) {
      try {
        const id = await read(`Bearer ${await mintAppJwt(appCfg)}`)
        if (id !== undefined) return id
      } catch (err) {
        phase('setup: app installation lookup failed', { error: err instanceof Error ? err.message : String(err) })
      }
    }
    try {
      return await read(`Bearer ${TOKEN}`)
    } catch {
      return undefined
    }
  }

  async function installationIdFromPing(): Promise<bigint | undefined> {
    if (hookId === undefined) return undefined
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const deliveries = await gh<Array<{ id: number; event: string }>>(
        'GET',
        `/repos/${FULL}/hooks/${hookId}/deliveries?per_page=20`
      )
      const ping = deliveries.find((delivery) => delivery.event === 'ping')
      if (ping) {
        const detail = await gh<{ request?: { payload?: { installation?: { id?: number } } } }>(
          'GET',
          `/repos/${FULL}/hooks/${hookId}/deliveries/${ping.id}`
        )
        const id = detail.request?.payload?.installation?.id
        return id ? BigInt(id) : undefined
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    return undefined
  }

  async function ensureInstallation(id: bigint): Promise<void> {
    installation.installationId = id
    ref.installationId = id
    installationGithubId = id
    const existing = await prisma.githubInstallation.findUnique({ where: { installationId: id } })
    if (existing) return
    await prisma.githubInstallation.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        installationId: id,
        accountLogin: OWNER,
        accountType: 'User',
        repositorySelection: 'selected',
        permissions: { issues: 'write', metadata: 'read', contents: 'write', pull_requests: 'write' }
      }
    })
  }

  async function labeledDelivery(issueNumber: number): Promise<HookDelivery & { payload: ReadyPayload }> {
    if (hookId === undefined) throw new Error('temporary repository webhook was not created')
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const list = await gh<HookDelivery[]>('GET', `/repos/${FULL}/hooks/${hookId}/deliveries?per_page=30`)
      for (const item of list.filter((delivery) => delivery.event === 'issues' && delivery.action === 'labeled')) {
        const detail = await gh<HookDelivery>('GET', `/repos/${FULL}/hooks/${hookId}/deliveries/${item.id}`)
        const payload = deliveryPayload(detail.request?.payload)
        if (payload?.issue?.number === issueNumber && payload.label?.name === 'ac/status:ready') {
          return { ...item, ...detail, payload }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    throw new Error(`no GitHub issues.labeled delivery for #${issueNumber} ac/status:ready`)
  }

  async function replayReady(issueNumber: number): Promise<string> {
    const delivery = await labeledDelivery(issueNumber)
    let installationId = delivery.payload.installation?.id
    if (!installationId) {
      // A repository webhook (no GitHub App here) carries no installation block, and the relay routes
      // Kanban doorbells by installation. Stamp the fixture installation the board uses, which is exactly
      // the block an App delivery would carry, and say so.
      installationId = Number(ref.installationId)
      delivery.payload = { ...delivery.payload, installation: { id: installationId } }
      console.log(
        `KANBAN_E2E INJECTED installation.id=${installationId} into real delivery ${delivery.guid ?? delivery.id}: repo webhooks carry no installation without a GitHub App`
      )
    }
    await ensureInstallation(BigInt(installationId))
    const guid = delivery.guid ?? String(delivery.id)
    const sent = await postGithubWebhook(link!.webhookUrl, {
      secret: webhookSecret,
      event: 'issues',
      payload: delivery.payload,
      deliveryId: guid
    })
    if (sent.status !== 202)
      throw new Error(`relay rejected the signed delivery ${guid}: HTTP ${sent.status} ${sent.body}`)
    await vi.waitFor(
      async () => {
        expect(link!.graphPokes.some((poke) => poke.deliveryKey === guid && poke.numbers.includes(issueNumber))).toBe(
          true
        )
        const row = await prisma.kanbanCard.findFirst({ where: { boardId, issueNumber } })
        expect(row?.status).toBeTruthy()
        expect(row?.status).not.toBe('triage')
      },
      { timeout: 20_000, interval: 250 }
    )
    return guid
  }

  async function deliverReady(issueNumber: number, pokeMark: number): Promise<string> {
    if (!smeeUp) {
      console.error('KANBAN_E2E FALLBACK webhook')
      phase('KANBAN_E2E FALLBACK webhook', { reason: smeeSkipReason, issue: issueNumber })
      webhookMode = 'injected'
      webhookWhy = `smee unreachable (${smeeSkipReason}); the real GitHub delivery payload was signed and posted to the relay`
      return replayReady(issueNumber)
    }
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      const poke = link?.graphPokes
        .slice(pokeMark)
        .filter((item) => item.event === 'issues' && item.action === 'labeled' && item.numbers.includes(issueNumber))
        .at(-1)
      const status = (await prisma.kanbanCard.findFirst({ where: { boardId, issueNumber } }))?.status
      if (poke && status && status !== 'triage') return poke.deliveryKey
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    phase('a: smee delivery did not un-park the card; replaying the real GitHub payload to the relay', {
      issue: issueNumber
    })
    webhookMode = 'injected'
    webhookWhy =
      'GitHub→smee→relay delivered and verified the real labeled event, but a repository webhook has no installation block (no GitHub App), so the relay cannot route it to a board; the real payload was stamped with the board installation, re-signed and posted to the relay'
    return replayReady(issueNumber)
  }
})

interface HookDelivery {
  id: number
  guid?: string
  event?: string
  action?: string | null
  request?: { payload?: ReadyPayload | string }
}

interface ReadyPayload {
  action?: string
  installation?: { id?: number }
  issue?: { id?: number; number?: number }
  label?: { name?: string }
  sender?: { type?: string }
}

function deliveryPayload(payload: ReadyPayload | string | undefined): ReadyPayload | undefined {
  if (!payload) return undefined
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload) as ReadyPayload
    } catch {
      return undefined
    }
  }
  return payload
}

/** Refusal evidence that does not trust the model's narration. */
function observeShellRefusal(
  events: unknown[],
  denials: string[],
  probeAbsent: boolean
): { observed: boolean; why: string } {
  const tools = events.filter((event) => {
    const kind = (event as { sessionUpdate?: string }).sessionUpdate
    return kind === 'tool_call' || kind === 'tool_call_update'
  })
  const blob = JSON.stringify(tools)
  const mentionsProbe = blob.includes('kanban-write-probe.txt')
  const refused =
    /"status"\s*:\s*"(?:failed|cancelled)"/.test(blob) ||
    /permission denied|read-only|operation not permitted|not permitted|eacces/i.test(blob)
  if (mentionsProbe && refused) {
    return { observed: true, why: 'ACP tool_call events for the probe ended failed or recorded a refusal' }
  }
  const denied = denials.some((denial) => denial.includes('kanban-write-probe.txt'))
  if (probeAbsent && denied) {
    return { observed: true, why: 'the probe file is absent and the daemon permission layer cancelled the request' }
  }
  return {
    observed: false,
    why: `the runtime gave no ACP tool_call refusal and no cancelled permission for the probe (probeAbsent=${probeAbsent}, toolEvents=${tools.length}, permissionDenials=${denials.length})`
  }
}
