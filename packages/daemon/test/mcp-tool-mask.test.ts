// Central masking of MCP tool arguments (session/secret-mask.ts `maskToolArgs`): every
// dispatched tool — the static registry, platform session tools, evaluation tools, and MCP
// Apps tools — sees its free-text fields masked before any handler runs. Structural routing
// keys (ids, refs, paths, URLs, enums, timestamps) pass through untouched.
import { describe, expect, it, vi } from 'vitest'
import {
  executeTool,
  TOOL_ARG_SCHEMAS,
  type OpsDeps,
  type SessionContext,
  type MessageGateway
} from '../src/mcp/ops.js'
import {
  isToolArgPassthroughKey,
  maskableSecrets,
  maskSecretsInText,
  maskToolArgs,
  secretPlaceholder
} from '../src/session/secret-mask.js'
import { allAttachmentReadTools, allSessionToolDescriptors } from '../src/platforms/read-ports.js'
import { toolsForIntegrations } from '../src/mcp/tools.js'
import type { MemoryProvider } from '../src/memory/provider.js'
import { openTestStore } from './store-support.js'

const AGENT = 'bot-a'
const API_KEY = 'sk-vera-probe-SECRET-value-0001'
const HEADER = 'vera-probe-header-SECRET-0002'
const KEY_PH = secretPlaceholder('MODEL_API_KEY')
const HEADER_PH = secretPlaceholder('MODEL_HEADER_x-workspace')

/** The BYOK provider secrets, seeded exactly as `buildAcpHost` records them. */
const ENTRIES = maskableSecrets({
  runtimeOverrides: {
    secrets: [
      { name: 'MODEL_API_KEY', value: API_KEY },
      { name: 'MODEL_HEADER_x-workspace', value: HEADER }
    ]
  }
})

/** The same mask the daemon wires into OpsDeps: `maskToolArgs` over the seeded entries. */
const mask = (args: Record<string, unknown>): Record<string, unknown> => maskToolArgs(args, ENTRIES)

/** The same string mask the daemon wires for `maskAgentText` (shareFile display text). */
const maskText = (text: string): string => maskSecretsInText(text, ENTRIES)

describe('maskToolArgs', () => {
  it('masks free-text values and leaves structural keys untouched', () => {
    const out = mask({
      action: API_KEY,
      channel: API_KEY,
      thread: API_KEY,
      user: API_KEY,
      userId: API_KEY,
      messageTs: API_KEY,
      integrationId: API_KEY,
      toolCallId: API_KEY,
      planId: API_KEY,
      path: API_KEY,
      url: API_KEY,
      href: API_KEY,
      link: API_KEY,
      postAt: API_KEY,
      dueAt: API_KEY,
      dueDate: API_KEY,
      targetDate: API_KEY,
      cursor: API_KEY,
      platform: API_KEY,
      kind: API_KEY,
      type: API_KEY,
      status: API_KEY,
      state: API_KEY,
      toAgent: API_KEY,
      issue: API_KEY,
      team: API_KEY,
      message: `leak ${API_KEY} end`,
      title: `t ${API_KEY}`,
      description: `d ${HEADER}`,
      body: `b ${API_KEY} ${HEADER}`
    })
    // Every structural key passes through verbatim even though it equals a secret value.
    for (const key of [
      'action',
      'channel',
      'thread',
      'user',
      'userId',
      'messageTs',
      'integrationId',
      'toolCallId',
      'planId',
      'path',
      'postAt',
      'dueAt',
      'dueDate',
      'targetDate',
      'cursor',
      'platform',
      'kind',
      'type',
      'status',
      'state',
      'toAgent',
      'issue',
      'team'
    ])
      expect(out[key], key).toBe(API_KEY)
    // URL keys are free text and are masked even when they equal a secret.
    expect(out.url).toBe(KEY_PH)
    expect(out.href).toBe(KEY_PH)
    expect(out.link).toBe(KEY_PH)
    // Free text is masked.
    expect(out.message).toBe(`leak ${KEY_PH} end`)
    expect(out.title).toBe(`t ${KEY_PH}`)
    expect(out.description).toBe(`d ${HEADER_PH}`)
    expect(out.body).toBe(`b ${KEY_PH} ${HEADER_PH}`)
  })

  it('masks through arrays and nested objects, skipping structural keys at every level', () => {
    const out = maskToolArgs(
      {
        fields: [
          { columnId: API_KEY, type: API_KEY, value: `v ${API_KEY}` },
          { columnId: 'c2', type: 'text', value: { nested: `n ${HEADER}` } }
        ],
        edits: [{ operation: API_KEY, sectionId: API_KEY, markdown: `m ${API_KEY}` }]
      },
      ENTRIES
    )
    expect(out.fields[0]).toEqual({ columnId: API_KEY, type: API_KEY, value: `v ${KEY_PH}` })
    expect(out.fields[1]).toEqual({ columnId: 'c2', type: 'text', value: { nested: `n ${HEADER_PH}` } })
    expect(out.edits[0]).toEqual({ operation: API_KEY, sectionId: API_KEY, markdown: `m ${KEY_PH}` })
  })

  it('is a no-op for a value with no secrets (same reference)', () => {
    const args = { message: 'hello' }
    expect(maskToolArgs(args, ENTRIES)).toBe(args)
  })

  it('passes every registered structural key through untouched', () => {
    // The suffix families every schema relies on for ids and instants.
    for (const key of [
      'itemId',
      'columnId',
      'sectionId',
      'agentId',
      'canvasId',
      'listId',
      'sessionId',
      'taskId',
      'postAt',
      'dueAt',
      'firedAt',
      'toolCallId',
      'planId'
    ])
      expect(isToolArgPassthroughKey(key), key).toBe(true)
    // URL keys are NOT pass-through — a URL is free text that can carry a secret.
    for (const key of ['url', 'href', 'link', 'avatarUrl', 'workspaceUrl'])
      expect(isToolArgPassthroughKey(key), key).toBe(false)
    // Free-text keys are never pass-through.
    for (const key of [
      'message',
      'text',
      'title',
      'description',
      'body',
      'caption',
      'markdown',
      'content',
      'name',
      'value',
      'query'
    ])
      expect(isToolArgPassthroughKey(key), key).toBe(false)
  })
})

const ctx: SessionContext = {
  agentId: AGENT,
  platform: 'slack',
  integrationId: 'int-1',
  isDm: false,
  channel: 'C1',
  thread: '111.1',
  deliveryThread: '111.1',
  tools: toolsForIntegrations([
    {
      id: 'int-1',
      platform: 'slack',
      core: {
        mode: 'direct',
        bindRules: [],
        mutedChannels: [],
        gated: false,
        sessionModes: [],
        decisions: { bindings: [], definitions: [] }
      },
      config: { botToken: 'x', appToken: 'y' }
    }
  ]),
  integrations: [{ id: 'int-1', platform: 'slack' }]
}

const noMemory = {} as unknown as MemoryProvider

function makeDeps(over: Partial<OpsDeps> = {}): OpsDeps {
  return {
    gatewayFor: () => undefined,
    channelAgents: async () => {
      throw new Error('channelAgents not stubbed in this test')
    },
    messageAgent: async (req) => ({ delivered: true, targetSession: `stub:${req.toAgentId}` }),
    replyToSession: async (req) => ({ delivered: true, targetSession: 'stub', inReplyTo: req.messageId }),
    memory: noMemory,
    recordOutbound: async () => {},
    now: () => 1000,
    readAskers: async (c) => ({
      people: [
        c.integrationId
          ? { kind: 'member', platform: c.platform, integrationId: c.integrationId, userId: 'U_ASKER' }
          : { kind: 'console', userId: 'user-asker' }
      ],
      nobody: false
    }),
    readLookups: () => ({
      member: async () => true,
      fullMember: async () => true,
      console: async () => ({ asker: 'linked', visible: new Set() }),
      linked: async () => null
    }),
    placeSnapshot: () => ({ isPrivate: false }),
    placeStore: {
      listSessions: async () => [],
      latestSession: async (agentId, channel) => ({
        key: `k-${channel}`,
        agentId,
        platform: 'slack',
        channel,
        thread: 't',
        acpSessionId: null,
        sessionId: `out-${channel}`,
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: 0
      }),
      transcriptPageForAgent: async () => ({ rows: [], hasMore: false }),
      getDisplayNames: async () => new Map()
    },
    maskAgentSecrets: (_agentId, args) => mask(args),
    maskAgentText: (_agentId, text) => maskText(text),
    ...over
  }
}

/** A gateway whose document reach covers the current conversation, so a canvas/list write passes. */
function fakeGateway(over: Partial<MessageGateway> = {}): MessageGateway {
  return {
    openDirectMessage: vi.fn(async (user: string) => `D-${user}`),
    postMessage: vi.fn(async () => 'ts-1'),
    getChannelInfo: vi.fn(async (id: string) => ({ id, name: 'general', isPrivate: false })),
    listMembers: vi.fn(async () => [{ id: 'U1', name: 'alice', isBot: false }]),
    listChannels: vi.fn(async () => [{ id: 'C1', name: 'general' }]),
    getUserProfile: vi.fn(async (u: string) => ({ id: u, name: 'alice', isBot: false })),
    downloadFile: vi.fn(async () => Buffer.from('BYTES')),
    documentReach: vi.fn(async () => ({ conversations: ['C1'], workspace: false, complete: true })),
    ...over
  }
}

describe('executeTool masks every tool', () => {
  it('sendMessage postMessage', async () => {
    const gw = fakeGateway()
    const deps = makeDeps({ gatewayFor: () => gw })
    await executeTool(
      ctx,
      'sendMessage',
      { action: 'postMessage', channel: 'C1', message: `leak ${API_KEY} end` },
      deps
    )
    expect(gw.postMessage).toHaveBeenCalledWith('C1', `leak ${KEY_PH} end`, undefined, expect.anything())
  })

  it('sendMessage rejects a toUser that smuggles a secret into the mention body', async () => {
    const gw = fakeGateway()
    const deps = makeDeps({ gatewayFor: () => gw })
    await expect(
      executeTool(
        ctx,
        'sendMessage',
        { action: 'postMessage', channel: 'C1', toUser: [`U1> <${API_KEY}> <@U1`], message: 'hi' },
        deps
      )
    ).rejects.toThrow(/toUser/)
    expect(gw.postMessage).not.toHaveBeenCalled()
  })

  it('sendMessage masks a bare secret-shaped toUser and rejects it (fail closed)', async () => {
    const gw = fakeGateway()
    const deps = makeDeps({ gatewayFor: () => gw })
    await expect(
      executeTool(ctx, 'sendMessage', { action: 'postMessage', channel: 'C1', toUser: API_KEY, message: 'hi' }, deps)
    ).rejects.toThrow(/toUser/)
    expect(gw.postMessage).not.toHaveBeenCalled()
  })

  it('sendMessage still posts a legit toUser array channel-root mention', async () => {
    const gw = fakeGateway()
    const deps = makeDeps({ gatewayFor: () => gw })
    await executeTool(
      ctx,
      'sendMessage',
      { action: 'postMessage', channel: 'C1', toUser: ['U1', 'U2'], message: 'hi' },
      deps
    )
    expect(gw.postMessage).toHaveBeenCalledWith('C1', '<@U1> <@U2> hi', undefined, expect.anything())
  })

  it('sendMessage file caption (uploadFile)', async () => {
    const gw = fakeGateway({
      uploadFile: vi.fn(async () => ({ ok: true as const }))
    })
    const deps = makeDeps({
      gatewayFor: () => gw,
      resolveAttachment: async () => ({ bytes: Buffer.from('x'), name: 'pic.png', mimeType: 'image/png' })
    })
    await executeTool(
      ctx,
      'sendMessage',
      { action: 'postMessage', channel: 'C1', attachment: 'pic.png', message: `caption ${HEADER}` },
      deps
    )
    expect(gw.uploadFile).toHaveBeenCalledWith(
      'C1',
      expect.anything(),
      `caption ${HEADER_PH}`,
      undefined,
      expect.anything()
    )
  })

  it('shareFile caption', async () => {
    const gw = fakeGateway({
      uploadFile: vi.fn(async (_c: string, _f: unknown, comment: string) => ({ ok: true as const, messageId: 'ts-1' }))
    })
    const deps = makeDeps({
      gatewayFor: () => gw,
      shareTarget: () => ({ ok: true, platform: 'slack', integrationId: 'int-1', channel: 'C1' }),
      readWorkspaceImage: async () => ({
        ok: true,
        bytes: Buffer.from('x'),
        name: 'p.png',
        mimeType: 'image/png',
        sha256: 'a'.repeat(64)
      }),
      recordShare: async () => {},
      now: () => 1000
    })
    await executeTool(ctx, 'shareFile', { path: 'p.png', caption: `see ${API_KEY}` }, deps)
    expect(gw.uploadFile).toHaveBeenCalledWith(
      'C1',
      expect.anything(),
      `see ${KEY_PH}`,
      expect.anything(),
      expect.anything()
    )
  })

  it('shareFile masks a secret in the upload display name and provenance marker', async () => {
    const shared: Array<{ text: string }> = []
    const gw = fakeGateway({
      uploadFile: vi.fn(async (_c: string, file: { name: string }, comment: string) => ({
        ok: true as const,
        messageId: 'ts-1'
      }))
    })
    const deps = makeDeps({
      gatewayFor: () => gw,
      shareTarget: () => ({ ok: true, platform: 'slack', integrationId: 'int-1', channel: 'C1' }),
      readWorkspaceImage: async () => ({
        ok: true,
        bytes: Buffer.from('x'),
        name: `${API_KEY}.png`,
        mimeType: 'image/png',
        sha256: 'a'.repeat(64)
      }),
      recordShare: async (_ctx, row: { text: string }) => {
        shared.push(row)
      },
      now: () => 1000
    })
    await executeTool(ctx, 'shareFile', { path: `${API_KEY}.png`, caption: 'see' }, deps)
    // The DISPLAY name is masked; the raw path was still used for the read (stubbed above).
    expect(gw.uploadFile).toHaveBeenCalledWith(
      'C1',
      expect.objectContaining({ name: `${KEY_PH}.png` }),
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
    // The provenance marker text is masked too.
    expect(shared[0]!.text).toContain(KEY_PH)
    expect(shared[0]!.text).not.toContain(API_KEY)
  })

  it('scheduleMessage', async () => {
    const gw = fakeGateway({
      scheduleMessage: vi.fn(async (channel: string, _text: string, postAt: number) => ({ id: 'q1', channel, postAt }))
    })
    const deps = makeDeps({ gatewayFor: () => gw })
    await executeTool(
      ctx,
      'scheduleMessage',
      { channel: 'C1', message: `later ${API_KEY}`, postAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() },
      deps
    )
    expect(gw.scheduleMessage).toHaveBeenCalledWith('C1', `later ${KEY_PH}`, expect.any(Number))
  })

  it('createCanvas masks title and markdown', async () => {
    const gw = fakeGateway({ createCanvas: vi.fn(async () => ({ id: 'F1', title: 't' })) })
    const deps = makeDeps({ gatewayFor: () => gw })
    await executeTool(ctx, 'createCanvas', { channel: 'C1', title: `t ${API_KEY}`, markdown: `m ${HEADER}` }, deps)
    expect(gw.createCanvas).toHaveBeenCalledWith(`t ${KEY_PH}`, `m ${HEADER_PH}`, 'C1')
  })

  it('updateCanvas masks edit markdown', async () => {
    const gw = fakeGateway({ updateCanvas: vi.fn(async () => {}) })
    const deps = makeDeps({ gatewayFor: () => gw })
    await executeTool(
      ctx,
      'updateCanvas',
      { canvasId: 'F1', edits: [{ operation: 'replace', sectionId: 's1', markdown: `m ${API_KEY}` }] },
      deps
    )
    expect(gw.updateCanvas).toHaveBeenCalledWith('F1', [
      { operation: 'replace', sectionId: 's1', markdown: `m ${KEY_PH}` }
    ])
  })

  it('addBookmark masks a secret in the link and the title', async () => {
    const gw = fakeGateway({
      addBookmark: vi.fn(async (_c: string, spec: { title: string }) => ({ id: 'b1', title: spec.title }))
    })
    const deps = makeDeps({ gatewayFor: () => gw })
    await executeTool(
      ctx,
      'addBookmark',
      { channel: 'C1', title: `runbook ${API_KEY}`, link: `https://docs.example.test/x?key=${HEADER}` },
      deps
    )
    expect(gw.addBookmark).toHaveBeenCalledWith('C1', {
      title: `runbook ${KEY_PH}`,
      link: `https://docs.example.test/x?key=${HEADER_PH}`
    })
  })

  it('addBookmark leaves a non-secret link and icon fields unchanged', async () => {
    const gw = fakeGateway({
      addBookmark: vi.fn(async (_c: string, spec: { title: string }) => ({ id: 'b1', title: spec.title }))
    })
    const deps = makeDeps({ gatewayFor: () => gw })
    await executeTool(
      ctx,
      'addBookmark',
      { channel: 'C1', title: 'runbook', link: 'https://docs.example.test/x', emoji: ':book:' },
      deps
    )
    expect(gw.addBookmark).toHaveBeenCalledWith('C1', {
      title: 'runbook',
      link: 'https://docs.example.test/x',
      emoji: ':book:'
    })
  })

  it('addListItem masks a secret in a nested link field value', async () => {
    const gw = fakeGateway({ addListItem: vi.fn(async () => ({ id: 'row-1', fields: {} })) })
    const deps = makeDeps({ gatewayFor: () => gw })
    await executeTool(
      ctx,
      'addListItem',
      {
        listId: 'L1',
        fields: [{ columnId: 'c1', type: 'link', value: { type: 'link', url: `https://x.test/?k=${API_KEY}` } }]
      },
      deps
    )
    expect(gw.addListItem).toHaveBeenCalledWith('L1', [
      { columnId: 'c1', type: 'link', value: { type: 'link', url: `https://x.test/?k=${KEY_PH}` } }
    ])
  })

  it.each(['addListItem', 'updateListItem'] as const)('%s masks list field values', async (name) => {
    const gw = fakeGateway({
      addListItem: vi.fn(async () => ({ id: 'row-1', fields: {} })),
      updateListItem: vi.fn(async () => {})
    })
    const deps = makeDeps({ gatewayFor: () => gw })
    const args =
      name === 'addListItem'
        ? { listId: 'L1', fields: [{ columnId: 'c1', type: 'text', value: `v ${API_KEY}` }] }
        : { listId: 'L1', itemId: 'row-1', fields: [{ columnId: 'c1', type: 'text', value: `v ${API_KEY}` }] }
    await executeTool(ctx, name, args, deps)
    const port = name === 'addListItem' ? gw.addListItem : gw.updateListItem
    expect(port).toHaveBeenCalledWith(
      'L1',
      ...[...(name === 'updateListItem' ? ['row-1'] : []), [{ columnId: 'c1', type: 'text', value: `v ${KEY_PH}` }]]
    )
  })

  it('createConversation masks the name and leaves user ids untouched', async () => {
    const gw = fakeGateway({ createConversation: vi.fn(async () => ({ id: 'C_NEW' })) })
    const deps = makeDeps({ gatewayFor: () => gw })
    await executeTool(ctx, 'createConversation', { name: `room ${API_KEY}`, users: ['U1'] }, deps)
    expect(gw.createConversation).toHaveBeenCalledWith({ name: `room ${KEY_PH}`, users: ['U1'] })
  })

  it('remind stores a masked message', async () => {
    const store = await openTestStore()
    try {
      const deps = makeDeps({
        shareTarget: (c) => ({
          ok: true,
          platform: c.platform,
          integrationId: c.integrationId,
          channel: c.channel,
          thread: c.deliveryThread
        }),
        assistantReminders: {
          ledger: store.assistantReminders,
          requesterFor: async () => 'U_ASKER',
          now: () => Date.now()
        }
      })
      await executeTool(
        ctx,
        'remind',
        { at: new Date(Date.now() + 120_000).toISOString(), message: `do ${API_KEY}` },
        deps
      )
      const open = await store.assistantReminders.listOpen(AGENT, {
        platform: ctx.platform,
        channel: ctx.channel,
        transportScope: ctx.transportScope ?? null
      })
      expect(open).toHaveLength(1)
      expect(open[0]!.message).toBe(`do ${KEY_PH}`)
    } finally {
      await store.close()
    }
  })
})

describe('executeTool masks Linear session tools', () => {
  const linearCtx: SessionContext = {
    ...ctx,
    platform: 'linear',
    integrationId: 'int-ln',
    channel: 'org-uuid',
    thread: 'session-uuid'
  }

  /** A Linear connection answering the resolution reads and capturing the mutation variables. */
  function linearConn(script: Record<string, unknown>) {
    const seen: Record<string, unknown>[] = []
    const request = vi.fn(async (query: string, variables: Record<string, unknown>) => {
      seen.push(variables)
      const op = /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? 'unknown'
      if (op in script) {
        const answer = script[op]
        return (typeof answer === 'function' ? answer(variables) : answer) as never
      }
      throw new Error(`unscripted operation ${op}`)
    })
    return { request, seen }
  }

  it('createIssueComment masks the body', async () => {
    const { request, seen } = linearConn({
      IssueRef: () => ({ issue: { id: 'i-1', identifier: 'ENG-1', team: { id: 't-1' } } }),
      CommentCreate: () => ({ commentCreate: { success: true, comment: { id: 'c-1' } } })
    })
    const deps = makeDeps({ sessionToolConnectionFor: () => ({ request }) })
    await executeTool(linearCtx, 'createIssueComment', { issue: 'ENG-1', body: `done ${API_KEY}` }, deps)
    const input = seen.find((v) => v.input)?.input as { body: string }
    expect(input.body).toBe(`done ${KEY_PH}`)
  })

  it('createIssue and updateIssue mask title and description', async () => {
    const { request, seen } = linearConn({
      TeamById: () => ({ team: { id: 't-1', key: 'ENG', name: 'Engineering' } }),
      IssueRef: () => ({ issue: { id: 'i-1', identifier: 'ENG-1', team: { id: 't-1' } } }),
      IssueCreate: () => ({ issueCreate: { success: true, issue: { id: 'i-1', identifier: 'ENG-1', title: 't' } } }),
      IssueUpdate: () => ({ issueUpdate: { success: true, issue: { id: 'i-1', identifier: 'ENG-1', title: 't' } } })
    })
    const deps = makeDeps({ sessionToolConnectionFor: () => ({ request }) })
    await executeTool(
      linearCtx,
      'createIssue',
      { team: '11111111-1111-4111-8111-111111111111', title: `t ${API_KEY}`, description: `d ${HEADER}` },
      deps
    )
    const created = seen.find((v) => v.input && !v.id)?.input as { title: string; description: string }
    expect(created.title).toBe(`t ${KEY_PH}`)
    expect(created.description).toBe(`d ${HEADER_PH}`)
    await executeTool(
      linearCtx,
      'updateIssue',
      { issue: 'ENG-1', title: `t2 ${API_KEY}`, description: `d2 ${HEADER}` },
      deps
    )
    const updated = seen.filter((v) => v.id === 'i-1').at(-1)?.input as { title: string; description: string }
    expect(updated.title).toBe(`t2 ${KEY_PH}`)
    expect(updated.description).toBe(`d2 ${HEADER_PH}`)
  })

  it('updateInitiative masks name, description and content', async () => {
    const { request, seen } = linearConn({
      InitiativesByName: () => ({ initiatives: { nodes: [{ id: 'init-1', name: 'One' }] } }),
      InitiativeUpdate: () => ({ initiativeUpdate: { success: true, initiative: { id: 'init-1' } } })
    })
    const deps = makeDeps({ sessionToolConnectionFor: () => ({ request }) })
    await executeTool(
      linearCtx,
      'updateInitiative',
      { initiative: 'One', name: `n ${API_KEY}`, description: `d ${HEADER}`, content: `c ${API_KEY}` },
      deps
    )
    const input = seen.find((v) => v.input)?.input as { name: string; description: string; content: string }
    expect(input.name).toBe(`n ${KEY_PH}`)
    expect(input.description).toBe(`d ${HEADER_PH}`)
    expect(input.content).toBe(`c ${KEY_PH}`)
  })
})

describe('guard: structural fields pass through while text fields are masked', () => {
  it('addBookmark masks a secret-shaped link instead of leaving it untouched', async () => {
    const gw = fakeGateway({
      addBookmark: vi.fn(async (_c: string, spec: { title: string }) => ({ id: 'b1', title: spec.title }))
    })
    const deps = makeDeps({ gatewayFor: () => gw })
    await executeTool(ctx, 'addBookmark', { channel: 'C1', title: `leak ${API_KEY}`, link: API_KEY }, deps)
    // The link equals the secret and is masked (URL keys are no longer pass-through); the title too.
    expect(gw.addBookmark).toHaveBeenCalledWith('C1', { title: `leak ${KEY_PH}`, link: KEY_PH })
  })
})

describe('registry coverage: masking runs before the dispatch switch', () => {
  const names = [
    ...TOOL_ARG_SCHEMAS.keys(),
    ...allSessionToolDescriptors().map((t) => t.name),
    ...allAttachmentReadTools().map((t) => t.name)
  ]

  it('covers every registered tool name through the single pre-dispatch mask', async () => {
    const unique = [...new Set(names)]
    expect(unique.length).toBeGreaterThan(50)
    const seen: Array<{ agentId: string; masked: boolean }> = []
    // `evaluationTool` swallows every name BEFORE the static registry, proving the mask ran first —
    // the seam the mask sits behind covers the static registry, session tools, evaluation and apps.
    const maskSpy = vi.fn((agentId: string, args: Record<string, unknown>) => {
      seen.push({ agentId, masked: true })
      return args
    })
    const evaluationTool = vi.fn(async (_c: SessionContext, _name: string, args: Record<string, unknown>) => {
      seen.push({ agentId: '', masked: 'message' in args })
      return { result: args }
    })
    const deps = makeDeps({ maskAgentSecrets: maskSpy, evaluationTool })
    for (const name of unique) {
      await executeTool(ctx, name, { message: API_KEY }, deps)
      expect(maskSpy, name).toHaveBeenCalledWith(AGENT, { message: API_KEY })
    }
    expect(maskSpy).toHaveBeenCalledTimes(unique.length)
    expect(evaluationTool).toHaveBeenCalledTimes(unique.length)
  })

  it('covers evaluation and MCP Apps tools with the same pre-dispatch mask', async () => {
    const evaluationArgs: Record<string, unknown>[] = []
    const appArgs: Record<string, unknown>[] = []
    const deps = makeDeps({
      evaluationTool: async (_c, _n, args) => {
        evaluationArgs.push(args)
        return { result: args }
      }
    })
    await executeTool(ctx, 'arena__move', { message: `eval ${API_KEY}` }, deps)
    expect(evaluationArgs[0]!.message).toBe(`eval ${KEY_PH}`)

    // A name the evaluation tool declines falls through to the app tool, still masked.
    const appDeps = makeDeps({
      evaluationTool: async () => undefined,
      appTool: async (_c, _n, args) => {
        appArgs.push(args)
        return { result: args }
      }
    })
    await executeTool(ctx, 'server__tool', { message: `app ${HEADER}` }, appDeps)
    expect(appArgs[0]!.message).toBe(`app ${HEADER_PH}`)
  })
})
