// Turn-final masking edge cases: a host released before the final flush still masks its BYOK
// secrets (via the per-turn snapshot), and a tool/plan row's merged body is masked too.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { agentHostKey } from '../src/acp/host-key.js'
import { maskableSecrets } from '../src/session/secret-mask.js'

const AGENT = 'bot-a'
const API_KEY = 'sk-vera-probe-SECRET-value-0001'
const HEADER = 'vera-probe-header-SECRET-0002'
const KEY_PH = '[secret:MODEL_API_KEY]'
const HEADER_PH = '[secret:MODEL_HEADER_x-workspace]'

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-final-mask-'))
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
  writeFileSync(
    join(agentDir, 'agent.json'),
    JSON.stringify({
      id: AGENT,
      name: AGENT,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

const msg = (ts: string, body: string): NormalizedMessage => ({
  msgId: `slack:C1:${ts}`,
  traceId: ts,
  source: 'user' as const,
  platform: 'slack' as const,
  channel: 'C1',
  thread: 'T1',
  sender: { id: 'U1', isBot: false },
  text: body,
  mentionedBots: [] as string[],
  isDm: true,
  trigger: 'dm' as const
})

function seedProviderSecrets(daemon: Daemon): void {
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
}

function connect(daemon: Daemon, overrides: Record<string, unknown> = {}) {
  const agent = (daemon as any).agents.get(AGENT)
  agent.integrations = [
    {
      id: 'int-a',
      platform: 'slack',
      core: { bindRules: [{ match: { kind: 'dm' } }] },
      config: { botToken: 'b', appToken: 'p' }
    }
  ]
  let post = 0
  const conn = {
    workspaceId: vi.fn(() => 'T1'),
    setStatus: vi.fn(async () => {}),
    postMessage: vi.fn<(channel: string, text: string, thread?: string, options?: unknown) => Promise<string>>(
      async () => `reply-${++post}`
    ),
    postBlocks: vi.fn(async () => 'status-bar'),
    updateBlocks: vi.fn(async () => {}),
    ...overrides
  }
  ;(daemon as any).connByIntegration.set('int-a', conn)
  return conn
}

describe('final flush masking after early host release', () => {
  it('still masks the assembled reply after the host released its BYOK secrets', async () => {
    let onUpdate!: (sessionId: string, update: unknown) => void
    const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
    const host = {
      start: vi.fn(async () => {}),
      newSession: vi.fn(async () => 'acp-1'),
      hasSession: vi.fn(() => true),
      prompt: vi.fn(async (sessionId: string) => {
        // The secret arrives split across chunks, so the per-chunk ingress mask misses it.
        onUpdate(sessionId, chunk('key sk-vera-probe-SECRET-'))
        onUpdate(sessionId, chunk('value-0001 done'))
        // The model-session pool releases the host (and its BYOK entries) before the final flush.
        ;(daemon as any).modelProviderSecrets.delete(agentHostKey(AGENT))
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn(async () => {}),
      stop: vi.fn(async () => {})
    }
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: (_agent, update) => {
        onUpdate = update
        return host as never
      }
    })
    await daemon.start()
    // Recorded BEFORE the turn starts, as `buildAcpHost` does during host launch.
    seedProviderSecrets(daemon)
    const conn = connect(daemon, { setTitle: vi.fn(async () => {}) })

    await (daemon as any).dispatch(AGENT, msg('100.1', 'leak check'), 'int-a')

    const posted = conn.postMessage.mock.calls.map((call) => String(call[1])).join('\n')
    expect(posted).toContain(KEY_PH)
    expect(posted).not.toContain(API_KEY)
    await daemon.stop()
  })
})

describe('recordEvent masks the merged body', () => {
  it('masks a tool output secret in the stored tool row body', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    seedProviderSecrets(daemon)
    const insertToolCall = vi.fn(async () => {})
    const updateToolCall = vi.fn(
      async (
        _channel: string,
        _thread: string,
        _agentId: string,
        _toolCallId: string,
        _patch: { title: string; body: string },
        _sessionKey: string
      ) => {}
    )
    const upsertPlan = vi.fn(async (_row: { title: string; body: string }) => {})
    const appendTranscript = vi.fn(async () => {})
    ;(daemon as any).store = { insertToolCall, updateToolCall, upsertPlan, appendTranscript }
    const admission = { agentId: AGENT, sessionKey: 's-1' }
    // A tool row whose merged body carries the secret split across two rawOutput deltas.
    await (daemon as any).recordEvent(
      AGENT,
      'C1',
      'T1',
      admission,
      {
        kind: 'tool',
        op: 'update',
        toolCallId: 't1',
        text: 'run',
        body: `{"rawOutput":"sk-vera-probe-SECRET-value-0001"}`
      },
      undefined
    )
    expect(updateToolCall).toHaveBeenCalledWith(
      'C1',
      'T1',
      AGENT,
      't1',
      { title: 'run', body: expect.stringContaining(KEY_PH) },
      's-1'
    )
    expect(updateToolCall.mock.calls[0]![4].body).not.toContain(API_KEY)
    // A plan row's merged entries are masked too.
    await (daemon as any).recordEvent(
      AGENT,
      'C1',
      'T1',
      admission,
      { kind: 'plan', planId: 'p1', text: 'plan', body: `{"entries":[{"text":"${HEADER}"}]}` },
      undefined
    )
    expect(upsertPlan).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining(HEADER_PH) }))
    expect(upsertPlan.mock.calls[0]![0].body).not.toContain(HEADER)
  })
})
