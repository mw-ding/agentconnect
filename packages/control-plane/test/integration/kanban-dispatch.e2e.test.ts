// Live GitHub + Postgres + daemon/ACP; only unavailable runtimes, control transport and the M3 terminal seam are stubbed.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { KanbanDispatch, KanbanReport } from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { systemClock } from '../../src/domain/clock.js'
import { OrgId } from '../../src/domain/ids.js'
import { GithubCardStore } from '../../src/kanban/card-store.js'
import { KanbanDispatcher } from '../../src/kanban/dispatcher.js'
import { KanbanGraphDoorbell } from '../../src/kanban/graph-doorbell.js'
import { PgKanbanBoardRepo } from '../../src/persistence/repositories/kanban.repo.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import type { GithubInstallationRecord } from '../../src/persistence/ports.js'
import type { Daemon } from '../../../daemon/src/daemon.js'
import type { KanbanWorker } from '../../../daemon/src/kanban/kanban-worker.js'
import type { LocalStore } from '../../../daemon/src/store/local-store.js'
import { GithubFinalPoster } from '../../../daemon/src/github/poster.js'
import { writeGhShim } from '../../../daemon/src/cp/gh-shim.js'
import { AcpHost } from '../../../daemon/src/acp/acp-host.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { prisma } from '../setup.db.js'

const TOKEN = process.env.GITHUB_TOKEN
const enabled = process.env.KANBAN_E2E === '1' && !!TOKEN
const OWNER = 'mw-ding'
const FULL = `${OWNER}/agentconnect`
const REPO_ID = 1332342098n

function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=development`.trim()
  }
  for (const key of Object.keys(env)) {
    if (/^(?:GH|GITHUB)_(?:.*_)?(?:TOKEN|PAT|AUTH_TOKEN)$|^GH_CONFIG_DIR$|^CLAUDECODE$|^AC_GITCRED_/i.test(key))
      delete env[key]
  }
  return env
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
  return (response.status === 204 ? undefined : await response.json()) as T
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
  const epoch = 4
  const issues: number[] = []
  const sends: KanbanDispatch[] = []
  const reports: KanbanReport[] = []
  let boardId = ''
  let root: string | undefined
  let daemon: Daemon | undefined
  let worker: KanbanWorker
  let local: LocalStore
  let dispatcher: KanbanDispatcher | undefined
  let bell: KanbanGraphDoorbell | undefined
  let cpReady = false
  let releaseTurn: (() => void) | undefined
  let modelTurn: Promise<unknown> | undefined
  let runtimeId = 'claude'
  let realAgent = false
  let workspace = ''
  let daemonEntry = ''
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
  // The supplied PAT stays in the test process; installation discovery and minting are not under test.
  const store = new GithubCardStore({ tokens: { mintKanbanCard: async () => ({ token: TOKEN! }) } as never })
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
      if (!labels.some((label) => label.name === name))
        await gh('POST', `/repos/${FULL}/labels`, { name, color: 'ededed' })
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
    daemon = new Daemon({
      root,
      hostFactory: (_agent, onUpdate) => {
        if (selected) {
          const runtime = new AcpHost(
            { command: 'npx', args: ['-y', selected.adapter], env: [] },
            {
              env: { ...agentEnv(), PATH: `${join(root!, 'run', 'bin')}:${process.env.PATH}` },
              inheritProcessEnv: false,
              suppressChildStderr: true,
              onUpdate: (sid, update) => {
                updates.push(update)
                onUpdate(sid, update)
              },
              onPermission: (sid, params) => (daemon as any).onAcpPermission(agentId, sid, params)
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
                text: 'Live test instruction: no GitHub credentials are provided. Do not inspect credentials or contact GitHub. To verify read-only enforcement, use your shell tool once to attempt `printf kanban-e2e > kanban-write-probe.txt` in this workspace. Do not request escalation or retry. Report the observed refusal and include KANBAN_READ_ONLY_REFUSED. Do not make any other writes.'
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
    phase('setup: real daemon started; in-process control link and injected M3 terminal seam', {
      agent: selected?.id ?? 'stub'
    })
  }, 120_000)

  afterAll(async () => {
    const cleanup = await Promise.allSettled([
      (async () => {
        bell?.stop()
        await bell?.settle()
        dispatcher?.stop()
        await dispatcher?.settle()
        cpReady = false
        releaseTurn?.()
        await daemon?.stop()
      })(),
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
    for (const result of [...cleanup, ...dbCleanup]) if (result.status === 'rejected') throw result.reason
  }, 120_000)

  it('recovers human-readied cards, dispatches fenced read leases, refuses writes, and reports review/done', async () => {
    // The integration harness truncates before each test, so seed all DB fixtures here.
    await seedDaemon(prisma, daemonId, { sessionEpoch: BigInt(epoch) })
    await seedAgent(prisma, agentId, { daemonId, runtime: runtimeId })
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: `dispatch-e2e ${started}`, repoId: REPO_ID, repoFullName: FULL }
    })
    boardId = board.id
    dispatcher = new KanbanDispatcher({
      repo: new PgKanbanDispatchRepo(prisma),
      installations: { liveByOrgAndAccount: async () => installation },
      store,
      send: async (id, dispatch) => {
        expect(id).toBe(daemonId)
        sends.push(dispatch)
        phase('c: real daemon worker dispatch', {
          issue: dispatch.issueNumber,
          mode: dispatch.mode,
          attempt: dispatch.attempt
        })
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
    // Keep the daemon's real worker/outbox and replace only the network boundary.
    ;(worker as any).deps.cp = () => cp
    bell = new KanbanGraphDoorbell({
      boards: new PgKanbanBoardRepo(prisma),
      installations: { getByInstallationId: async () => installation },
      store,
      onCard: async (changedBoard, _repo, number) => {
        await dispatcher!.onCardChanged(changedBoard.id, number)
        await snapshot('a: issues doorbell ingested human ready', currentCardId, number)
        dispatcher!.poke(changedBoard.id)
      },
      log
    })
    let currentCardId = ''

    for (const outcome of ['review_requested', 'completed'] as const) {
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
      currentCardId = c.id
      await dispatcher.reconcileBoard(boardId)
      await dispatcher.settle()
      const parkedRun = await prisma.kanbanRun.findFirstOrThrow({ where: { cardId: c.id } })
      expect(parkedRun).toMatchObject({ reasonCode: 'github_state_mismatch', outcome: 'transient', ackedAt: null })
      expect((await card(c.id)).status).toBe('triage')
      expect(sends.filter((d) => d.cardId === c.id)).toHaveLength(0)
      await snapshot('a: mismatch parked; no daemon dispatch', c.id, created.number)

      await gh('PUT', `/repos/${FULL}/issues/${created.number}/labels`, { labels: ['ac/status:ready'] })
      await vi.waitFor(async () => expect(await store.statusSetByHuman(ref, created.number, 'ready')).toBe(true), {
        timeout: 30_000,
        interval: 1_000
      })
      cpReady = true
      const deliveryKey = `dispatch-e2e-${created.number}`
      const promptCount = host.prompt.mock.calls.length
      bell.poke({
        deliveryKey,
        installationId: '1',
        repoId: String(REPO_ID),
        event: 'issues',
        action: 'labeled',
        ids: [String(created.id)],
        numbers: [created.number]
      })
      await bell.settle()
      await dispatcher.settle()
      expect(bell.landedDeliveryKeys([deliveryKey])).toEqual(new Set([deliveryKey]))
      await vi.waitFor(() => expect(host.prompt).toHaveBeenCalledTimes(promptCount + 1), { timeout: 30_000 })
      const d = sends.at(-1)!
      expect(d).toMatchObject({ cardId: c.id, attempt: 2, mode: 'read' })
      expect(await run(d.leaseId)).toMatchObject({
        ackedAt: expect.any(Date),
        endedAt: null,
        daemonEpoch: BigInt(epoch)
      })
      expect((await card(c.id)).status).toBe('running')
      expect((await issue(created.number)).labels.map((label) => label.name)).toEqual(['ac/status:running'])
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
        expect(existsSync(join(workspace, 'kanban-write-probe.txt'))).toBe(false)
        const events = updates as Array<{ sessionUpdate: string; content?: { text?: string } }>
        const answer = events
          .filter((event) => event.sessionUpdate === 'agent_message_chunk')
          .map((event) => event.content?.text ?? '')
          .join('')
        const tools = JSON.stringify(
          events.filter((event) => ['tool_call', 'tool_call_update'].includes(event.sessionUpdate))
        )
        expect(answer).toContain('KANBAN_READ_ONLY_REFUSED')
        const shellRefusalObserved =
          tools.includes('kanban-write-probe.txt') &&
          /Permission denied|Read-only file system|Operation not permitted/i.test(tools)
        phase('d: model reported refusal and probe file absent; gh refusal independently verified', {
          runtime: runtimeId,
          shellRefusalObserved
        })
        updates.length = 0
      }

      cpReady = false
      expect(worker.recordTerminal(d.leaseId, { outcome })).toBe(true)
      releaseTurn!()
      releaseTurn = undefined
      await vi.waitFor(() => expect(local.listKanbanReports(10)).toHaveLength(1), { timeout: 30_000 })
      expect(local.listKanbanReports(10)[0]).toMatchObject({ leaseId: d.leaseId, outcome })
      expect((await run(d.leaseId)).endedAt).toBeNull()
      phase('e: injected M3 terminal outcome persisted to real SQLite outbox while CP link offline', { outcome })
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
      expect(await dispatcher.onReport(daemonId, epoch, report)).toMatchObject({
        accepted: false,
        reason: 'superseded'
      })
      await snapshot('e: fenced report accepted, outbox ACK retained, duplicate refused', c.id, created.number)

      // M2 synthetic turns do not wire the hook poster; exercise it separately without claiming automatic delivery.
      expect(await gh<unknown[]>('GET', `/repos/${FULL}/issues/${created.number}/comments`)).toEqual([])
      const body = `[kanban-e2e] Injected M3 terminal outcome: ${outcome}. Live M2 dispatch/read-only/report check passed (agent: ${realAgent ? runtimeId : 'stub'}). Comment posted through the real daemon poster invoked explicitly by the test; M3 terminal tools and automatic Kanban final-comment wiring are not implemented.`
      const poster = new GithubFinalPoster(
        { token: async () => TOKEN!, log: { warn: (message) => phase(message) } },
        FULL,
        created.number
      )
      const published = await poster.publish(body)
      expect(published).toBeDefined()
      expect(await poster.publish(body)).toEqual(published)
      const comments = await gh<Array<{ body: string }>>('GET', `/repos/${FULL}/issues/${created.number}/comments`)
      expect(comments).toHaveLength(1)
      expect(comments[0]?.body).toContain(body)
      phase('e: real GitHub comment verified; poster invoked separately at missing automatic wiring seam', {
        issue: created.number
      })
    }
  }, 240_000)
})
