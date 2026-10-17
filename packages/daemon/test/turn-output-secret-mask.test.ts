// Exercise assembled platform output at the daemon boundary with BYOK provider secrets.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { agentHostKey } from '../src/acp/host-key.js'
import { maskableSecrets } from '../src/session/secret-mask.js'
import { emitWebchatUpdate, flushHeldWebchatText } from '../src/webchat/turn-output.js'
import { transcriptChannelKey } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

const AGENT = 'bot-a'
const API_KEY = 'sk-batchprobe-SECRET-value-0001'
const HEADER = 'batchprobe-header-SECRET-0002'
const CHUNKS = ['key sk-batchprobe-SECRET-', 'value-0001 header batchprobe-', 'header-SECRET-0002 done']

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-mask-'))
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

/** What buildAcpHost records for a host launched with a BYOK provider credential. */
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

const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })

describe('assembled platform replies', () => {
  it('preserves routing, status, attribution, and control fields even when they match secrets', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    seedProviderSecrets(daemon)
    ;(daemon as any).modelProviderSecrets
      .get(agentHostKey(AGENT))
      .push({ name: 'KIND', value: 'post' }, { name: 'STATUS', value: 'complete' })
    const surface = (daemon as any).turnSurfaces.for('slack')
    const apply = vi.spyOn(surface, 'apply').mockResolvedValue(undefined)
    const p = { plan: { agentId: AGENT, platform: 'slack' }, signals: { applyChain: Promise.resolve() } }
    const actions = [
      {
        kind: 'stream-append',
        chunks: [{ type: 'task_update', id: API_KEY, title: API_KEY, status: 'complete', details: HEADER }]
      },
      { kind: 'attachment', input: { issueId: API_KEY, url: HEADER, title: 'Resource' } },
      { kind: 'external-urls', add: [{ url: API_KEY, label: HEADER }] },
      { kind: 'card-final', text: API_KEY, attribution: { agentId: API_KEY, sessionUrl: HEADER } },
      { kind: 'post', text: API_KEY, recordOnly: true, attributed: false }
    ]
    for (const action of actions) (daemon as any).enqueueApply(p, action)
    await p.signals.applyChain
    expect(apply.mock.calls.map((call) => call[1])).toEqual([
      {
        ...actions[0],
        chunks: [
          {
            type: 'task_update',
            id: API_KEY,
            title: '[secret:MODEL_API_KEY]',
            status: 'complete',
            details: '[secret:MODEL_HEADER_x-workspace]'
          }
        ]
      },
      actions[1],
      actions[2],
      { ...actions[3], text: '[secret:MODEL_API_KEY]' },
      { ...actions[4], text: '[secret:MODEL_API_KEY]' }
    ])
  })

  it('masks assembled reasoning without changing tool or plan identifiers', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    seedProviderSecrets(daemon)
    const insertToolCall = vi.fn(async () => {})
    const upsertPlan = vi.fn(async () => {})
    const appendTranscript = vi.fn(async () => {})
    ;(daemon as any).store = { insertToolCall, upsertPlan, appendTranscript }
    const admission = { agentId: AGENT, sessionKey: 'session-1' }
    for (const event of [
      { kind: 'tool', op: 'insert', toolCallId: API_KEY, text: HEADER, body: '{}' },
      { kind: 'plan', planId: API_KEY, text: HEADER, body: '{}' },
      { kind: 'reasoning', text: CHUNKS.join('') }
    ])
      await (daemon as any).recordEvent(AGENT, 'C1', 'T1', admission, event)
    expect(insertToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: API_KEY, title: '[secret:MODEL_HEADER_x-workspace]' })
    )
    expect(upsertPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planId: API_KEY, title: '[secret:MODEL_HEADER_x-workspace]' })
    )
    expect(appendTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'key [secret:MODEL_API_KEY] header [secret:MODEL_HEADER_x-workspace] done' })
    )
  })

  it.each([
    { platform: 'telegram', isDm: true },
    { platform: 'discord', isDm: true },
    { platform: 'feishu', isDm: true },
    { platform: 'googlechat', isDm: true },
    { platform: 'linear', isDm: true },
    { platform: 'qq', isDm: true },
    { platform: 'qq', isDm: false }
  ])('$platform (dm: $isDm)', async ({ platform, isDm }) => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    seedProviderSecrets(daemon)
    const surface = (daemon as any).turnSurfaces.for(platform)
    expect(surface.platform).toBe(platform)
    const published: string[] = []
    const stored: string[] = []
    ;(daemon as any).store = {
      appendTranscript: vi.fn(async (row: { text: string }) => {
        stored.push(row.text)
      })
    }
    const conn = {
      postMessage: vi.fn(async (_channel: string, text: string) => {
        published.push(text)
        return 'reply-1'
      }),
      sendChatAction: vi.fn(async () => {}),
      startStreamingCard: vi.fn(async () => ({ cardId: 'card-1' })),
      finishStreamingCard: vi.fn(async (_channel: string, _card: unknown, text: string) => {
        published.push(text)
        return true
      }),
      postActivity: vi.fn(async (_session: string, activity: { type: string; body: string }) => {
        if (activity.type === 'response') published.push(activity.body)
      }),
      sendText: vi.fn(async (_channel: string, _reply: string, text: string) => {
        published.push(text)
      }),
      createMessage: vi.fn(async (input: { text: string; clientId: string }) => {
        published.push(input.text)
        return { name: `spaces/C1/messages/${input.clientId}` }
      }),
      patchMessage: vi.fn(async (_name: string, text: string) => {
        published.push(text)
      })
    }
    const conv = surface.createConverger({
      mode: 'medium',
      isDm,
      showFooter: false,
      message: { platform, channel: 'C1', thread: 'T1' }
    })
    const p = {
      plan: {
        agentId: AGENT,
        platform,
        channel: 'C1',
        thread: 'T1',
        transcriptChannel: 'C1',
        statusThread: 'T1',
        sessionKey: `${platform}:C1:T1:${AGENT}`
      },
      conn,
      chrome: {},
      turnState: { conn, channel: 'C1', replyId: 'incoming-1', space: 'spaces/C1', deliveryId: 'delivery-1', block: 0 },
      conv,
      signals: { applyChain: Promise.resolve() }
    }

    for (const text of CHUNKS) for (const action of conv.onUpdate(chunk(text))) (daemon as any).enqueueApply(p, action)
    for (const action of conv.onFinal()) (daemon as any).enqueueApply(p, action)
    await p.signals.applyChain

    expect(published.length).toBeGreaterThan(0)
    expect(stored.length).toBeGreaterThan(0)
    for (const out of [published.join('\n'), stored.join('\n')]) {
      expect(out).toContain('[secret:MODEL_API_KEY]')
      expect(out).toContain('[secret:MODEL_HEADER_x-workspace]')
      expect(out).not.toContain(API_KEY)
      expect(out).not.toContain(HEADER)
    }
  })
})

describe('commitWebchatSegment', () => {
  it('masks a held suffix assembled across chunks before the final stream flush', () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    seedProviderSecrets(daemon)
    const output = vi.fn()
    const wc = {
      conversationId: 'conv-1',
      turnId: 'turn-1',
      sink: { output, done: vi.fn() },
      index: 0,
      replyText: '',
      replySegments: [],
      heldText: '',
      messageEmitted: false,
      maskText: (text: string) => (daemon as any).maskAgentSecrets(AGENT, text)
    }
    for (const text of ['[details] ', ...CHUNKS]) emitWebchatUpdate(wc, chunk(text))
    expect(output).not.toHaveBeenCalled()
    flushHeldWebchatText(wc)
    const text = output.mock.calls.map(([event]) => event.event.text).join('')
    expect(text).toContain('[secret:MODEL_API_KEY]')
    expect(text).toContain('[secret:MODEL_HEADER_x-workspace]')
    expect(text).not.toContain(API_KEY)
    expect(text).not.toContain(HEADER)
  })

  it('masks a secret split across chunks in the stored segment row and the canonical post', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    seedProviderSecrets(daemon)
    const posts: Array<{ post: { text: string } }> = []
    const webchat = {
      conversationId: 'conv-1',
      turnId: 'turn-1',
      sink: { output: vi.fn(), done: vi.fn() },
      postSink: (post: { post: { text: string } }) => posts.push(post),
      index: 0,
      replyText: '',
      replySegments: [] as Array<{ postId: string; text: string }>,
      heldText: '',
      messageEmitted: false
    }
    for (const text of CHUNKS) emitWebchatUpdate(webchat as never, chunk(text))
    const channel = transcriptChannelKey('webchat:conv-1', undefined)
    const p = {
      webchat,
      entry: { agentId: AGENT },
      plan: { transcriptChannel: channel, statusThread: 'conv-1', sessionKey: `webchat:conv-1:${AGENT}` }
    }

    await (daemon as any).commitWebchatSegment(p, webchat.replySegments[0])

    const rows = (await (daemon as any).store.threadTranscript(channel, 'conv-1')) as Array<{ text: string }>
    expect(rows).toHaveLength(1)
    expect(posts).toHaveLength(1)
    for (const text of [rows[0]!.text, posts[0]!.post.text]) {
      expect(text).toContain('[secret:MODEL_API_KEY]')
      expect(text).toContain('[secret:MODEL_HEADER_x-workspace]')
      expect(text).not.toContain(API_KEY)
      expect(text).not.toContain(HEADER)
    }
    await daemon.stop()
  })
})
