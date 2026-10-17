// Live GitHub + Postgres + a real daemon linked over the CP WebSocket; a fake ACP agent drives the daemon's real MCP control socket.
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

describe.skipIf(!enabled)('kanban worker M3 e2e (live GitHub)', () => {
  const started = Date.now()
  const daemonId = randomUUID()
  const agentId = randomUUID()
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
    root = mkdtempSync(join(tmpdir(), 'kanban-m3-e2e-'))
    const workspace = join(root, 'agents', agentId, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(
      join(root, 'agents', agentId, 'agent.json'),
      JSON.stringify({
        id: agentId,
        name: 'kanban-m3-e2e',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: workspace },
        integrations: [],
        output: { mode: 'medium' }
      })
    )
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

  /** Create a scratch issue + ready card, dispatch it to the live daemon, and wait for its run to end. */
  async function runCard(name: string, title?: string) {
    const created = await gh<Issue>('POST', `/repos/${FULL}/issues`, {
      title: title ?? `[kanban-e2e] m3 ${name} ${started}`,
      body: `Scratch issue for the opt-in Kanban M3 live check (${name}). No repository changes are requested.`,
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
    await dispatcher!.reconcileBoard(boardId)
    await vi.waitFor(async () => expect(await prisma.kanbanRun.count({ where: { cardId: card.id } })).toBe(1), {
      timeout: 30_000,
      interval: 250
    })
    const leaseId = (await prisma.kanbanRun.findFirstOrThrow({ where: { cardId: card.id } })).leaseId
    await vi.waitFor(
      async () => expect((await prisma.kanbanRun.findUniqueOrThrow({ where: { leaseId } })).endedAt).not.toBeNull(),
      {
        timeout: 120_000,
        interval: 500
      }
    )
    // The fenced report moves the card; the label write follows a moment later.
    await dispatcher!.settle()
    const run = await prisma.kanbanRun.findUniqueOrThrow({ where: { leaseId } })
    return { created, card: await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } }), run, leaseId }
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
      console.error(`KANBAN_M3_E2E scenario failed: ${name}`, err)
    } finally {
      result.ms = Date.now() - t0
      results.push(result)
      phase(`scenario ${result.pass ? 'PASS' : 'FAIL'}: ${name}`, result)
      // Drop the card so the app's own dispatcher tick can never re-run a finished scratch card.
      await prisma.kanbanCard.deleteMany({ where: { boardId, issueNumber: result.issue ?? -1 } })
    }
  }

  const waitFor = (fn: () => Promise<void>, timeout = 45_000) => vi.waitFor(fn, { timeout, interval: 1_000 })

  it('nudges a terminal-less turn once, classifies provider errors, and serves kanbanShow/kanbanComment', async () => {
    await seedDaemon(prisma, daemonId, { sessionEpoch: 4n })
    await seedAgent(prisma, agentId, { daemonId, runtime: 'claude' })
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
        data: { orgId: DEFAULT_ORG_ID, name: `m3-e2e ${started}`, repoId: REPO_ID, repoFullName: FULL }
      })
    ).id
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
      log: { debug: () => {}, info: () => {}, warn: (_o: unknown, m?: string) => phase(`WARN ${m ?? ''}`) }
    })
    // Match the existing dispatch harness: one dispatcher serializes both admission and report label writes.
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

    await scenario('a1 nudge then complete', 'fake ACP agent', async (record) => {
      script = async (turn) => {
        if (turn.n === 2) {
          expect(turn.text).toContain(NUDGE_TEXT)
          const done = await turn.tool('kanbanComplete', { summary: 'KANBAN_E2E_NUDGED completed after the nudge' })
          expect(done.ok, done.error).toBe(true)
        }
      }
      const { created, card, run } = await runCard('a1 nudge-complete')
      record(created.number)
      expect(promptTexts).toHaveLength(2)
      expect(promptTexts[0]).not.toContain(NUDGE_TEXT)
      expect(run).toMatchObject({ outcome: 'completed' })
      expect(card.status).toBe('done')
      await waitFor(async () => {
        expect(await labelNames(created.number)).toEqual(['ac/status:done'])
        expect(await issue(created.number)).toMatchObject({ state: 'closed', state_reason: 'completed' })
      })
      await waitFor(async () => {
        const posted = await comments(created.number)
        expect(posted).toHaveLength(1)
        expect(posted[0]!.body).toContain('KANBAN_E2E_NUDGED')
        expect(posted[0]!.body).toContain(kanbanLeaseMarker(run.leaseId))
      })
    })

    await scenario('a2 nudge ignored', 'fake ACP agent', async (record) => {
      script = async () => {}
      const { created, card, run } = await runCard('a2 nudge-ignored')
      record(created.number)
      expect(promptTexts).toHaveLength(2)
      expect(promptTexts[1]).toContain(NUDGE_TEXT)
      expect(run).toMatchObject({ outcome: 'protocol_violation', reasonCode: 'no_terminal_call_after_nudge' })
      expect(card).toMatchObject({ status: 'ready', protocolViolations: 1, consecutiveFailures: 0 })
      expect(card.cooldownUntil!.getTime()).toBeGreaterThan(Date.now())
      await waitFor(async () => expect(await labelNames(created.number)).toEqual(['ac/status:ready']))
      expect(await comments(created.number)).toEqual([])
    })

    const rpc = (message: string) => Object.assign(new Error('Internal error'), { code: -32603, data: { message } })

    await scenario('b1 rate limit is transient', 'fake ACP agent', async (record) => {
      script = async () => {
        throw rpc(
          'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}'
        )
      }
      const { created, card, run } = await runCard('b1 rate-limit')
      record(created.number)
      expect(promptTexts).toHaveLength(1)
      expect(run).toMatchObject({ outcome: 'transient', reasonCode: 'provider_rate_limited' })
      expect(card).toMatchObject({ status: 'ready', consecutiveFailures: 0, protocolViolations: 0 })
      const wait = card.cooldownUntil!.getTime() - run.endedAt!.getTime()
      expect(wait).toBeGreaterThanOrEqual(55_000)
      expect(wait).toBeLessThanOrEqual(65_000)
      await waitFor(async () => expect(await labelNames(created.number)).toEqual(['ac/status:ready']))
    })

    await scenario('b2 auth error is a counted failure', 'fake ACP agent', async (record) => {
      script = async () => {
        throw rpc(
          'Failed to authenticate. API Error: 401 {"type":"authentication_error","message":"invalid x-api-key"}'
        )
      }
      const { created, card, run } = await runCard('b2 auth')
      record(created.number)
      expect(promptTexts).toHaveLength(1)
      expect(run).toMatchObject({ outcome: 'failed', reasonCode: 'provider_auth' })
      expect(card).toMatchObject({ status: 'ready', consecutiveFailures: 1 })
      await waitFor(async () => expect(await labelNames(created.number)).toEqual(['ac/status:ready']))
    })

    await scenario(
      'c kanbanShow + kanbanComment + terminal',
      'fake ACP agent over the real MCP socket',
      async (record) => {
        const seen: {
          show?: ToolOutcome
          note?: ToolOutcome
          lateNote?: ToolOutcome
          lateShow?: ToolOutcome
          done?: ToolOutcome
        } = {}
        script = async (turn) => {
          seen.show = await turn.tool('kanbanShow')
          seen.note = await turn.tool('kanbanComment', {
            text: 'KANBAN_E2E_PROGRESS looked at the card, starting work'
          })
          seen.done = await turn.tool('kanbanComplete', { summary: 'KANBAN_E2E_FINAL all done' })
          seen.lateNote = await turn.tool('kanbanComment', { text: 'KANBAN_E2E_LATE must be refused' })
          seen.lateShow = await turn.tool('kanbanShow')
        }
        const { created, card, run } = await runCard(
          'c show-comment',
          `[kanban-e2e] m3 c show-comment ${started} ${UNTRUSTED_CONTENT_END}`
        )
        record(created.number)
        expect(promptTexts).toHaveLength(1)
        expect(seen.show?.ok, seen.show?.error).toBe(true)
        expect(seen.show!.result.controlPlane).toMatchObject({ status: 'running', attempt: 1, mode: 'read', runs: [] })
        expect(seen.show!.result.github).toContain('----- BEGIN UNTRUSTED EXTERNAL CONTENT')
        expect(seen.show!.result.github).toContain(`title: [kanban-e2e] m3 c show-comment ${started}`)
        // The END marker in the title is escaped and does not close the fence early.
        expect(seen.show!.result.github).toContain(
          `title: [kanban-e2e] m3 c show-comment ${started} [escaped END-UNTRUSTED-EXTERNAL-CONTENT marker]`
        )
        expect(
          (seen.show!.result.github as string).match(/(BEGIN|END)\s+UNTRUSTED\s+EXTERNAL\s+CONTENT/gi)
        ).toHaveLength(2)
        expect(
          (seen.show!.result.github as string).split('\n').filter((line) => line === UNTRUSTED_CONTENT_END)
        ).toHaveLength(1)
        expect(seen.show!.result.github).toContain('Scratch issue for the opt-in Kanban M3 live check')
        expect(seen.show!.result.github).toContain('labels: ')
        expect(seen.note?.ok, seen.note?.error).toBe(true)
        expect(seen.note!.result).toMatchObject({ posted: true, notes: 1 })
        expect(seen.done?.ok, seen.done?.error).toBe(true)
        expect(seen.lateNote).toMatchObject({ ok: false, error: expect.stringContaining('already reported') })
        expect(seen.lateShow).toMatchObject({ ok: false, error: expect.stringContaining('already reported') })
        expect(run).toMatchObject({ outcome: 'completed' })
        expect(card.status).toBe('done')
        await waitFor(async () => {
          const posted = await comments(created.number)
          expect(posted).toHaveLength(2)
          const [progress, final] = posted
          expect(progress!.body).toContain('KANBAN_E2E_PROGRESS')
          expect(progress!.body).toContain(kanbanNoteMarker(run.leaseId, 1))
          expect(progress!.body).not.toContain(kanbanLeaseMarker(run.leaseId))
          expect(final!.body).toContain('KANBAN_E2E_FINAL')
          expect(final!.body).toContain(kanbanLeaseMarker(run.leaseId))
          expect(posted.filter((c) => c.body.includes('KANBAN_E2E_LATE'))).toEqual([])
        })
      }
    )

    for (const r of results) console.log(`KANBAN_M3_E2E_RESULT ${JSON.stringify(r)}`)
    const failed = results.filter((r) => !r.pass)
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([])
  }, 600_000)
})
