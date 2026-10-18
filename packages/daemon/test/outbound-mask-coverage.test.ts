// Every registered outbound surface must pass the real daemon mask over seeded BYOK secrets.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { executeTool, type SessionContext } from '../src/mcp/ops.js'
import { agentHostKey } from '../src/acp/host-key.js'
import { maskableSecrets, secretPlaceholder } from '../src/session/secret-mask.js'
import { CODE_HOST_PROVIDERS, KANBAN_ORCHESTRATE_REFUSAL_CODES } from '@agentconnect.md/protocol'
import { CODE_HOST_EFFECT_TOOLS, GITHUB_REVIEW_TOOLS, KANBAN_ORCHESTRATOR_TOOLS } from '../src/mcp/tools.js'
import { KANBAN_ORCHESTRATOR_ARG_SCHEMAS, KANBAN_ORCHESTRATOR_HANDLERS } from '../src/mcp/ops/kanban.js'
import { KANBAN_ORCHESTRATE_REFUSAL_TEXT, orchestratorSpecDigest } from '../src/kanban/orchestrator-tools.js'
import type { CodeHostBrokerOperation } from '../src/codehost/broker.js'
import { GithubReplyCollector } from '../src/github/poster.js'
import { emitWebchatUpdate } from '../src/webchat/turn-output.js'
import { sessionKey, transcriptChannelKey } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

const AGENT = 'bot-a'
const API_KEY = 'sk-coverageprobe-SECRET-value-0001'
const HEADER = 'coverageprobe-header-SECRET-0002'
const KEY_PH = secretPlaceholder('MODEL_API_KEY')
const HEADER_PH = secretPlaceholder('MODEL_HEADER_x-workspace')

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-omask-'))
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

// Pin the surface registry so new platforms require a masking coverage decision.
const TURN_SURFACE_PLATFORMS = ['slack', 'telegram', 'discord', 'feishu', 'qq', 'linear', 'googlechat']

describe('turn-output surface registry coverage', () => {
  it('enumerates every registered surface and masks its text through enqueueApply', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    seedProviderSecrets(daemon)
    const registry = (daemon as any).turnSurfaces
    const ids = registry.ids() as string[]
    // A newly registered surface must be masked too — the snapshot below is the guard.
    expect(ids).toEqual(TURN_SURFACE_PLATFORMS)
    for (const id of ids) {
      const surface = registry.for(id)
      const apply = vi.spyOn(surface, 'apply').mockResolvedValue(undefined)
      const p = { plan: { agentId: AGENT, platform: id }, signals: { applyChain: Promise.resolve() } }
      ;(daemon as any).enqueueApply(p, { kind: 'post', text: API_KEY })
      await p.signals.applyChain
      expect(apply).toHaveBeenCalled()
      for (const call of apply.mock.calls) {
        const text = String((call[1] as { text?: string } | undefined)?.text ?? '')
        expect(text, id).toContain(KEY_PH)
        expect(text, id).not.toContain(API_KEY)
      }
      apply.mockRestore()
    }
  })

  it('masks QQ output in both group and C2C (stream) modes', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    seedProviderSecrets(daemon)
    const surface = (daemon as any).turnSurfaces.for('qq')
    const apply = vi.spyOn(surface, 'apply').mockResolvedValue(undefined)
    for (const isDm of [false, true]) {
      apply.mockClear()
      const conv = surface.createConverger({
        mode: 'medium',
        isDm,
        showFooter: false,
        message: { platform: 'qq', channel: 'C1', thread: 'T1' }
      })
      const p = { plan: { agentId: AGENT, platform: 'qq' }, signals: { applyChain: Promise.resolve() } }
      for (const action of conv.onUpdate(chunk(`leak ${API_KEY} end`))) (daemon as any).enqueueApply(p, action)
      for (const action of conv.onFinal()) (daemon as any).enqueueApply(p, action)
      await p.signals.applyChain
      const texts = apply.mock.calls.map((c) => String((c[1] as { text?: string } | undefined)?.text ?? '')).join('\n')
      expect(texts).toContain(KEY_PH)
      expect(texts).not.toContain(API_KEY)
    }
  })
})

describe('webchat outbound coverage', () => {
  it('masks a held suffix through the daemon-wired maskText after the host releases its BYOK secrets', async () => {
    let onUpdate!: (sid: string, u: unknown) => void
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: (_agent, cb) => {
        onUpdate = cb
        return {
          start: vi.fn(async () => seedProviderSecrets(daemon)),
          newSession: vi.fn(async () => 'acp-wc-1'),
          modelOptions: vi.fn(() => null),
          hasSession: vi.fn(() => true),
          prompt: vi.fn(async (sid: string) => {
            const half = Math.ceil(API_KEY.length / 2)
            onUpdate(sid, chunk(`[details] ${API_KEY.slice(0, half)}`))
            onUpdate(sid, chunk(`${API_KEY.slice(half)} ${HEADER}`))
            // The host released its BYOK provider secrets before the final held-text flush.
            ;(daemon as any).modelProviderSecrets.delete(agentHostKey(AGENT))
            return { stopReason: 'end_turn' }
          }),
          cancel: vi.fn(async () => {}),
          forgetSession: vi.fn(),
          stop: vi.fn(async () => {})
        } as never
      }
    })
    await daemon.start()
    const outputs: Array<{ event: { kind: string; text?: string } }> = []
    const sink = { output: (o: { event: { kind: string; text?: string } }) => outputs.push(o), done: vi.fn() }
    ;(daemon as any).cpClient = {
      organizationScope: () => 'connection' as const,
      stop: vi.fn(async () => {}),
      emitUsageReport: vi.fn(),
      emitSessionActivity: vi.fn(),
      emitEventSession: vi.fn(),
      emitHookReport: vi.fn(async () => 'acknowledged' as const)
    }
    const conv = '88888888-8888-4888-8888-888888888888'
    const turnId = '55555555-5555-4555-8555-555555555555'
    await (daemon as any).dispatch(
      AGENT,
      {
        msgId: `webchat:${conv}:${turnId}`,
        traceId: turnId,
        source: 'user' as const,
        platform: 'webchat' as const,
        channel: conv,
        thread: conv,
        sender: { id: 'alice', isBot: false },
        text: 'go',
        mentionedBots: [] as string[],
        isDm: true,
        trigger: 'dm' as const
      },
      undefined,
      { conversationId: conv, turnId, sink }
    )
    const text = outputs
      .filter((o) => o.event?.kind === 'message')
      .map((o) => o.event.text ?? '')
      .join('')
    expect(text).toContain(KEY_PH)
    expect(text).toContain(HEADER_PH)
    expect(text).not.toContain(API_KEY)
    expect(text).not.toContain(HEADER)
    await daemon.stop()
  })

  it('masks the committed segment row and its canonical post', async () => {
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
    const half = Math.ceil(API_KEY.length / 2)
    for (const text of [API_KEY.slice(0, half), API_KEY.slice(half)]) emitWebchatUpdate(webchat as never, chunk(text))
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
      expect(text).toContain(KEY_PH)
      expect(text).not.toContain(API_KEY)
    }
    await daemon.stop()
  })
})

describe('code-host turn-final coverage', () => {
  it('masks the final answer through the daemon-wired maskFinal after the host releases its BYOK secrets', async () => {
    let onUpdate!: (sid: string, u: unknown) => void
    const daemon = new Daemon({
      slackAppFactory: fakeSlackAppFactory(),
      root: scaffold(),
      hostFactory: (_agent, cb) => {
        onUpdate = cb
        return {
          start: vi.fn(async () => seedProviderSecrets(daemon)),
          newSession: vi.fn(async () => 'acp-hook-1'),
          modelOptions: vi.fn(() => null),
          hasSession: vi.fn(() => true),
          prompt: vi.fn(async (sid: string) => {
            const half = Math.ceil(API_KEY.length / 2)
            onUpdate(sid, {
              sessionUpdate: 'agent_message_chunk',
              _meta: { codex: { phase: 'final_answer' } },
              content: { type: 'text', text: API_KEY.slice(0, half) }
            })
            onUpdate(sid, {
              sessionUpdate: 'agent_message_chunk',
              _meta: { codex: { phase: 'final_answer' } },
              content: { type: 'text', text: `${API_KEY.slice(half)} ${HEADER}` }
            })
            // The host released its BYOK provider secrets before the final mask.
            ;(daemon as any).modelProviderSecrets.delete(agentHostKey(AGENT))
            return { stopReason: 'end_turn' }
          }),
          cancel: vi.fn(async () => {}),
          forgetSession: vi.fn(),
          stop: vi.fn(async () => {})
        } as never
      }
    })
    await daemon.start()
    const cp = {
      hookReports: [] as unknown[],
      sessionEvents: [] as unknown[],
      organizationScope: () => 'connection' as const,
      stop: vi.fn(async () => {}),
      emitEventSession: vi.fn((e: unknown) => (cp.sessionEvents as unknown[]).push(e)),
      emitHookReport: vi.fn(async (r: unknown) => {
        cp.hookReports.push(r)
        return 'acknowledged' as const
      }),
      emitUsageReport: vi.fn(),
      emitSessionActivity: vi.fn()
    }
    ;(daemon as any).cpClient = cp
    const publish = vi.fn(async (_text?: string) => ({ kind: 'review_comment' as const, commentId: '1' }))
    ;(daemon as any).githubReviews.makeCodeHostReply = vi.fn(() => ({
      poster: { publish },
      collector: new GithubReplyCollector()
    }))
    const hookId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await (daemon as any).handleRelayMsg(
      {
        source: 'hook',
        agentId: AGENT,
        sessionKey: 'agentconnect-md/agentconnect#145',
        msgId: `${hookId}:d-1`,
        hookId,
        deliveryKey: 'd-1',
        firedAt: new Date().toISOString(),
        github: {
          repoId: '123',
          repoFullName: 'agentconnect-md/agentconnect',
          sourceInstallationId: '456',
          subjectKind: 'pull_request',
          pullNumber: 145
        },
        context: {
          source: 'github',
          event: 'pull_request',
          action: 'opened',
          repo: 'agentconnect-md/agentconnect',
          number: 145,
          title: 'leak check',
          truncated: false
        }
      },
      () => {}
    )
    await vi.waitFor(() => expect(cp.hookReports).toHaveLength(1), WAIT)
    expect(publish).toHaveBeenCalledTimes(1)
    const posted = String(publish.mock.calls[0]![0])
    expect(posted).toContain(KEY_PH)
    expect(posted).toContain(HEADER_PH)
    expect(posted).not.toContain(API_KEY)
    expect(posted).not.toContain(HEADER)
    await daemon.stop()
  })

  it('enumerates the code-host providers whose final is masked by the daemon-wired maskFinal', () => {
    // New providers must share the daemon's assembled-final mask exercised above.
    expect([...CODE_HOST_PROVIDERS]).toEqual(['github', 'gitlab', 'gitea'])
  })
})

// Exhaustive broker classification makes new text-carrying operations require a masking test.
const BROKER_KIND_CARRIES_TEXT: Record<CodeHostBrokerOperation['kind'], boolean> = {
  createComment: true,
  updateComment: true,
  readDiscussions: false,
  replyDiscussion: true,
  createMergeRequest: true,
  updateMergeRequest: true,
  inspectPipelines: false,
  controlPipeline: false
}
const TEXT_CARRYING_BROKER_KINDS = Object.entries(BROKER_KIND_CARRIES_TEXT)
  .filter(([, text]) => text)
  .map(([kind]) => kind)

describe('code-host broker and review outbound coverage', () => {
  async function boot(): Promise<{ daemon: Daemon; close: () => Promise<void> }> {
    const root = scaffold()
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root })
    await daemon.start()
    seedProviderSecrets(daemon)
    return { daemon, close: () => daemon.stop() }
  }

  it('enumerates the code-host tool names (snapshot)', () => {
    expect(CODE_HOST_EFFECT_TOOLS.map((t) => t.name)).toEqual([
      'createCodeHostComment',
      'updateCodeHostComment',
      'readCodeHostDiscussions',
      'replyCodeHostDiscussion',
      'createCodeHostMergeRequest',
      'updateCodeHostMergeRequest',
      'inspectCodeHostPipelines',
      'controlCodeHostPipeline'
    ])
    expect(GITHUB_REVIEW_TOOLS.map((t) => t.name)).toEqual(['submitCodeReview', 'replyGithubReviewThreads'])
  })

  it('masks every text-carrying broker operation through the codeHostEffect boundary', async () => {
    const { daemon, close } = await boot()
    try {
      const run = vi.spyOn(daemon as any, 'runCodeHostEffect').mockResolvedValue({ ok: true })
      // Each text-carrying kind, with the exact masked field(s) the operation must reach the broker with.
      const operations: Array<{ op: Record<string, unknown>; masked: Record<string, string> }> = [
        {
          op: { kind: 'createComment', subject: 'issue', iid: 1, body: `leak ${API_KEY}` },
          masked: { body: `leak ${KEY_PH}` }
        },
        {
          op: { kind: 'updateComment', subject: 'issue', iid: 1, noteId: '1', body: `leak ${HEADER}` },
          masked: { body: `leak ${HEADER_PH}` }
        },
        {
          op: { kind: 'replyDiscussion', subject: 'issue', iid: 1, discussionId: 'd1', body: `leak ${API_KEY}` },
          masked: { body: `leak ${KEY_PH}` }
        },
        {
          op: {
            kind: 'createMergeRequest',
            sourceBranch: 's',
            targetBranch: 't',
            title: `t ${API_KEY}`,
            description: `d ${HEADER}`
          },
          masked: { title: `t ${KEY_PH}`, description: `d ${HEADER_PH}` }
        },
        {
          op: { kind: 'updateMergeRequest', iid: 1, title: `t ${API_KEY}`, description: `d ${HEADER}` },
          masked: { title: `t ${KEY_PH}`, description: `d ${HEADER_PH}` }
        }
      ]
      expect(operations.map((o) => o.op.kind)).toEqual(TEXT_CARRYING_BROKER_KINDS)
      for (const { op, masked } of operations) {
        run.mockClear()
        await (daemon as any).mcp.deps.codeHostEffect({
          agentId: AGENT,
          platform: 'hook',
          channel: 'repo',
          thread: '1',
          operation: op
        })
        expect(run, op.kind as string).toHaveBeenCalledTimes(1)
        const received = (run.mock.calls[0]![0] as { operation: Record<string, unknown> }).operation
        for (const [field, expected] of Object.entries(masked)) {
          expect(received[field], `${op.kind}.${field}`).toBe(expected)
          expect(received[field], `${op.kind}.${field}`).not.toContain(API_KEY)
          expect(received[field], `${op.kind}.${field}`).not.toContain(HEADER)
        }
      }
    } finally {
      await close()
    }
  })

  it('masks submitCodeReview body and comments through the daemon boundary', async () => {
    const { daemon, close } = await boot()
    try {
      const submit = vi.spyOn((daemon as any).codeReviews, 'submit').mockResolvedValue({ state: 'submitted' })
      await (daemon as any).mcp.deps.submitCodeReview({
        agentId: AGENT,
        platform: 'hook',
        channel: 'acme/infra',
        thread: '42',
        event: 'COMMENT',
        verdict: 'neutral',
        body: `leak ${API_KEY}`,
        comments: [{ path: 'a.ts', body: `see ${HEADER}`, line: 1, side: 'RIGHT' }]
      })
      expect(submit).toHaveBeenCalledTimes(1)
      const req = submit.mock.calls[0]![0] as { body: string; comments: Array<{ path: string; body: string }> }
      expect(req.body).toContain(KEY_PH)
      expect(req.body).not.toContain(API_KEY)
      expect(req.comments[0]!.body).toContain(HEADER_PH)
      expect(req.comments[0]!.body).not.toContain(HEADER)
      // Diff-path anchors must stay exact; only the visible comment body is masked.
      expect(req.comments[0]!.path).toBe('a.ts')
    } finally {
      await close()
    }
  })

  it('masks replyGithubReviewThreads replies through the daemon boundary', async () => {
    const { daemon, close } = await boot()
    try {
      const reply = vi
        .spyOn((daemon as any).githubReviews, 'replyGithubReviewThreads')
        .mockResolvedValue({ replies: [] })
      await (daemon as any).mcp.deps.replyGithubReviewThreads({
        agentId: AGENT,
        platform: 'hook',
        channel: 'acme/infra',
        thread: '42',
        replies: [{ threadRootCommentId: '101', body: `leak ${API_KEY}` }]
      })
      expect(reply).toHaveBeenCalledTimes(1)
      const req = reply.mock.calls[0]![0] as { replies: Array<{ body: string }> }
      expect(req.replies[0]!.body).toContain(KEY_PH)
      expect(req.replies[0]!.body).not.toContain(API_KEY)
    } finally {
      await close()
    }
  })

  it('routes the masked review to each registered review adapter (github/gitlab/gitea)', async () => {
    const { daemon, close } = await boot()
    try {
      // Each provider owns a distinct session key; the router dispatches by ownership.
      const cases = [
        { provider: 'github', channel: 'gh-repo', thread: '1' },
        { provider: 'gitlab', channel: 'gl-repo', thread: '2' },
        { provider: 'gitea', channel: 'ge-repo', thread: '3' }
      ] as const
      const spies: Array<{ provider: string; submit: ReturnType<typeof vi.fn> }> = []
      for (const { provider, channel, thread } of cases) {
        const key = sessionKey('hook', channel, thread, AGENT, undefined)
        if (provider === 'github') {
          ;(daemon as any).activeGithubTurnMeta.set(key, { hook: { agentId: AGENT } })
          spies.push({
            provider,
            submit: vi
              .spyOn((daemon as any).githubReviews.reviewAdapter, 'submit')
              .mockResolvedValue({ state: 'submitted' })
          })
        } else {
          ;(daemon as any)[`${provider}Reviews`].turns.set(key, { agentId: AGENT })
          spies.push({
            provider,
            submit: vi.spyOn((daemon as any)[`${provider}Reviews`], 'submit').mockResolvedValue({ state: 'submitted' })
          })
        }
      }
      for (const { provider, channel, thread } of cases) {
        await (daemon as any).mcp.deps.submitCodeReview({
          agentId: AGENT,
          platform: 'hook',
          channel,
          thread,
          event: 'COMMENT',
          verdict: 'neutral',
          body: `leak ${API_KEY}`
        })
        const spy = spies.find((s) => s.provider === provider)!.submit
        expect(spy, provider).toHaveBeenCalledTimes(1)
        const req = spy.mock.calls[0]![1] as { body: string }
        expect(req.body, provider).toContain(KEY_PH)
        expect(req.body, provider).not.toContain(API_KEY)
      }
    } finally {
      await close()
    }
  })

  it('masks every code-host tool dispatched through executeTool (full boundary)', async () => {
    const { daemon, close } = await boot()
    try {
      const deps = { ...(daemon as any).mcp.deps, canRun: () => true }
      const ctx: SessionContext = {
        agentId: AGENT,
        platform: 'hook',
        integrationId: undefined,
        isDm: false,
        channel: 'repo',
        thread: '1',
        deliveryThread: '1',
        tools: []
      }
      // The five text-carrying effect tools, their argument shape, and the masked field.
      const run = vi.spyOn(daemon as any, 'runCodeHostEffect').mockResolvedValue({ ok: true })
      const effects: Array<[string, Record<string, unknown>, string, string]> = [
        ['createCodeHostComment', { subject: 'issue', iid: 1, body: `leak ${API_KEY}` }, 'body', `leak ${KEY_PH}`],
        [
          'updateCodeHostComment',
          { subject: 'issue', iid: 1, noteId: '1', body: `leak ${HEADER}` },
          'body',
          `leak ${HEADER_PH}`
        ],
        [
          'replyCodeHostDiscussion',
          { subject: 'issue', iid: 1, discussionId: 'd1', body: `leak ${API_KEY}` },
          'body',
          `leak ${KEY_PH}`
        ],
        [
          'createCodeHostMergeRequest',
          { sourceBranch: 's', targetBranch: 't', title: `t ${API_KEY}`, description: `d ${HEADER}` },
          'title',
          `t ${KEY_PH}`
        ],
        [
          'updateCodeHostMergeRequest',
          { iid: 1, title: `t ${API_KEY}`, description: `d ${HEADER}` },
          'description',
          `d ${HEADER_PH}`
        ]
      ]
      for (const [name, args, field, expected] of effects) {
        run.mockClear()
        await executeTool(ctx, name, args, deps)
        expect(run, name).toHaveBeenCalledTimes(1)
        const operation = (run.mock.calls[0]![0] as { operation: Record<string, unknown> }).operation
        expect(operation[field], `${name}.${field}`).toBe(expected)
      }
      // The review tools dispatch through the same pre-dispatch mask to their deps.
      const submit = vi.spyOn((daemon as any).codeReviews, 'submit').mockResolvedValue({ state: 'submitted' })
      for (const name of ['submitCodeReview', 'submitGithubReview']) {
        submit.mockClear()
        await executeTool(
          ctx,
          name,
          {
            event: 'COMMENT',
            verdict: 'neutral',
            body: `leak ${API_KEY}`,
            comments: [{ path: 'a.ts', body: `see ${HEADER}`, line: 1, side: 'RIGHT' }]
          },
          deps
        )
        expect(submit, name).toHaveBeenCalledTimes(1)
        const req = submit.mock.calls[0]![0] as { body: string; comments: Array<{ body: string }> }
        expect(req.body, name).toBe(`leak ${KEY_PH}`)
        expect(req.comments[0]!.body, name).toBe(`see ${HEADER_PH}`)
      }
      const reply = vi
        .spyOn((daemon as any).githubReviews, 'replyGithubReviewThreads')
        .mockResolvedValue({ replies: [] })
      await executeTool(
        ctx,
        'replyGithubReviewThreads',
        { replies: [{ threadRootCommentId: '101', body: `leak ${API_KEY}` }] },
        deps
      )
      expect(reply).toHaveBeenCalledTimes(1)
      const replyReq = reply.mock.calls[0]![0] as { replies: Array<{ body: string }> }
      expect(replyReq.replies[0]!.body).toBe(`leak ${KEY_PH}`)
    } finally {
      await close()
    }
  })
})

// Pin each tool's entire argument surface so a new text/reason field requires an outbound coverage decision.
const ORCHESTRATOR_PATHS = {
  kanbanList: { fields: ['board', 'status'], args: { status: API_KEY } },
  kanbanCreate: {
    fields: ['board', 'title', 'body', 'epic', 'step', 'assignee', 'priority', 'status', 'blockedBy'],
    args: { title: API_KEY, body: HEADER, assignee: API_KEY }
  },
  kanbanLink: { fields: ['board', 'issue', 'blockedBy', 'parent'], args: { issue: 7 } },
  kanbanUnblock: { fields: ['board', 'issue', 'blockers'], args: { issue: 7 } },
  kanbanAssign: { fields: ['board', 'issue', 'assignee'], args: { issue: 7, assignee: API_KEY } }
}

describe('orchestrator outbound coverage', () => {
  async function boot() {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    await daemon.start()
    seedProviderSecrets(daemon)
    return daemon
  }

  const board = '22222222-2222-4222-8222-222222222222'

  it('enumerates every orchestrator tool and argument, including any future reason text', () => {
    expect(KANBAN_ORCHESTRATOR_TOOLS.map((t) => t.name)).toEqual(Object.keys(ORCHESTRATOR_PATHS))
    expect(KANBAN_ORCHESTRATOR_ARG_SCHEMAS.map(([name]) => name)).toEqual(Object.keys(ORCHESTRATOR_PATHS))
    expect(KANBAN_ORCHESTRATOR_HANDLERS.map(([name]) => name)).toEqual(Object.keys(ORCHESTRATOR_PATHS))
    for (const [name, { fields }] of Object.entries(ORCHESTRATOR_PATHS)) {
      const descriptor = KANBAN_ORCHESTRATOR_TOOLS.find((t) => t.name === name)!
      const schema = KANBAN_ORCHESTRATOR_ARG_SCHEMAS.find(([n]) => n === name)![1]
      expect(Object.keys(descriptor.inputSchema.properties!), name).toEqual(fields)
      expect(Object.keys((schema as any).shape), name).toEqual(fields)
    }
    expect(Object.keys(KANBAN_ORCHESTRATE_REFUSAL_TEXT)).toEqual([...KANBAN_ORCHESTRATE_REFUSAL_CODES])
  })

  it('masks the issue title/body at mcp.deps.kanbanCreate before the actual GitHub POST and digest', async () => {
    const daemon = await boot()
    const orchestrate = vi.fn(async (p: { op: string }) => {
      if (p.op === 'list')
        return {
          ok: true,
          op: p.op,
          boards: [{ boardId: board, repoFullName: 'acme/web', cards: [] }],
          truncated: false
        }
      if (p.op === 'prepare_create') return { ok: true, op: p.op, verdict: 'proceed' }
      return { ok: true, op: p.op, cardId: 'card-1', issueNumber: 42 }
    })
    ;(daemon as any).cpClient = { kanbanOrchestrate: orchestrate, stop: async () => {} }
    vi.spyOn((daemon as any).gitCreds, 'getKanbanOrchestratorToken').mockResolvedValue({ token: 'ghs_test' })
    // Fresh creates skip the lookup by design (intent-gated recovery), so the POST is the only fetch.
    const post = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ number: 42 }), { status: 201 }))
    try {
      await (daemon as any).mcp.deps.kanbanCreate({
        agentId: AGENT,
        board,
        title: `title ${API_KEY}`,
        body: `body ${HEADER}`
      })
      expect(post).toHaveBeenCalledTimes(1)
      const [url, init] = post.mock.calls[0]!
      expect(url).toBe('https://api.github.com/repos/acme/web/issues')
      expect(init?.method).toBe('POST')
      const payload = JSON.parse(String(init?.body))
      expect(payload.title).toBe(`title ${KEY_PH}`)
      expect(payload.body.startsWith(`body ${HEADER_PH}\n\n<!-- agentconnect:kanban-card-key:`)).toBe(true)
      expect(payload.body).toMatch(/[0-9a-f]{64} -->$/)
      expect(init?.body).not.toContain(API_KEY)
      expect(init?.body).not.toContain(HEADER)
      const digest = orchestratorSpecDigest(payload.title, `body ${HEADER_PH}`)
      for (const [req] of orchestrate.mock.calls) {
        if (req.op === 'list') continue
        expect(req).toMatchObject({ specDigest: digest })
        expect(req).not.toHaveProperty('title')
        expect(req).not.toHaveProperty('body')
      }
    } finally {
      post.mockRestore()
      await daemon.stop()
    }
  })

  it('keeps every refusal fixed and rejects reason text on metadata-only link/unblock/assign paths', async () => {
    const daemon = await boot()
    let code: (typeof KANBAN_ORCHESTRATE_REFUSAL_CODES)[number] = KANBAN_ORCHESTRATE_REFUSAL_CODES[0]
    const orchestrate = vi.fn(async (p: { op: string }) => ({ ok: false, op: p.op, code }))
    ;(daemon as any).cpClient = { kanbanOrchestrate: orchestrate, stop: async () => {} }
    const ctx: SessionContext = {
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      deliveryThread: 'T1',
      integrationId: undefined,
      isDm: true,
      tools: KANBAN_ORCHESTRATOR_TOOLS
    }
    const deps = { ...(daemon as any).mcp.deps, canRun: () => true }
    try {
      for (const refusalCode of KANBAN_ORCHESTRATE_REFUSAL_CODES) {
        code = refusalCode
        for (const [name, { args }] of Object.entries(ORCHESTRATOR_PATHS)) {
          const result = await executeTool(ctx, name, { board, ...args }, deps)
          expect(result, `${name}:${code}`).toEqual({ refused: KANBAN_ORCHESTRATE_REFUSAL_TEXT[code] })
          expect(JSON.stringify(result)).not.toContain(API_KEY)
          expect(JSON.stringify(result)).not.toContain(HEADER)
        }
      }
      for (const name of ['kanbanLink', 'kanbanUnblock', 'kanbanAssign'] as const) {
        orchestrate.mockClear()
        await expect(
          executeTool(ctx, name, { board, ...ORCHESTRATOR_PATHS[name].args, reason: API_KEY }, deps)
        ).rejects.toThrow(/unexpected argument/)
        expect(orchestrate).not.toHaveBeenCalled()
      }
    } finally {
      await daemon.stop()
    }
  })
})
