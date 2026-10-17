// The central MCP tool mask through the REAL daemon wiring: BYOK provider secrets seeded in
// `modelProviderSecrets`, driven through the daemon's own `mcp.deps` so the wired
// `maskAgentSecrets` dep (session/secret-mask.ts `maskToolArgs`) is the one under test.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { executeTool, type SessionContext } from '../src/mcp/ops.js'
import { agentHostKey } from '../src/acp/host-key.js'
import { maskableSecrets } from '../src/session/secret-mask.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const AGENT = 'bot-a'
const INT = 'int-bot-a'
const API_KEY = 'sk-vera-probe-SECRET-value-0001'
const HEADER = 'vera-probe-header-SECRET-0002'
const KEY_PH = '[secret:MODEL_API_KEY]'
const HEADER_PH = '[secret:MODEL_HEADER_x-workspace]'

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-mcp-mask-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', AGENT)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT,
      name: AGENT,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [
        {
          id: INT,
          platform: 'slack',
          core: { gated: false, bindRules: [], mutedChannels: [] },
          config: { botToken: 'xoxb', appToken: 'xapp' }
        }
      ],
      output: { mode: 'medium' }
    })
  )
  return root
}

/** A daemon whose DM turn drives each `sendMessage` through the session's own MCP context. */
async function boot(sends: Record<string, unknown>[]) {
  const root = scaffold()
  const results: unknown[] = []
  const daemon: Daemon = new Daemon({
    root,
    slackAppFactory: fakeSlackAppFactory(),
    hostFactory: (_agent, onUpdate) =>
      ({
        __started: true,
        start: async () => {},
        stop: async () => {},
        cancel: async () => {},
        newSession: async () => 'acp-1',
        loadSession: async () => true,
        hasSession: () => true,
        prompt: async (id: string) => {
          const mcp = (daemon as any).mcp
          const ctx = [...mcp.sessions.values()].find((s: SessionContext) => s.channel === 'D1') as SessionContext
          for (const args of sends)
            results.push(await executeTool(ctx, 'sendMessage', args, mcp.deps).catch((err: Error) => err))
          onUpdate(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } })
          return { stopReason: 'end_turn' }
        }
      }) as never
  })
  await daemon.start()
  // The BYOK provider secrets, as `buildAcpHost` records them for the agent's host launch.
  ;(daemon as any).modelProviderSecrets.set(
    agentHostKey(AGENT),
    maskableSecrets({
      runtimeOverrides: {
        secrets: [
          { name: 'MODEL_API_KEY', value: API_KEY },
          { name: 'MODEL_HEADER_x-workspace', value: HEADER }
        ]
      }
    })
  )
  const conn = {
    workspaceId: () => 'T_FAKE_TEAM',
    workspaceUrl: 'https://example.slack.test',
    postMessage: vi.fn(async () => 'posted-1'),
    getChannelInfo: vi.fn(async (id: string) => ({ id, name: 'general', isPrivate: false })),
    listMemberIds: vi.fn(async () => ['U1']),
    openDirectMessage: vi.fn(async (user: string) => `D_${user}`)
  }
  ;(daemon as any).connByIntegration.set(INT, conn)

  // A Linear connection, so the Linear session tool dispatches through the real daemon wiring.
  const linearSeen: Record<string, unknown>[] = []
  const linearRequest = vi.fn(async (query: string, variables: Record<string, unknown>) => {
    linearSeen.push(variables)
    const op = /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? 'unknown'
    if (op === 'IssueRef') return { issue: { id: 'i-1', identifier: 'ENG-1', team: { id: 't-1' } } }
    if (op === 'CommentCreate') return { commentCreate: { success: true, comment: { id: 'c-1' } } }
    throw new Error(`unscripted op ${op}`)
  })
  ;(daemon as any).lnConnByIntegration.set('int-ln', { request: linearRequest })

  const ask = () =>
    (daemon as any).dispatch(
      AGENT,
      {
        msgId: 'slack:D1:1700000000.000100',
        traceId: 'mcp-mask',
        source: 'user',
        platform: 'slack',
        channel: 'D1',
        thread: '1700000000.000100',
        sender: { id: 'U1', isBot: false },
        text: 'leak check',
        mentionedBots: [],
        isDm: true
      },
      INT
    )
  return {
    daemon,
    conn,
    results,
    ask,
    linearRequest,
    linearSeen,
    async close() {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

describe('MCP tool masking through the real daemon wiring', () => {
  it('masks a BYOK secret in a sendMessage post', async () => {
    const h = await boot([{ action: 'postMessage', channel: 'C1', message: `leak ${API_KEY} end` }])
    try {
      await h.ask()
      expect(h.results[0]).not.toBeInstanceOf(Error)
      expect(h.conn.postMessage).toHaveBeenCalledWith(
        'C1',
        `leak ${KEY_PH} end`,
        undefined,
        expect.objectContaining({ agentAuthorId: AGENT })
      )
      expect(h.conn.postMessage).not.toHaveBeenCalledWith(
        'C1',
        expect.stringContaining(API_KEY),
        undefined,
        expect.anything()
      )
    } finally {
      await h.close()
    }
  })

  it('masks a Linear createIssueComment body through the daemon-wired mask', async () => {
    const h = await boot([])
    try {
      const deps = { ...(h.daemon as any).mcp.deps, canRun: () => true }
      const linearCtx: SessionContext = {
        agentId: AGENT,
        platform: 'linear',
        integrationId: 'int-ln',
        isDm: false,
        channel: 'org-uuid',
        thread: 'session-uuid',
        deliveryThread: 'session-uuid',
        tools: []
      }
      const result = await executeTool(
        linearCtx,
        'createIssueComment',
        { issue: 'ENG-1', body: `done ${API_KEY}` },
        deps
      )
      expect(result).not.toBeInstanceOf(Error)
      const input = h.linearSeen.find((v) => v.input)?.input as { body: string }
      expect(input.body).toContain(`done ${KEY_PH}`)
      expect(input.body).not.toContain(API_KEY)
    } finally {
      await h.close()
    }
  })

  it('keeps structural args untouched and masks text, through the wired mask', async () => {
    const h = await boot([])
    try {
      const mask = (h.daemon as any).mcp.deps.maskAgentSecrets as (
        agentId: string,
        args: Record<string, unknown>
      ) => Record<string, unknown>
      const out = mask(AGENT, { channel: API_KEY, message: `leak ${HEADER}`, action: API_KEY })
      expect(out.channel).toBe(API_KEY)
      expect(out.action).toBe(API_KEY)
      expect(out.message).toBe(`leak ${HEADER_PH}`)
    } finally {
      await h.close()
    }
  })
})
