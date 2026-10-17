// Live GitHub + Postgres + a real daemon linked over the CP WebSocket; fake ACP agents (worker + verifier) drive the daemon's real MCP control socket, and a fake Slack connection records the anchor posts.
import { randomBytes, randomUUID } from 'node:crypto'
import type { KanbanReport } from '@agentconnect.md/protocol'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { buildApp, type App } from '../../src/app.js'
import { AppConfigSchema } from '../../src/config/env.js'
import { systemClock } from '../../src/domain/clock.js'
import { OrgId } from '../../src/domain/ids.js'
import { GithubCardStore } from '../../src/kanban/card-store.js'
import { KanbanDispatcher } from '../../src/kanban/dispatcher.js'
import { enqueueTransition } from '../../src/kanban/notifier.js'
import { KanbanNotifier } from '../../src/kanban/notifier-sender.js'
import { PgKanbanNotifyRepo } from '../../src/persistence/repositories/kanban-notify.repo.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import type { GithubInstallationRecord } from '../../src/persistence/ports.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'
import type { Daemon } from '../../../daemon/src/daemon.js'
import type { KanbanWorker } from '../../../daemon/src/kanban/kanban-worker.js'
import { kanbanLeaseMarker } from '../../../daemon/src/kanban/kanban-comments.js'
import { kanbanNoteMarker } from '../../../daemon/src/kanban/card-tools.js'
import { UNTRUSTED_CONTENT_END } from '../../../daemon/src/messages/hook-message.js'
import { decodeFrames, encodeFrame, type IpcResponse } from '../../../daemon/src/mcp/ipc.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { prisma } from '../setup.db.js'

const TOKEN = process.env.GITHUB_TOKEN
const enabled = !process.env.CI && process.env.KANBAN_E2E === '1' && !!TOKEN
const OWNER = 'mw-ding'
const FULL = `${OWNER}/agentconnect`
const REPO_ID = 1332342098n
const PEPPER = 'kanban-e2e-pepper-0123456789abcdef'
const INSTALLATION_ID = 424242n
const NUDGE_TEXT = 'has not been closed'

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
  state: string
  state_reason: string | null
  labels: Array<{ name: string }>
}

interface McpEndpoint {
  endpoint: string
  token: string
}

interface ToolOutcome {
  ok: boolean
  result?: any
  error?: string
}

interface Turn {
  n: number
  sid: string
  text: string
  tool(name: string, args?: Record<string, unknown>): Promise<ToolOutcome>
}

interface ScenarioResult {
  name: string
  engine: string
  issue?: number
  ms: number
  pass: boolean
  error?: string
}

describe.skipIf(!enabled)('kanban M4 verifier + notifier e2e (live GitHub)', () => {
  const started = Date.now()
  const daemonId = randomUUID()
  const agentId = randomUUID()
  const verifierId = randomUUID()
  const botId = randomUUID()
  const integrationId = randomUUID()
  const slackPosts: Array<{ channel: string; text: string }> = []
  const issues: number[] = []
  const createdLabels: string[] = []
  const results: ScenarioResult[] = []
  const mcp = new Map<string, McpEndpoint>()
  let script: (turn: Turn) => Promise<void> = async () => {}
  let boardId = ''
  let epoch = 0
  let root: string | undefined
  let daemon: Daemon | undefined
  let worker: KanbanWorker
  let dispatcher: KanbanDispatcher | undefined
  let app: App | undefined
  let cpOrigin = ''
  let promptTexts: string[] = []
  let notifier: KanbanNotifier | undefined
  const phase = (name: string, observed: unknown = {}) =>
    console.log(`${new Date().toISOString()} +${Date.now() - started}ms ${name}`, observed)
  const installation: GithubInstallationRecord = {
    id: 'e2e',
    orgId: OrgId(DEFAULT_ORG_ID),
    installationId: INSTALLATION_ID,
    accountLogin: OWNER,
    accountType: 'User',
    permissions: { issues: 'write' },
    repositorySelection: 'selected',
    suspendedAt: null,
    revokedAt: null,
    createdAt: new Date(0)
  }
  const store = new GithubCardStore({ tokens: { mintKanbanCard: async () => ({ token: TOKEN! }) } as never })

  const issue = (number: number) => gh<Issue>('GET', `/repos/${FULL}/issues/${number}`)
  const comments = (number: number) => gh<Array<{ body: string }>>('GET', `/repos/${FULL}/issues/${number}/comments`)
  const labelNames = async (number: number) => (await issue(number)).labels.map((l) => l.name).sort()

  /** One call over the daemon's real MCP control socket, exactly what the `mcp-bridge` subprocess sends. */
  function callTool(sid: string, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const target = mcp.get(sid)
    if (!target) throw new Error(`no MCP endpoint for session ${sid}`)
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(target.endpoint)
      let buf = ''
      socket.setEncoding('utf8')
      socket.on('error', reject)
      socket.on('connect', () => socket.write(encodeFrame({ id: 1, token: target.token, op: 'callTool', name, args })))
      socket.on('data', (chunk: string) => {
        buf += chunk
        const { messages } = decodeFrames<IpcResponse>(buf)
        const reply = messages[0]
        if (!reply) return
        socket.destroy()
        resolve(reply.ok ? { ok: true, result: reply.result } : { ok: false, error: reply.error })
      })
    })
  }

  function remember(sid: string, servers: unknown): void {
    for (const server of (servers as Array<{ env?: Array<{ name: string; value: string }> }>) ?? []) {
      const env = Object.fromEntries((server.env ?? []).map((e) => [e.name, e.value]))
      if (env.AC_MCP_ENDPOINT && env.AC_MCP_TOKEN)
        mcp.set(sid, { endpoint: env.AC_MCP_ENDPOINT, token: env.AC_MCP_TOKEN })
    }
  }

  const host = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async (_cwd: string, servers?: unknown) => {
      const sid = randomUUID()
      remember(sid, servers)
      return sid
    }),
    loadSession: vi.fn(async (sid: string, _cwd: string, servers?: unknown) => remember(sid, servers)),
    modelOptions: () => null,
    hasSession: () => true,
    permissionModeOptions: () => ({ current: 'agent', modes: ['read-only', 'agent'] }),
    setSessionPermissionMode: vi.fn(async () => true),
    setSessionModel: async () => true,
    setSessionEffort: async () => true,
    setSessionFastMode: async () => true,
    prompt: vi.fn(async (sid: string, blocks: Array<{ type: string; text?: string }>) => {
      const text = blocks.map((b) => b.text ?? '').join('\n')
      promptTexts.push(text)
      await script({
        n: promptTexts.length,
        sid,
        text,
        tool: (name, args = {}) => callTool(sid, name, args)
      })
      return { stopReason: 'end_turn' }
    }),
    cancel: async () => {},
    forgetSession: () => {},
    stop: async () => {}
  }

  beforeAll(async () => {
    phase('setup: live repository and human token')
    expect(BigInt((await gh<{ id: number }>('GET', `/repos/${FULL}`)).id)).toBe(REPO_ID)
    const existing = new Set<string>()
    for (let page = 1; ; page++) {
      const labels = await gh<Array<{ name: string }>>('GET', `/repos/${FULL}/labels?per_page=100&page=${page}`)
      for (const label of labels) existing.add(label.name)
      if (labels.length < 100) break
    }
    for (const status of ['triage', 'ready', 'running', 'review', 'done', 'blocked']) {
      const name = `ac/status:${status}`
      // Read before creating so existing repository labels are never modified.
      if (existing.has(name)) continue
      await gh('POST', `/repos/${FULL}/labels`, { name, color: 'ededed' })
      createdLabels.push(name)
    }
    root = mkdtempSync(join(tmpdir(), 'kanban-m4-e2e-'))
    for (const [id, name] of [
      [agentId, 'kanban-m4-worker'],
      [verifierId, 'kanban-m4-verifier']
    ] as const) {
      const workspace = join(root, 'agents', id, 'workspace')
      mkdirSync(workspace, { recursive: true })
      writeFileSync(
        join(root, 'agents', id, 'agent.json'),
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
        dispatcher?.stop()
        await dispatcher?.settle()
        await daemon?.stop()
      })(),
      ...createdLabels.map((name) => gh('DELETE', `/repos/${FULL}/labels/${encodeURIComponent(name)}`)),
      ...issues.map(async (number) => {
        await gh('PATCH', `/repos/${FULL}/issues/${number}`, { state: 'closed', state_reason: 'not_planned' })
        expect(await issue(number)).toMatchObject({ state: 'closed', state_reason: 'not_planned' })
        phase('cleanup: confirmed closed/not_planned', { issue: number })
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
    worker = (daemon as any).kanbanWorker()
    await vi.waitFor(() => expect((daemon as any).cpClient?.state).toBe('READY'), { timeout: 20_000, interval: 250 })
    epoch = Number((await prisma.daemon.findUniqueOrThrow({ where: { id: daemonId } })).sessionEpoch)
    phase('setup: daemon connected to the CP over WebSocket', { epoch })
  }

  const waitFor = (fn: () => Promise<void>, timeout = 45_000) => vi.waitFor(fn, { timeout, interval: 1_000 })
  const board = (data: Record<string, unknown>) => prisma.kanbanBoard.update({ where: { id: boardId }, data })

  /** A scratch issue plus a ready card for the worker agent; the caller drives the dispatcher. */
  async function createCard(name: string) {
    const created = await gh<Issue>('POST', `/repos/${FULL}/issues`, {
      title: `[kanban-e2e] lane3a ${name} ${started}`,
      body: `Scratch issue for the opt-in Kanban M4 live check (${name}). No repository changes are requested.`,
      labels: ['ac/status:ready']
    })
    issues.push(created.number)
    const card = await prisma.kanbanCard.create({
      data: {
        boardId,
        issueId: BigInt(created.id),
        issueNumber: created.number,
        status: 'ready',
        assigneeAgentId: agentId
      }
    })
    promptTexts = []
    slackPosts.length = 0
    return { created, card }
  }

  const cardRow = (id: string) => prisma.kanbanCard.findUniqueOrThrow({ where: { id } })
  const runsOf = (cardId: string) => prisma.kanbanRun.findMany({ where: { cardId }, orderBy: { attempt: 'asc' } })

  /** Wait until the card has `count` ended runs and sits in `status` with no open run. */
  async function settled(cardId: string, count: number, status: string) {
    await waitFor(async () => {
      const runs = await runsOf(cardId)
      expect(runs).toHaveLength(count)
      expect(runs.every((r) => r.endedAt !== null)).toBe(true)
      expect((await cardRow(cardId)).status).toBe(status)
    }, 120_000)
    await dispatcher!.settle()
    await notifier!.drain()
  }

  async function scenario(name: string, engine: string, fn: (record: (n: number) => void) => Promise<void>) {
    const t0 = Date.now()
    const result: ScenarioResult = { name, engine, ms: 0, pass: false }
    try {
      await fn((n) => {
        result.issue = n
      })
      result.pass = true
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err)
      console.error(`KANBAN_M4_E2E scenario failed: ${name}`, err)
    } finally {
      result.ms = Date.now() - t0
      results.push(result)
      phase(`scenario ${result.pass ? 'PASS' : 'FAIL'}: ${name}`, result)
      if (!result.pass) {
        const failedCard = await prisma.kanbanCard.findFirst({ where: { boardId, issueNumber: result.issue ?? -1 } })
        if (failedCard)
          phase('failed card runs', {
            card: {
              status: failedCard.status,
              cooldownUntil: failedCard.cooldownUntil,
              failures: failedCard.consecutiveFailures
            },
            runs: (await runsOf(failedCard.id)).map((r) => [r.role, r.outcome, r.reasonCode])
          })
      }
      // Drop the card so the dispatcher can never re-run a finished scratch card.
      await prisma.kanbanCard.deleteMany({ where: { boardId, issueNumber: result.issue ?? -1 } })
    }
  }

  const isVerifyTurn = (turn: Turn) => turn.text.includes("board's Verifier")

  it('routes review cards to the verifier, gates request-changes by role, and posts transition notifications', async () => {
    await seedDaemon(prisma, daemonId, { sessionEpoch: 4n })
    await seedAgent(prisma, agentId, { daemonId, runtime: 'claude' })
    await seedAgent(prisma, verifierId, { daemonId, runtime: 'claude' })
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
    await prisma.bot.create({ data: { id: botId, orgId: DEFAULT_ORG_ID, platform: 'slack', name: `m4-e2e-${botId}` } })
    await prisma.integration.create({
      data: { id: integrationId, orgId: DEFAULT_ORG_ID, agentId, botId, platform: 'slack', name: 'm4-e2e' }
    })
    await startLinkedDaemon()
    // The fake Slack target: the daemon's real notify handler posts through this recording connection, never the Slack API.
    ;(daemon as any).agents.get(agentId).integrations = [{ id: integrationId }]
    vi.spyOn(daemon as any, 'replyConnFor').mockReturnValue({
      postMessage: async (channel: string, text: string) => {
        slackPosts.push({ channel, text })
      }
    })
    boardId = (
      await prisma.kanbanBoard.create({
        data: { orgId: DEFAULT_ORG_ID, name: `m4-e2e ${started}`, repoId: REPO_ID, repoFullName: FULL }
      })
    ).id
    const notifyRepo = new PgKanbanNotifyRepo(prisma)
    notifier = new KanbanNotifier({
      repo: notifyRepo,
      integration: { getUnscoped: async () => ({ id: integrationId, agentId, status: 'active' }) as never },
      agent: { get: async () => ({ id: agentId, daemonId }) as never },
      resolveMention: async () => null,
      isDaemonLive: (id) => id === daemonId,
      send: (_id, n) => (daemon as any).kanbanNotify(n),
      clock: systemClock,
      log: { warn: (_o: unknown, m?: string) => phase(`WARN ${m ?? ''}`), info: () => {} }
    })
    dispatcher = new KanbanDispatcher({
      repo: new PgKanbanDispatchRepo(prisma),
      installations: { liveByOrgAndAccount: async () => installation },
      store,
      send: async (id, dispatch) => {
        expect(id).toBe(daemonId)
        return worker.dispatch(dispatch)
      },
      isDaemonLive: (id) => id === daemonId,
      clock: systemClock,
      notify: {
        enqueue: (transition, revision) => enqueueTransition(notifyRepo, transition, revision),
        drain: () => notifier!.drain()
      },
      log: { debug: () => {}, info: () => {}, warn: (_o: unknown, m?: string) => phase(`WARN ${m ?? ''}`) }
    })
    ;(worker as any).deps.cp = () => ({
      ready: () => true,
      heartbeat: async (payload: { leases: Parameters<KanbanDispatcher['onHeartbeat']>[2] }) => ({
        superseded: await dispatcher!.onHeartbeat(daemonId, epoch, payload.leases)
      }),
      report: (report: KanbanReport) => dispatcher!.onReport(daemonId, epoch, report)
    })
    // No GitHub App here: the CP-side lease check still runs in-process, and the PAT stands in for the minted token.
    ;(daemon as any).gitCreds.getKanbanCommentToken = async (id: string, repo: string, leaseId: string) => {
      const allowed =
        (await dispatcher!.commentGrant(daemonId, id, leaseId, repo)) ??
        (await dispatcher!.liveCommentGrant(daemonId, epoch, id, leaseId, repo))
      if (!allowed) throw new Error(`kanban comment refused for lease ${leaseId} on ${repo}`)
      return { token: TOKEN! }
    }

    await scenario('v1 review loop', 'fake ACP worker + verifier', async (record) => {
      await board({ verifierAgentId: verifierId, targetChannel: 'C0E2EANCHOR', targetIntegrationId: integrationId })
      let verifyTurns = 0
      script = async (turn) => {
        if (isVerifyTurn(turn)) {
          verifyTurns++
          const out =
            verifyTurns === 1
              ? await turn.tool('kanbanRequestChanges', { reason: 'KANBAN_E2E_CHANGES please add a test' })
              : await turn.tool('kanbanComplete', { summary: 'KANBAN_E2E_APPROVED looks good' })
          expect(out.ok, out.error).toBe(true)
        } else {
          const out = await turn.tool('kanbanComplete', { summary: `KANBAN_E2E_WORK round ${promptTexts.length}` })
          expect(out.ok, out.error).toBe(true)
        }
      }
      const { created, card } = await createCard('v1 review-loop')
      record(created.number)
      await dispatcher!.reconcileBoard(boardId)
      await settled(card.id, 4, 'done')
      const runs = await runsOf(card.id)
      expect(runs.map((r) => [r.role, r.agentId, r.outcome])).toEqual([
        ['work', agentId, 'completed'],
        ['verify', verifierId, 'changes_requested'],
        ['work', agentId, 'completed'],
        ['verify', verifierId, 'completed']
      ])
      expect(await cardRow(card.id)).toMatchObject({
        status: 'done',
        assigneeAgentId: agentId,
        consecutiveFailures: 0,
        reviewRounds: 0
      })
      await waitFor(async () => {
        expect(await labelNames(created.number)).toEqual(['ac/status:done'])
        expect(await issue(created.number)).toMatchObject({ state: 'closed', state_reason: 'completed' })
        const posted = await comments(created.number)
        expect(posted).toHaveLength(4)
        for (const run of runs)
          expect(posted.filter((c) => c.body.includes(kanbanLeaseMarker(run.leaseId)))).toHaveLength(1)
      })
      const link = `<https://github.com/${FULL}/issues/${created.number}>`
      expect(slackPosts.map((p) => p.channel)).toEqual(Array(4).fill('C0E2EANCHOR'))
      expect(slackPosts.map((p) => p.text.match(/→ (\w+)/)![1])).toEqual(['review', 'ready', 'review', 'done'])
      for (const post of slackPosts)
        expect(post.text).toBe(`Kanban: ${FULL}#${created.number} → ${post.text.match(/→ (\w+)/)![1]} ${link}`)
    })

    await scenario('v2 B8 verifier is the worker', 'fake ACP worker', async (record) => {
      await board({ verifierAgentId: agentId, targetChannel: null })
      script = async (turn) => {
        const out = await turn.tool('kanbanComplete', { summary: 'KANBAN_E2E_SELF work done' })
        expect(out.ok, out.error).toBe(true)
      }
      const { created, card } = await createCard('v2 b8')
      record(created.number)
      await dispatcher!.reconcileBoard(boardId)
      await settled(card.id, 1, 'review')
      await dispatcher!.reconcileBoard(boardId)
      await dispatcher!.settle()
      expect(await runsOf(card.id)).toHaveLength(1)
      expect(await cardRow(card.id)).toMatchObject({
        status: 'review',
        needsAttention: true,
        attentionReason: 'verifier_is_worker'
      })
      await waitFor(async () => {
        const posted = await comments(created.number)
        expect(posted).toHaveLength(2)
        // The worker's summary plus the one B8 explanation, which alone names the verifier.
        expect(posted.filter((c) => c.body.includes('verifier'))).toHaveLength(1)
      })
      expect(slackPosts).toEqual([])
    })

    await scenario('v3 role gating', 'fake ACP worker', async (record) => {
      await board({ verifierAgentId: null, targetChannel: null })
      const seen: { refused?: ToolOutcome } = {}
      script = async (turn) => {
        seen.refused = await turn.tool('kanbanRequestChanges', { reason: 'KANBAN_E2E_NOT_ALLOWED' })
        const out = await turn.tool('kanbanComplete', { summary: 'KANBAN_E2E_GATED done' })
        expect(out.ok, out.error).toBe(true)
      }
      const { created, card } = await createCard('v3 role-gating')
      record(created.number)
      await dispatcher!.reconcileBoard(boardId)
      await settled(card.id, 1, 'done')
      expect(seen.refused).toMatchObject({ ok: false, error: expect.stringContaining('not_verifier') })
      expect((await runsOf(card.id))[0]).toMatchObject({ role: 'work', outcome: 'completed' })
      expect(await cardRow(card.id)).toMatchObject({ reviewRounds: 0, consecutiveFailures: 0 })
    })

    await scenario('n1 needs_input posts one anchor note', 'fake ACP worker + fake Slack', async (record) => {
      await board({ verifierAgentId: null, targetChannel: 'C0E2EANCHOR', targetIntegrationId: integrationId })
      script = async (turn) => {
        const out = await turn.tool('kanbanBlock', {
          summary: 'KANBAN_E2E_NEEDS which database should this use?',
          kind: 'needs_input',
          reason: 'needs_decision'
        })
        expect(out.ok, out.error).toBe(true)
      }
      const { created, card } = await createCard('n1 needs-input')
      record(created.number)
      await dispatcher!.reconcileBoard(boardId)
      await settled(card.id, 1, 'blocked')
      await waitFor(async () => expect(await labelNames(created.number)).toEqual(['ac/status:blocked']))
      // No CP user→Slack linkage resolves within the integration's workspace (known gap), so there is no mention.
      expect(slackPosts).toEqual([
        {
          channel: 'C0E2EANCHOR',
          text: `Kanban: ${FULL}#${created.number} → blocked (needs input) <https://github.com/${FULL}/issues/${created.number}>`
        }
      ])
    })

    await scenario('n2 headless board posts nothing', 'fake ACP worker + fake Slack', async (record) => {
      await board({ verifierAgentId: null, targetChannel: null })
      script = async (turn) => {
        const out = await turn.tool('kanbanBlock', {
          summary: 'KANBAN_E2E_HEADLESS blocked quietly',
          kind: 'needs_input',
          reason: 'needs_decision'
        })
        expect(out.ok, out.error).toBe(true)
      }
      const { created, card } = await createCard('n2 headless')
      record(created.number)
      await dispatcher!.reconcileBoard(boardId)
      await settled(card.id, 1, 'blocked')
      expect(slackPosts).toEqual([])
      expect(await prisma.kanbanNotification.count({ where: { cardId: card.id } })).toBe(0)
    })

    for (const r of results) console.log(`KANBAN_M4_E2E_RESULT ${JSON.stringify(r)}`)
    const failed = results.filter((r) => !r.pass)
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([])
  }, 900_000)
})
