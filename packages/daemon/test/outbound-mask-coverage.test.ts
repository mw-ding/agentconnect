// Coverage of every path where agent text leaves the daemon: the turn-output surface
// registry (runtime-discovered), the code-host turn-final, webchat, and the code-host
// write surfaces (broker operations and review methods). Each outbound check drives the
// REAL daemon mask over a seeded BYOK secret and asserts the masked placeholder — never
// the raw value — reaches the poster / broker / adapter.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { executeTool, type SessionContext } from '../src/mcp/ops.js'
import { agentHostKey } from '../src/acp/host-key.js'
import { maskableSecrets, secretPlaceholder } from '../src/session/secret-mask.js'
import { CODE_HOST_PROVIDERS } from '@agentconnect.md/protocol'
import { CODE_HOST_EFFECT_TOOLS, GITHUB_REVIEW_TOOLS } from '../src/mcp/tools.js'
import type { CodeHostBrokerOperation } from '../src/codehost/broker.js'
import { GithubReplyCollector } from '../src/github/poster.js'
import { finalizeGithubTurn } from '../src/platforms/github/turn-output.js'
import { emitWebchatUpdate, flushHeldWebchatText } from '../src/webchat/turn-output.js'
import { sessionKey, transcriptChannelKey } from '../src/store/local-store.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

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

// The set registered around daemon.ts L1622-1750. A newly registered platform is covered
// by the enqueueApply iteration below; this snapshot forces the author to add masking and
// update the list when the registry gains (or loses) a member.
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
  it('masks a held suffix before the final stream flush', () => {
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
    const half = Math.ceil(API_KEY.length / 2)
    for (const text of ['[details] ', API_KEY.slice(0, half), API_KEY.slice(half), ` ${HEADER}`])
      emitWebchatUpdate(wc, chunk(text))
    flushHeldWebchatText(wc)
    const text = output.mock.calls.map(([event]) => event.event.text).join('')
    expect(text).toContain(KEY_PH)
    expect(text).toContain(HEADER_PH)
    expect(text).not.toContain(API_KEY)
    expect(text).not.toContain(HEADER)
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
  it('masks the final answer through finalizeGithubTurn/maskFinal for every provider', async () => {
    const daemon = new Daemon({ slackAppFactory: fakeSlackAppFactory(), root: scaffold() })
    seedProviderSecrets(daemon)
    // The provider registry the turn-final is selected from; a new host forces this snapshot update.
    expect([...CODE_HOST_PROVIDERS]).toEqual(['github', 'gitlab', 'gitea'])
    for (const provider of CODE_HOST_PROVIDERS) {
      const collector = new GithubReplyCollector()
      const half = Math.ceil(API_KEY.length / 2)
      for (const text of [API_KEY.slice(0, half), `${API_KEY.slice(half)} ${HEADER}`]) collector.onUpdate(chunk(text))
      const publish = vi.fn(async (_text?: string) => ({ kind: 'review_comment' as const, commentId: '1' }))
      const state = { poster: { publish }, collector, deferredFinalTranscript: false }
      const turn = {
        plan: {
          statusThread: 'T1',
          sessionThread: 'T1',
          sessionKey: `hook:${provider}:1:${AGENT}`,
          transcriptChannel: 'C1',
          agentId: AGENT,
          platform: 'hook'
        }
      }
      await finalizeGithubTurn(
        {
          appendTranscript: vi.fn(async () => {}),
          monotonicTs: () => '1',
          maskFinal: (text: string) => (daemon as any).maskAgentSecrets(AGENT, text),
          beginPublish: vi.fn(async () => true),
          endPublish: vi.fn(async () => {}),
          warn: vi.fn()
        },
        turn,
        state,
        { suppressed: false, atEnd: true, formalReviewOwnsResponse: false }
      )
      expect(publish, provider).toHaveBeenCalledTimes(1)
      const posted = String(publish.mock.calls[0]![0])
      expect(posted, provider).toContain(KEY_PH)
      expect(posted, provider).toContain(HEADER_PH)
      expect(posted, provider).not.toContain(API_KEY)
      expect(posted, provider).not.toContain(HEADER)
    }
  })
})

// The broker operation kinds that carry agent-authored public text, matched by
// maskCodeHostOperation (daemon.ts L13838). Adding one forces this snapshot update.
// Exhaustive over the broker's operation union: a new kind fails typecheck until it is classified here,
// and a new text-carrying kind then fails the masking case below until it is driven and masked.
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
      const req = submit.mock.calls[0]![0] as { body: string; comments: Array<{ body: string }> }
      expect(req.body).toContain(KEY_PH)
      expect(req.body).not.toContain(API_KEY)
      expect(req.comments[0]!.body).toContain(HEADER_PH)
      expect(req.comments[0]!.body).not.toContain(HEADER)
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
