import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { LocalStore, sessionKey } from '../src/store/local-store.js'
import { buildKanbanMessage } from '../src/messages/kanban-message.js'
import { buildHookMessage } from '../src/messages/hook-message.js'
import type { KanbanDispatch, KanbanReport } from '@agentconnect.md/protocol'

const AGENT = '33333333-3333-4333-8333-333333333333'
const dispatch: KanbanDispatch = {
  boardId: '11111111-1111-4111-8111-111111111111',
  cardId: '22222222-2222-4222-8222-222222222222',
  agentId: AGENT,
  leaseId: '44444444-4444-4444-8444-444444444444',
  repoId: '123',
  repoFullName: 'acme/web',
  issueNumber: 42,
  attempt: 1,
  dispatchRevision: '3',
  sessionKeyPrefix: 'github:123',
  mode: 'read'
}
const roots: string[] = []
const daemons: Daemon[] = []
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function harness(git = false, modes = ['read-only', 'agent'], secrets?: { name: string; value: string }[]) {
  const root = mkdtempSync(join(tmpdir(), 'ac-kanban-'))
  roots.push(root)
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const agentDir = join(root, 'agents', AGENT)
  mkdirSync(agentDir, { recursive: true })
  const workspace = join(agentDir, 'workspace')
  mkdirSync(workspace)
  if (git) {
    execFileSync('git', ['init', '-b', 'main', workspace])
    execFileSync('git', [
      '-C',
      workspace,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'init'
    ])
  }
  writeFileSync(
    join(agentDir, 'agent.json'),
    JSON.stringify({
      id: AGENT,
      name: 'worker',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: workspace },
      integrations: [],
      output: { mode: 'medium' },
      ...(secrets ? { runtimeOverrides: { secrets } } : {})
    })
  )
  const host = {
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-card'),
    loadSession: vi.fn(async () => {}),
    modelOptions: vi.fn(() => null),
    hasSession: vi.fn(() => true),
    permissionModeOptions: vi.fn(() => ({ current: 'agent', modes })),
    setSessionPermissionMode: vi.fn(async () => true),
    prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
    setSessionModel: vi.fn(async () => true),
    setSessionEffort: vi.fn(async () => true),
    setSessionFastMode: vi.fn(async () => true),
    cancel: vi.fn(async () => {}),
    forgetSession: vi.fn(),
    stop: vi.fn(async () => {})
  }
  const daemon = new Daemon({ root, hostFactory: () => host as never })
  daemons.push(daemon)
  await daemon.start()
  if (git) {
    const agent = (daemon as any).agents.get(AGENT)
    agent.workspace = {
      ...agent.workspace,
      mode: 'git-repo',
      gitRepo: 'https://github.com/acme/web',
      isolation: 'shared'
    }
    const isolated = (daemon as any).workspaces.sessionWorktreePath(agent, key())
    execFileSync('git', ['-C', workspace, 'worktree', 'add', '-b', 'card-42', isolated])
    vi.spyOn(daemon as any, 'prepareAgentWorkspace').mockImplementation(async (_agent, _host, request) => {
      if (!request) return workspace
      expect(request).toMatchObject({ isolation: 'session' })
      return isolated
    })
  }
  return { daemon, worker: (daemon as any).kanbanWorker(), store: (daemon as any).store as LocalStore, host, workspace }
}

function key() {
  const m = buildKanbanMessage(dispatch, 'trace')
  return sessionKey(m.platform, m.channel, m.thread!, AGENT, m.transportScope)
}

it('tracks background work by the runtime id while reporting the outward session id', async () => {
  const h = await harness()
  let release!: () => void
  h.host.prompt.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ stopReason: 'end_turn' })
      })
  )
  await h.worker.dispatch(dispatch)
  await vi.waitFor(() => expect(h.host.prompt).toHaveBeenCalledOnce())
  const lease = h.worker.get(dispatch.leaseId)!
  const session = await h.store.getSession(lease.sessionKey)
  expect(lease.sessionId).toBe(session!.sessionId)
  expect(lease.sessionId).not.toBe(session!.acpSessionId)
  await (h.daemon as any).onSdkLifecycle(AGENT, session!.acpSessionId, {
    type: 'system',
    subtype: 'task_started',
    task_id: 'kanban-background',
    subagent_type: 'test'
  })
  await h.worker.recordTerminal(dispatch.leaseId, { outcome: 'completed', summary: 'done' })
  release()
  await vi.waitFor(async () => expect(await h.worker.liveness(lease)).toBe('background'))
  expect(await h.store.listKanbanReports(10)).toHaveLength(0)

  await (h.daemon as any).onSdkLifecycle(AGENT, session!.acpSessionId, {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: []
  })
  await h.worker.tick()
  expect(await h.store.listKanbanReports(10)).toEqual([
    expect.objectContaining({ outcome: 'completed', sessionId: session!.sessionId })
  ])
})

it('uses the exact GitHub hook coordinates and preserves untrusted-content guidance', () => {
  const card = buildKanbanMessage(dispatch, 'trace')
  const hook = buildHookMessage(
    {
      source: 'hook',
      agentId: AGENT,
      hookId: dispatch.boardId,
      deliveryKey: 'human',
      msgId: 'human',
      firedAt: new Date().toISOString(),
      sessionKey: 'github:123#42',
      context: { source: 'github', repo: 'acme/web', number: 42 },
      github: { repoId: '123', repoFullName: 'acme/web', sourceInstallationId: '456', subjectKind: 'issue' }
    } as never,
    'trace'
  )
  expect([card.platform, card.channel, card.thread, card.transportScope]).toEqual([
    hook.platform,
    hook.channel,
    hook.thread,
    hook.transportScope
  ])
  expect(card.text).toContain('untrusted external content')
  expect(card.text).toContain('read-only')
  for (const family of ['ac/*', 'ac/status:*', 'ac/mode:*', 'ac/agent:*']) expect(card.text).toContain(family)
  for (const tool of ['kanbanComplete', 'kanbanRequestReview', 'kanbanBlock', 'kanbanFail'])
    expect(card.text).toContain(tool)
})

describe('Daemon Kanban dispatch', () => {
  it('runs and resumes the GitHub issue session, enforcing read-only after runtime settings', async () => {
    const h = await harness()
    expect((await h.worker.dispatch(dispatch)).accepted).toBe(true)
    // The dispatched turn ends without a terminal call, so the same session gets exactly one nudge turn before the report.
    await vi.waitFor(() => expect(h.host.prompt).toHaveBeenCalledTimes(2))
    await vi.waitFor(async () => expect(await h.store.listKanbanReports(10)).toHaveLength(1))
    expect(JSON.stringify(h.host.prompt.mock.calls[1])).toContain('has not been closed')
    expect(JSON.stringify(h.host.prompt.mock.calls[0])).not.toContain('has not been closed')
    expect((await h.store.listKanbanReports(10))[0]).toMatchObject({
      outcome: 'protocol_violation',
      reasonCode: 'no_terminal_call_after_nudge'
    })
    expect(h.host.setSessionPermissionMode).toHaveBeenLastCalledWith('acp-card', 'read-only')
    const rec = (await h.store.getSession(key()))!
    expect(rec).toMatchObject({
      externalProvider: 'github',
      externalRealmKey: 'github.com',
      externalResourceKey: '123',
      sourceBindingKind: 'external'
    })
    expect(
      (
        await h.worker.dispatch({
          ...dispatch,
          leaseId: '55555555-5555-4555-8555-555555555555',
          attempt: 2,
          dispatchRevision: '5'
        })
      ).accepted
    ).toBe(true)
    await vi.waitFor(() => expect(h.host.prompt).toHaveBeenCalledTimes(4))
    expect(h.host.newSession).toHaveBeenCalledTimes(1)
    expect((await h.store.getSession(key()))?.acpSessionId).toBe(rec.acpSessionId)
    expect(await h.store.listInboxBySessionKeyFifo()).toHaveLength(0)
  })

  it.each([
    ['API Error: 429 rate_limit_error', 'transient', 'provider_rate_limited'],
    ['Incorrect API key provided', 'failed', 'provider_auth'],
    ['something odd', 'failed', 'turn_error']
  ])(
    'classifies a failing turn (%s) from the ACP error and does not nudge it',
    async (message, outcome, reasonCode) => {
      const h = await harness()
      h.host.prompt.mockRejectedValueOnce(
        Object.assign(new Error('Internal error'), { code: -32603, data: { message } })
      )
      await h.worker.dispatch(dispatch)
      await vi.waitFor(async () => expect(await h.store.listKanbanReports(10)).toHaveLength(1))
      expect((await h.store.listKanbanReports(10))[0]).toMatchObject({ outcome, reasonCode })
      expect(h.host.prompt).toHaveBeenCalledOnce()
    }
  )

  it('keeps live read-only cards protected from chat permission changes and configuration refreshes', async () => {
    const h = await harness()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    h.host.prompt.mockImplementationOnce(async () => {
      await held
      return { stopReason: 'end_turn' }
    })
    await h.worker.dispatch(dispatch)
    await vi.waitFor(() => expect(h.host.prompt).toHaveBeenCalledOnce())
    try {
      const agent = (h.daemon as any).agents.get(AGENT)
      agent.allowRuntimeChangesInChat = true
      agent.permissionMode = 'agent'
      expect(await (h.daemon as any).commands.setPermissionModeByKey(key(), 'agent-full-access')).toBe(false)
      await (h.daemon as any).applyConfiguredRuntimeSettings(agent, h.host, 'acp-card')
      expect(h.host.setSessionPermissionMode).toHaveBeenLastCalledWith('acp-card', 'read-only')
    } finally {
      release()
    }
    await vi.waitFor(async () => expect(await h.store.listKanbanReports(10)).toHaveLength(1))
  })

  it('fails closed when the runtime has no read-only mode', async () => {
    const h = await harness(false, ['agent'])
    await h.worker.dispatch(dispatch)
    await vi.waitFor(async () => expect(await h.store.listKanbanReports(10)).toHaveLength(1))
    expect(h.host.prompt).not.toHaveBeenCalled()
    expect((await h.store.listKanbanReports(10))[0]?.outcome).toBe('failed')
  })

  it('refuses a write card without a git worktree and obeys pause/drain gates', async () => {
    const h = await harness()
    expect(await h.worker.dispatch({ ...dispatch, mode: 'write' })).toMatchObject({
      accepted: false,
      reason: 'write_needs_worktree'
    })
    ;(h.daemon as any).draining = true
    expect(await h.worker.dispatch(dispatch)).toMatchObject({ accepted: false, reason: 'draining' })
    expect(h.host.prompt).not.toHaveBeenCalled()
  })

  it('forces a separate worktree for write cards even when the agent defaults to shared', async () => {
    const h = await harness(true)
    expect((await h.worker.dispatch({ ...dispatch, mode: 'write' })).accepted).toBe(true)
    await vi.waitFor(() => expect(h.host.prompt).toHaveBeenCalled(), { timeout: 10_000 })
    expect((await h.store.getSession(key()))?.workspaceIsolation).toBe('session')
    const options = h.host.newSession.mock.calls[0] as unknown as [string]
    expect(options[0]).toContain('worktrees')
    expect(options[0]).not.toBe(h.workspace)
  })
})

it('persists terminal reports across restarts and redacts ACKed receipts without losing deduplication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ac-kanban-outbox-'))
  roots.push(root)
  const path = join(root, 'store.db')
  const report: KanbanReport = {
    boardId: dispatch.boardId,
    cardId: dispatch.cardId,
    agentId: AGENT,
    leaseId: dispatch.leaseId,
    attempt: 1,
    dispatchRevision: '3',
    outcome: 'protocol_violation',
    reasonCode: 'no_terminal_call'
  }
  let store = await LocalStore.open(path)
  await store.reserveKanbanLease(dispatch.leaseId, 50)
  await store.close()
  store = await LocalStore.open(path)
  expect(await store.hasKanbanReport(dispatch.leaseId)).toBe(true)
  expect(await store.listKanbanReports(1)).toEqual([])
  await store.putKanbanReport(report, 100)
  await store.close()
  store = await LocalStore.open(path)
  expect(await store.listKanbanReports(1)).toEqual([report])
  await store.ackKanbanReport(dispatch.leaseId)
  await store.close()
  store = await LocalStore.open(path)
  expect(await store.listKanbanReports(1)).toEqual([])
  expect(await store.hasKanbanReport(dispatch.leaseId)).toBe(true)
  await store.close()
})

it('masks a secret in the stored terminal and in the GitHub comment body', async () => {
  const secret = 'sk-kanban-secret-value'
  const h = await harness(false, ['read-only', 'agent'], [{ name: 'GH_TOKEN', value: secret }])
  vi.spyOn((h.daemon as any).gitCreds, 'getKanbanCommentToken').mockResolvedValue({ token: 'ghs_test' })
  ;(h.daemon as any).cpClient = {
    state: 'READY',
    stop: async () => {},
    kanbanHeartbeat: async () => ({ superseded: [] }),
    kanbanReport: async (payload: { leaseId: string }) => ({ leaseId: payload.leaseId, accepted: true })
  }
  const posted: string[] = []
  const realFetch = globalThis.fetch.bind(globalThis)
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (method === 'POST' && url.includes('/issues/42/comments')) {
      posted.push(String(init?.body ?? ''))
      return Promise.resolve(new Response(JSON.stringify({ id: 99 }), { status: 201 }))
    }
    return realFetch(input as Parameters<typeof fetch>[0], init)
  })
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  h.host.prompt.mockImplementationOnce(async () => {
    await held
    return { stopReason: 'end_turn' }
  })
  try {
    await h.worker.dispatch(dispatch)
    await vi.waitFor(() => expect(h.host.prompt).toHaveBeenCalledOnce())
    const card = buildKanbanMessage(dispatch, 'trace')
    await (h.daemon as any).recordKanbanTerminal({
      agentId: AGENT,
      platform: card.platform,
      channel: card.channel,
      thread: card.thread,
      transportScope: card.transportScope,
      terminal: {
        outcome: 'blocked',
        blockKind: 'needs_input',
        reasonCode: 'agent_blocked',
        summary: `shipped with ${secret}`,
        reason: `blocked on ${secret}`
      }
    })
    const row = (await (h.store as any).db.prepare('SELECT entry FROM kanban_terminals').get()) as { entry: string }
    expect(row.entry).toContain('[secret:GH_TOKEN]')
    expect(row.entry).not.toContain(secret)
    const stored = JSON.parse(row.entry) as { summary: string; reason: string }
    expect(stored.summary).toBe('shipped with [secret:GH_TOKEN]')
    expect(stored.reason).toBe('blocked on [secret:GH_TOKEN]')
    release()
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0))
    expect(posted.join('\n')).toContain('[secret:GH_TOKEN]')
    expect(posted.join('\n')).not.toContain(secret)
  } finally {
    release()
    fetchSpy.mockRestore()
  }
})

it('records one terminal per lease and queues its comment only after the report is accepted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ac-kanban-terminal-'))
  roots.push(root)
  const store = await LocalStore.open(join(root, 'store.db'))
  const report: KanbanReport = {
    boardId: dispatch.boardId,
    cardId: dispatch.cardId,
    agentId: AGENT,
    leaseId: dispatch.leaseId,
    attempt: 1,
    dispatchRevision: '3',
    outcome: 'blocked',
    blockKind: 'needs_input',
    reasonCode: 'agent_blocked'
  }
  const entry = {
    report,
    repoFullName: dispatch.repoFullName,
    issueNumber: dispatch.issueNumber,
    summary: 'need a schema decision',
    reason: 'which database?'
  }
  expect(await store.recordKanbanTerminal(entry, 1)).toBe(true)
  expect(await store.recordKanbanTerminal({ ...entry, summary: 'second' }, 2)).toBe(false)
  await store.reserveKanbanLease(dispatch.leaseId, 1)
  expect((await store.orphanedKanbanTerminals()).map((row) => row.summary)).toEqual(['need a schema decision'])
  await store.putKanbanReport(report, 3)
  expect(await store.orphanedKanbanTerminals()).toEqual([])
  await store.settleKanbanTerminal(dispatch.leaseId, false)
  expect(await store.dueKanbanComments(10, 10)).toEqual([])
  expect(await store.recordKanbanTerminal(entry, 4)).toBe(true)
  await store.settleKanbanTerminal(dispatch.leaseId, true)
  expect(await store.dueKanbanComments(0, 10)).toMatchObject([{ attempted: false, entry: { summary: entry.summary } }])
  await store.markKanbanCommentAttempt(dispatch.leaseId, 100, 40)
  await store.markKanbanCommentAttempt(dispatch.leaseId, 100, 60)
  expect(await store.dueKanbanComments(50, 10)).toEqual([])
  expect((await store.dueKanbanComments(100, 10))[0]).toMatchObject({ attempted: true, attempts: 2, attemptedAt: 40 })
  await store.deferKanbanCommentLookup(dispatch.leaseId, 100)
  expect((await store.dueKanbanComments(100, 10))[0]).toMatchObject({ lookupMisses: 1 })
  await store.close()
  const reopened = await LocalStore.open(join(root, 'store.db'))
  expect((await reopened.dueKanbanComments(100, 10))[0]?.entry.reason).toBe('which database?')
  await reopened.failKanbanComment(dispatch.leaseId)
  expect(await reopened.dueKanbanComments(100, 10)).toEqual([])
  expect(await (reopened as any).db.prepare('SELECT state FROM kanban_terminals').get()).toEqual({ state: 'failed' })
  await reopened.close()
})

it.each(['ac/status:ready', 'ac/mode:write', 'ac/agent:worker', 'ac/future:grant'])(
  'denies runtime tool permission to edit %s during a leased run',
  async (label) => {
    const h = await harness()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    h.host.prompt.mockImplementationOnce(async () => {
      await held
      return { stopReason: 'end_turn' }
    })
    await h.worker.dispatch(dispatch)
    await vi.waitFor(() => expect(h.host.prompt).toHaveBeenCalledOnce())
    const policy = vi.spyOn((h.daemon as any).permissions, 'resolveAcpPermission').mockResolvedValue({
      outcome: { outcome: 'selected', optionId: 'allow' }
    })
    try {
      const response = await (h.daemon as any).permissions.onAcpPermission(AGENT, 'acp-card', {
        sessionId: 'acp-card',
        toolCall: { title: 'gh issue edit', rawInput: { command: `gh issue edit 42 --add-label ${label}` } },
        options: [{ kind: 'allow_once', optionId: 'allow', name: 'Allow' }]
      })
      expect(response).toEqual({ outcome: { outcome: 'cancelled' } })
      expect(policy).not.toHaveBeenCalled()
    } finally {
      release()
    }
    await vi.waitFor(async () => expect(await h.store.listKanbanReports(10)).toHaveLength(1))
  }
)
