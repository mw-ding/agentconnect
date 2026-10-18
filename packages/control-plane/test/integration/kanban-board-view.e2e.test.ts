// Live GitHub + Postgres + an in-process CP and a linked daemon: the board view routes, live titles, the dry-run explain, and the CLI.
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { buildApp, type App } from '../../src/app.js'
import { AppConfigSchema } from '../../src/config/env.js'
import { systemClock } from '../../src/domain/clock.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'
import { runDispatchCommand } from '../../../cli/src/dispatch-dry-run.js'
import type { Daemon } from '../../../daemon/src/daemon.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { prisma } from '../setup.db.js'

const TOKEN = process.env.GITHUB_TOKEN
const enabled = !process.env.CI && process.env.KANBAN_E2E === '1' && !!TOKEN
const OWNER = 'mw-ding'
const FULL = `${OWNER}/agentconnect`
const REPO_ID = 1332342098n
const PEPPER = 'kanban-e2e-pepper-0123456789abcdef'
const INSTALLATION_ID = 424243n
const CLI_DIR = fileURLToPath(new URL('../../../cli', import.meta.url))
const run = promisify(execFile)

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
  return (await response.json()) as T
}

interface Issue {
  id: number
  number: number
  title: string
  state: string
  state_reason: string | null
}

interface ScenarioResult {
  name: string
  issues: number[]
  ms: number
  pass: boolean
  error?: string
}

describe.skipIf(!enabled)('kanban board view e2e (live GitHub)', () => {
  const started = Date.now()
  const daemonId = randomUUID()
  const offlineDaemonId = randomUUID()
  const agentId = randomUUID()
  const offlineAgentId = randomUUID()
  const issues: number[] = []
  const results: ScenarioResult[] = []
  const cards: Array<{ id: string; issueNumber: number }> = []
  let boardId = ''
  let root: string | undefined
  let daemon: Daemon | undefined
  let app: App | undefined
  let cpOrigin = ''
  let userKey = ''
  const phase = (name: string, observed: unknown = {}) =>
    console.log(`${new Date().toISOString()} +${Date.now() - started}ms ${name}`, observed)

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
    prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
    cancel: async () => {},
    forgetSession: () => {},
    stop: async () => {}
  }

  const api = async <T>(path: string): Promise<{ status: number; headers: Headers; body: T }> => {
    const res = await fetch(`${cpOrigin}/api/v1/orgs/${DEFAULT_ORG_ID}/kanban/boards/${boardId}${path}`, {
      headers: { authorization: `Bearer ${userKey}` }
    })
    return { status: res.status, headers: res.headers, body: (await res.json()) as T }
  }

  /** Every kanban_* and audit row as text, so a leaked title anywhere in the database is found. */
  async function databaseText(): Promise<string> {
    const rows = await prisma.$queryRawUnsafe<Array<{ t: string }>>(`
      SELECT row_to_json(x)::text AS t FROM kanban_board x
      UNION ALL SELECT row_to_json(x)::text FROM kanban_card x
      UNION ALL SELECT row_to_json(x)::text FROM kanban_run x
      UNION ALL SELECT row_to_json(x)::text FROM audit_event x`)
    return rows.map((r) => r.t).join('\n')
  }

  async function scratchIssue(scenario: string): Promise<Issue> {
    const created = await gh<Issue>('POST', `/repos/${FULL}/issues`, {
      title: `[kanban-e2e] lane4b ${scenario} ${started}`,
      body: `Scratch issue for the opt-in Kanban 4b live check (${scenario}). No repository changes are requested.`
    })
    issues.push(created.number)
    return created
  }

  async function scenario(name: string, fn: (record: (n: number) => void) => Promise<void>) {
    const t0 = Date.now()
    const result: ScenarioResult = { name, issues: [], ms: 0, pass: false }
    try {
      await fn((n) => result.issues.push(n))
      result.pass = true
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err)
      console.error(`KANBAN_4B_E2E scenario failed: ${name}`, err)
    } finally {
      result.ms = Date.now() - t0
      results.push(result)
      console.log('KANBAN_4B_E2E', JSON.stringify(result))
    }
  }

  beforeAll(async () => {
    phase('setup: live repository')
    expect(BigInt((await gh<{ id: number }>('GET', `/repos/${FULL}`)).id)).toBe(REPO_ID)
    root = mkdtempSync(join(tmpdir(), 'kanban-4b-e2e-'))
    const workspace = join(root, 'agents', agentId, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(
      join(root, 'agents', agentId, 'agent.json'),
      JSON.stringify({
        id: agentId,
        name: 'kanban-4b-e2e',
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

  // Rows are seeded inside the test: the harness truncates the database before each test.
  async function seedWorld() {
    await seedDaemon(prisma, daemonId, { sessionEpoch: 4n })
    await seedDaemon(prisma, offlineDaemonId, { sessionEpoch: 1n })
    await seedAgent(prisma, agentId, { daemonId, runtime: 'claude', name: 'e2e-live' })
    await seedAgent(prisma, offlineAgentId, { daemonId: offlineDaemonId, runtime: 'claude', name: 'e2e-offline' })
    await prisma.githubInstallation.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        installationId: INSTALLATION_ID,
        accountLogin: OWNER,
        accountType: 'User',
        repositorySelection: 'selected',
        permissions: { issues: 'read', metadata: 'read' }
      }
    })
    const codec = new ApiKeyCodec({ API_KEY_PEPPER: PEPPER })
    const daemonKey = codec.mint()
    await prisma.apiKey.create({
      data: {
        principalType: 'daemon',
        orgId: DEFAULT_ORG_ID,
        daemonId,
        hash: daemonKey.hash,
        displayTail: daemonKey.displayTail
      }
    })
    const personal = codec.mint()
    await prisma.apiKey.create({
      data: {
        principalType: 'user',
        userId: DEFAULT_OWNER_ID,
        orgId: DEFAULT_ORG_ID,
        hash: personal.hash,
        displayTail: personal.displayTail
      }
    })
    userKey = personal.token
    writeFileSync(
      join(root!, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: true, url: cpOrigin, key: daemonKey.token },
        logging: { level: 'error' },
        runtimes: { claude: { command: 'node', args: ['unused'] } }
      })
    )
    const { Daemon } = await import('../../../daemon/src/daemon.js')
    daemon = new Daemon({ root, hostFactory: () => host as never })
    await daemon.start()
    await vi.waitFor(() => expect((daemon as any).cpClient?.state).toBe('READY'), { timeout: 20_000, interval: 250 })
    boardId = (
      await prisma.kanbanBoard.create({
        data: {
          orgId: DEFAULT_ORG_ID,
          name: `4b-e2e ${started}`,
          repoId: REPO_ID,
          repoFullName: FULL,
          maxInProgress: 3,
          maxInProgressPerAgent: 1
        }
      })
    ).id
    phase('setup: daemon READY, board seeded', { boardId })
  }

  afterAll(async () => {
    const cleanup = await Promise.allSettled([
      daemon?.stop(),
      ...issues.map(async (number) => {
        await gh('PATCH', `/repos/${FULL}/issues/${number}`, { state: 'closed', state_reason: 'not_planned' })
        expect(await gh<Issue>('GET', `/repos/${FULL}/issues/${number}`)).toMatchObject({
          state: 'closed',
          state_reason: 'not_planned'
        })
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

  it('serves the board view, live titles, the explain routes and the dry-run CLI', async () => {
    await seedWorld()
    const one = await scratchIssue('v1 no-assignee')
    const two = await scratchIssue('v2 cooldown')
    const three = await scratchIssue('x1 eligible')
    const future = new Date(Date.now() + 3_600_000)
    const seed = async (issue: Issue, data: Record<string, unknown>) => {
      const card = await prisma.kanbanCard.create({
        data: { boardId, issueId: BigInt(issue.id), issueNumber: issue.number, status: 'ready', ...data }
      })
      cards.push({ id: card.id, issueNumber: issue.number })
      return card
    }
    const c1 = await seed(one, { priority: 1 })
    const c2 = await seed(two, { priority: 2, assigneeAgentId: agentId, cooldownUntil: future, consecutiveFailures: 1 })
    const c3 = await seed(three, { priority: 3, assigneeAgentId: agentId })

    await scenario('v1 cards route lists the 3 cards with correct metadata', async (record) => {
      for (const i of [one, two, three]) record(i.number)
      const res = await api<{ cards: any[]; total: number; truncated: boolean }>('/cards')
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ total: 3, truncated: false })
      expect(res.body.cards.map((c) => c.issueNumber)).toEqual([three.number, two.number, one.number])
      const byNumber = new Map(res.body.cards.map((c) => [c.issueNumber, c]))
      expect(byNumber.get(one.number)).toMatchObject({ status: 'ready', assignee: null, mode: 'read', priority: 1 })
      expect(byNumber.get(two.number)).toMatchObject({
        assignee: { name: 'e2e-live' },
        consecutiveFailures: 1,
        cooldownUntil: future.toISOString()
      })
      expect(byNumber.get(three.number)).toMatchObject({ assigneeAgentId: agentId, openRun: null })
      expect(JSON.stringify(res.body)).not.toContain('lane4b')
    })

    await scenario('v2 titles route returns live GitHub titles, follows a rename, persists nothing', async (record) => {
      for (const i of [one, two, three]) record(i.number)
      const numbers = [one, two, three].map((i) => i.number).join(',')
      const first = await api<{ titles: Record<string, { title: string; state: string }>; missing: number[] }>(
        `/cards/titles?numbers=${numbers}`
      )
      expect(first.status).toBe(200)
      expect(first.headers.get('cache-control')).toBe('no-store')
      expect(first.body.missing).toEqual([])
      for (const i of [one, two, three]) {
        expect(first.body.titles[String(i.number)]).toMatchObject({ title: i.title, state: 'open' })
      }
      const renamed = `[kanban-e2e] lane4b v2 renamed ${started}`
      await gh('PATCH', `/repos/${FULL}/issues/${one.number}`, { title: renamed })
      // Within the 60 s in-memory TTL the cached title is still served; past it the rename appears (live ETag
      // revalidation), so a rename takes up to about a minute to reach the board.
      const cached = await api<{ titles: Record<string, { title: string }> }>(`/cards/titles?numbers=${one.number}`)
      expect(cached.body.titles[String(one.number)]?.title).toBe(one.title)
      await vi.waitFor(
        async () => {
          const next = await api<{ titles: Record<string, { title: string }> }>(`/cards/titles?numbers=${one.number}`)
          expect(next.body.titles[String(one.number)]?.title).toBe(renamed)
        },
        { timeout: 90_000, interval: 5_000 }
      )
      const notCard = await api<{ titles: object; missing: number[] }>(`/cards/titles?numbers=${one.number},999999`)
      expect(notCard.body.missing).toEqual([999999])
      const stored = await databaseText()
      expect(stored).not.toContain('lane4b')
      expect(stored).not.toContain(renamed)
    })

    await scenario('x1 explain: no_assignee, cooldown, eligible; nothing changes', async (record) => {
      for (const i of [one, two, three]) record(i.number)
      const offline = await prisma.kanbanCard.create({
        data: {
          boardId,
          issueId: 9_000_000_001n,
          issueNumber: 9001,
          status: 'ready',
          assigneeAgentId: offlineAgentId,
          priority: 0
        }
      })
      const snapshot = async () => ({
        cards: await prisma.kanbanCard.findMany({ orderBy: { id: 'asc' } }),
        runs: await prisma.kanbanRun.count(),
        audit: await prisma.auditEvent.count()
      })
      const before = await snapshot()
      const gate = async (cardId: string) =>
        await api<{ verdict: { eligible: boolean; gate?: string; agentId?: string }; hint: string }>(
          `/cards/${cardId}/explain`
        )
      const a = await gate(c1.id)
      expect(a.body.verdict).toEqual({ eligible: false, gate: 'no_assignee' })
      const b = await gate(c2.id)
      expect(b.body.verdict).toEqual({ eligible: false, gate: 'cooldown' })
      expect(b.body.hint).toContain(future.toISOString())
      const c = await gate(c3.id)
      expect(c.body.verdict).toEqual({ eligible: true, role: 'work', agentId })
      const d = await gate(offline.id)
      expect(d.body.verdict).toEqual({ eligible: false, gate: 'daemon_offline' })
      expect(await snapshot()).toEqual(before)
      await prisma.kanbanCard.delete({ where: { id: offline.id } })
    })

    await scenario('c1 CLI dispatch --dry-run prints the expected gates', async (record) => {
      for (const i of [one, two, three]) record(i.number)
      const apiUrl = `${cpOrigin.replace('http', 'ws')}/daemon/ws`
      // The daemon key `login` saved in config.json is never enough on its own: without an explicit personal key
      // the command refuses with personal_api_key_required instead of sending the stored key to a 401.
      const savedEnv = process.env.AGENTCONNECT_API_KEY
      delete process.env.AGENTCONNECT_API_KEY
      try {
        const refused = await runDispatchCommand(
          { root: root!, dryRun: true, board: boardId, apiUrl },
          { fetch, out: () => {} }
        ).catch((e: unknown) => e)
        expect(refused).toMatchObject({ code: 'personal_api_key_required' })
      } finally {
        if (savedEnv !== undefined) process.env.AGENTCONNECT_API_KEY = savedEnv
      }
      const lines: string[] = []
      await runDispatchCommand(
        { root: root!, dryRun: true, board: boardId, apiUrl, apiKey: userKey },
        { fetch, out: (l) => void lines.push(l) }
      )
      expect(lines).toEqual([
        `#${three.number} ready → ELIGIBLE (work → agent ${agentId})`,
        expect.stringMatching(new RegExp(`^#${two.number} ready → blocked by cooldown: cooling down until `)),
        `#${one.number} ready → blocked by no_assignee: no agent is assigned to this card`,
        `would claim next: #${three.number}`
      ])
      // The real CLI process, addressed by issue number and as JSON.
      const base = ['--conditions=development', '--import', 'tsx', 'src/index.ts', 'dispatch', '--dry-run']
      const issueRun = await run(
        process.execPath,
        [...base, '--board', boardId, '--issue', String(two.number), '--api-url', apiUrl, '--api-key', userKey],
        { cwd: CLI_DIR, env: { ...process.env, AGENTCONNECT_ROOT: root } }
      )
      expect(issueRun.stdout.trim()).toMatch(new RegExp(`^#${two.number} ready → blocked by cooldown: `))
      const jsonRun = await run(
        process.execPath,
        [...base, '--board', boardId, '--card', c3.id, '--json', '--api-url', apiUrl, '--api-key', userKey],
        { cwd: CLI_DIR, env: { ...process.env, AGENTCONNECT_ROOT: root } }
      )
      expect(JSON.parse(jsonRun.stdout)).toMatchObject({ cardId: c3.id, verdict: { eligible: true } })
      expect(jsonRun.stdout + issueRun.stdout).not.toContain('lane4b')
    })

    await scenario('x2 board explain wouldClaimNext matches the next real claim', async (record) => {
      for (const i of [one, two, three]) record(i.number)
      // A second eligible card for the same agent: the per-agent cap of 1 must defer it behind c3.
      const extra = await prisma.kanbanCard.create({
        data: {
          boardId,
          issueId: 9_000_000_002n,
          issueNumber: 9002,
          status: 'ready',
          assigneeAgentId: agentId,
          priority: 0
        }
      })
      const explained = await api<{ wouldClaimNext: string[]; cards: Array<{ cardId: string; capBound?: string }> }>(
        '/explain'
      )
      expect(explained.body.wouldClaimNext).toEqual([c3.id])
      expect(explained.body.cards.find((c) => c.cardId === extra.id)?.capBound).toBe('agent_cap')
      const claimed = await new PgKanbanDispatchRepo(prisma).claim(boardId, {
        now: new Date(),
        isDaemonLive: (id) => id === daemonId
      })
      expect(claimed.map((l) => l.cardId)).toEqual(explained.body.wouldClaimNext)
      const after = await api<{ wouldClaimNext: string[] }>('/explain')
      expect(after.body.wouldClaimNext).toEqual([])
    })

    const failed = results.filter((r) => !r.pass)
    expect(failed, JSON.stringify(failed)).toEqual([])
  }, 300_000)
})
