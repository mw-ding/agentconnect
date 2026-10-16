// GithubCardStore + KanbanLabelWriter over a scripted fetch: body-free reads, repo-id URLs, per-label add/remove writes.
import { describe, expect, it, vi } from 'vitest'
import type { FetchLike } from '../github/api.js'
import {
  findOurReadyEvent,
  GithubCardStore,
  isAppActor,
  isHumanActor,
  promotionAttributed,
  promotionEventWindow,
  type KanbanRepoRef
} from './card-store.js'
import { planLabelReconcile, statusLabel } from './card-state.js'
import { cardIdempotencyKey } from './card-key.js'

const REPO: KanbanRepoRef = { installationId: 111n, repoId: 42n, repoFullName: 'acme/web' }

interface Call {
  url: string
  method: string
  auth: string | null
  body: unknown
}

function harness(routes: Record<string, () => Response>, appSlug?: string) {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url,
      method,
      auth: headers.authorization ?? null,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    })
    const path = url.replace('https://api.test', '')
    const route = routes[`${method} ${path}`]
    return route ? route() : json({ message: 'Not Found' }, 404)
  }
  const mintKanbanCard = vi.fn(async (_i: bigint, repoFullName: string, _r: bigint, access: 'read' | 'write') => ({
    token: `ghs_${access}`,
    ttlSec: 3600,
    expiresAt: '2026-10-15T01:00:00Z',
    repoFullName,
    access: 'read' as const
  }))
  const store = new GithubCardStore({
    tokens: { mintKanbanCard },
    fetchImpl,
    baseUrl: 'https://api.test',
    ...(appSlug ? { appSlug } : {})
  })
  return { store, calls, mintKanbanCard }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const issue = (over: Record<string, unknown> = {}) => ({
  id: 9001,
  node_id: 'I_kw9001',
  number: 7,
  title: 'Secret roadmap',
  body: 'SECRET-BODY',
  state: 'open',
  state_reason: null,
  labels: [{ name: statusLabel('ready') }, { name: 'bug' }],
  repository: { id: 42 },
  ...over
})

describe('GithubCardStore reads', () => {
  it('reads a card by repo id with a read-scoped card token and drops title and body', async () => {
    const h = harness({ 'GET /repositories/42/issues/7': () => json(issue()) })
    const card = await h.store.readCard(REPO, 7)
    expect(card).toEqual({
      issueId: 9001n,
      nodeId: 'I_kw9001',
      number: 7,
      state: 'open',
      stateReason: null,
      labels: ['ac/status:ready', 'bug']
    })
    expect(JSON.stringify(card, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toMatch(
      /SECRET|roadmap/
    )
    expect(h.mintKanbanCard).toHaveBeenCalledWith(111n, 'acme/web', 42n, 'read')
    expect(h.calls[0]!.auth).toBe('Bearer ghs_read')
  })

  it('answers null for a missing issue or a pull request', async () => {
    const h = harness({ 'GET /repositories/42/issues/8': () => json(issue({ number: 8, pull_request: {} })) })
    expect(await h.store.readCard(REPO, 7)).toBeNull()
    expect(await h.store.readCard(REPO, 8)).toBeNull()
  })

  it('reads the parent, sub-issues, and blocked_by graph', async () => {
    const h = harness({
      'GET /repositories/42/issues/7/parent': () => json(issue({ id: 1, number: 2 })),
      'GET /repositories/42/issues/7/sub_issues?per_page=100': () =>
        json([issue({ id: 3, number: 9, state: 'closed', state_reason: 'completed' })]),
      'GET /repositories/42/issues/7/dependencies/blocked_by?per_page=100': () =>
        json([issue({ id: 4, number: 5, repository: { id: 77 } })]),
      'GET /repositories/42/issues/7/dependencies/blocking?per_page=100': () => json([issue({ id: 6, number: 11 })])
    })
    expect(await h.store.readGraph(REPO, 7)).toEqual({
      parent: { issueId: 1n, number: 2, repoId: 42n, state: 'open', stateReason: null },
      subIssues: [{ issueId: 3n, number: 9, repoId: 42n, state: 'closed', stateReason: 'completed' }],
      blockedBy: [{ issueId: 4n, number: 5, repoId: 77n, state: 'open', stateReason: null }],
      blocking: [{ issueId: 6n, number: 11, repoId: 42n, state: 'open', stateReason: null }],
      truncated: false
    })
  })

  it('treats a missing parent as none and flags a full page as truncated', async () => {
    const page = Array.from({ length: 100 }, (_, i) => issue({ id: 100 + i, number: 100 + i }))
    const h = harness({
      'GET /repositories/42/issues/7/sub_issues?per_page=100': () => json(page),
      'GET /repositories/42/issues/7/dependencies/blocked_by?per_page=100': () => json([]),
      'GET /repositories/42/issues/7/dependencies/blocking?per_page=100': () => json([])
    })
    const graph = await h.store.readGraph(REPO, 7)
    expect(graph.parent).toBeNull()
    expect(graph.truncated).toBe(true)
  })

  it('flags a full blocking page as truncated', async () => {
    const page = Array.from({ length: 100 }, (_, i) => issue({ id: 100 + i, number: 100 + i }))
    const h = harness({
      'GET /repositories/42/issues/7/sub_issues?per_page=100': () => json([]),
      'GET /repositories/42/issues/7/dependencies/blocked_by?per_page=100': () => json([]),
      'GET /repositories/42/issues/7/dependencies/blocking?per_page=100': () => json(page)
    })
    expect((await h.store.readGraph(REPO, 7)).truncated).toBe(true)
  })
})

describe('KanbanLabelWriter via applyPlan', () => {
  it('makes no GitHub call, and mints no token, for a no-op plan', async () => {
    const h = harness({})
    const observed = { labels: [statusLabel('ready')], state: 'open' as const }
    await h.store.applyPlan(REPO, 7, observed, planLabelReconcile({ status: 'ready', leased: false }, observed))
    expect(h.calls).toEqual([])
    expect(h.mintKanbanCard).not.toHaveBeenCalled()
  })

  it('repairs drift with per-label add then remove, never PATCHing the label set, then comments', async () => {
    const h = harness({
      'POST /repositories/42/issues/7/labels': () => json([]),
      'DELETE /repositories/42/issues/7/labels/ac%2Fstatus%3Ablocked': () => json([]),
      'DELETE /repositories/42/issues/7/labels/ac%2Fstatus%3Atriage': () => json([]),
      'POST /repositories/42/issues/7/comments': () => json({ id: 1 }, 201)
    })
    const observed = { labels: ['bug', statusLabel('blocked'), statusLabel('triage')], state: 'open' as const }
    const plan = planLabelReconcile({ status: 'ready', leased: false }, observed)
    await h.store.applyPlan(REPO, 7, observed, plan)
    expect(h.mintKanbanCard).toHaveBeenCalledWith(111n, 'acme/web', 42n, 'write')
    expect(h.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://api.test/repositories/42/issues/7/labels',
      'DELETE https://api.test/repositories/42/issues/7/labels/ac%2Fstatus%3Ablocked',
      'DELETE https://api.test/repositories/42/issues/7/labels/ac%2Fstatus%3Atriage',
      'POST https://api.test/repositories/42/issues/7/comments'
    ])
    expect(h.calls[0]!.body).toEqual({ labels: ['ac/status:ready'] })
    expect(h.calls[0]!.auth).toBe('Bearer ghs_write')
    expect(h.calls[3]!.body).toEqual({ body: plan.comment })
  })

  it('tolerates a 404 on remove because the label is already gone', async () => {
    const h = harness({
      'POST /repositories/42/issues/7/labels': () => json([]),
      'POST /repositories/42/issues/7/comments': () => json({ id: 1 }, 201)
    })
    const observed = { labels: [statusLabel('ready'), statusLabel('triage')], state: 'open' as const }
    const plan = planLabelReconcile({ status: 'ready', leased: false }, observed)
    await h.store.applyPlan(REPO, 7, observed, plan)
    expect(h.calls.map((c) => c.method)).toEqual(['DELETE', 'POST'])
  })

  it('propagates a non-404 remove failure', async () => {
    const h = harness({
      'DELETE /repositories/42/issues/7/labels/ac%2Fstatus%3Atriage': () => json({ message: 'boom' }, 500)
    })
    const observed = { labels: [statusLabel('ready'), statusLabel('triage')], state: 'open' as const }
    const plan = planLabelReconcile({ status: 'ready', leased: false }, observed)
    await expect(h.store.applyPlan(REPO, 7, observed, plan)).rejects.toThrow()
  })

  it('closes as completed together with the done label', async () => {
    const h = harness({ 'PATCH /repositories/42/issues/7': () => json(issue()) })
    const observed = { labels: [statusLabel('done')], state: 'open' as const }
    await h.store.applyPlan(REPO, 7, observed, planLabelReconcile({ status: 'review', leased: false }, observed))
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.body).toEqual({ state: 'closed', state_reason: 'completed' })
  })

  it('reopens without touching labels when only the issue state drifted', async () => {
    const h = harness({ 'PATCH /repositories/42/issues/7': () => json(issue()) })
    const observed = { labels: [statusLabel('ready')], state: 'closed' as const, stateReason: 'completed' }
    await h.store.applyPlan(REPO, 7, observed, planLabelReconcile({ status: 'ready', leased: false }, observed))
    expect(h.calls[0]!.body).toEqual({ state: 'open', state_reason: 'reopened' })
  })
})

describe('cardIdempotencyKey', () => {
  it('is a stable sha256 over (epic, step, spec) with unambiguous framing', () => {
    const key = cardIdempotencyKey({ epic: '9001', step: 'split', spec: 'Add the board' })
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    expect(cardIdempotencyKey({ epic: '9001', step: 'split', spec: 'Add the board' })).toBe(key)
    expect(cardIdempotencyKey({ epic: '9001', step: 'split', spec: 'Add the board!' })).not.toBe(key)
    expect(cardIdempotencyKey({ epic: 'a', step: 'bc', spec: '' })).not.toBe(
      cardIdempotencyKey({ epic: 'ab', step: 'c', spec: '' })
    )
  })
})

describe('display-only mode labels', () => {
  it('ignores a User/PAT label grant and never consults issue events', async () => {
    const events = vi.fn(() =>
      json([
        {
          id: 1,
          event: 'labeled',
          label: { name: 'ac/mode:write' },
          actor: { type: 'User', login: 'maintainer' },
          performed_via_github_app: null
        }
      ])
    )
    const h = harness({
      'GET /repositories/42/issues/7': () => json(issue({ labels: ['ac/status:ready', 'ac/mode:write'] })),
      'GET /repositories/42/issues/7/events?per_page=100&page=1': events
    })
    expect(await h.store.readCard(REPO, 7)).toMatchObject({ labels: ['ac/status:ready', 'ac/mode:write'] })
    expect(h.calls).toHaveLength(1)
    expect(events).not.toHaveBeenCalled()
  })
})

describe('status label attribution', () => {
  const ev = (id: number, actor: unknown, label = 'ac/status:ready', extra = {}) => ({
    id,
    event: 'labeled',
    label: { name: label },
    actor,
    ...extra
  })
  const human = { type: 'User', login: 'maintainer' }
  const bot = { type: 'Bot', login: 'agentconnect[bot]' }
  const EVENTS = 'GET /repositories/42/issues/7/events?per_page=100&page=1'

  it.each([
    ['human add', [ev(1, human)], true],
    ['bot add', [ev(1, bot)], false],
    ['unknown actor', [ev(1, null)], false],
    ['user-typed bot login', [ev(1, { type: 'User', login: 'worker[bot]' })], false],
    ['app on behalf of a user', [ev(1, human, 'ac/status:ready', { performed_via_github_app: { id: 1 } })], false],
    ['no history', [], false],
    ['bot re-add after human', [ev(1, human), ev(2, bot)], false],
    ['human re-add after bot', [ev(1, bot), ev(2, human)], true],
    [
      'bot removed the old status after a human add',
      [ev(1, human), ev(2, bot, 'ac/status:blocked', { event: 'unlabeled' })],
      false
    ],
    [
      'human removed the old status after a bot add',
      [ev(1, bot), ev(2, human, 'ac/status:blocked', { event: 'unlabeled' })],
      false
    ],
    ['unrelated later bot label', [ev(1, human), ev(2, bot, 'bug')], true]
  ])('%s', async (_name, events, expected) => {
    const h = harness({ [EVENTS]: () => json(events) })
    expect(await h.store.statusSetByHuman(REPO, 7, 'ready')).toBe(expected)
    expect(h.calls.every((c) => c.method === 'GET')).toBe(true)
    expect(h.mintKanbanCard).toHaveBeenCalledWith(111n, 'acme/web', 42n, 'read')
  })

  it('reads past a full page to find a later bot write', async () => {
    const h = harness({
      [EVENTS]: () => json([ev(1, human), ...Array.from({ length: 99 }, (_, i) => ({ id: i + 2, event: 'closed' }))]),
      'GET /repositories/42/issues/7/events?per_page=100&page=2': () => json([ev(101, bot)])
    })
    expect(await h.store.statusSetByHuman(REPO, 7, 'ready')).toBe(false)
    expect(h.calls).toHaveLength(2)
  })

  it('fails closed past the history bound and on a read failure', async () => {
    const routes: Record<string, () => Response> = {}
    for (let page = 1; page <= 10; page++) {
      routes[`GET /repositories/42/issues/7/events?per_page=100&page=${page}`] = () =>
        json(Array.from({ length: 100 }, (_, i) => ev((page - 1) * 100 + i, human)))
    }
    const h = harness(routes)
    expect(await h.store.statusSetByHuman(REPO, 7, 'ready')).toBe(false)
    expect(h.calls).toHaveLength(10)
    await expect(harness({}).store.statusSetByHuman(REPO, 7, 'ready')).rejects.toThrow()
  })

  it('classifies actors', () => {
    expect(isHumanActor({ actor: human })).toBe(true)
    expect(isHumanActor({ actor: { type: 'User' } })).toBe(false)
    expect(isHumanActor({ actor: bot })).toBe(false)
    expect(isHumanActor({ actor: undefined })).toBe(false)
  })
})

describe('label write receipts', () => {
  it('notifies after the ready POST and before a later removal fails', async () => {
    const h = harness({
      'POST /repositories/42/issues/7/labels': () =>
        new Response('[]', { headers: { date: 'Fri, 16 Oct 2026 00:00:01 GMT' } }),
      'DELETE /repositories/42/issues/7/labels/ac%2Fstatus%3Atodo': () => json({ message: 'unavailable' }, 503)
    })
    const added = vi.fn()
    await expect(
      h.store.applyPlan(
        REPO,
        7,
        { state: 'open', labels: ['ac/status:todo'] },
        {
          outcome: 'accepted',
          status: 'ready',
          releaseLease: false,
          addLabels: ['ac/status:ready'],
          removeLabels: ['ac/status:todo']
        },
        added
      )
    ).rejects.toThrow()
    expect(added).toHaveBeenCalledWith('ac/status:ready', new Date('2026-10-16T00:00:01.000Z'))
    expect(h.calls.map((call) => call.method)).toEqual(['POST', 'DELETE'])
  })
})

describe('half-landed promotion attribution', () => {
  const human = { type: 'User', login: 'maintainer' }
  const app = { type: 'Bot', login: 'AgentConnect[bot]' }
  const other = { type: 'Bot', login: 'renovate[bot]' }
  let id = 0
  const add = (name: string, actor: unknown) => ({
    id: ++id,
    event: 'labeled',
    created_at: '2026-10-16T00:00:00.000Z',
    label: { name: `ac/status:${name}` },
    actor
  })
  const del = (name: string, actor: unknown) => ({
    id: ++id,
    event: 'unlabeled',
    label: { name: `ac/status:${name}` },
    actor
  })
  const state = (event: 'closed' | 'reopened', actor: unknown) => ({ id: ++id, event, actor })

  it.each([
    ['our promotion over a human todo', () => [add('todo', human), add('ready', app), del('todo', app)], true],
    ['our residue (remove failed)', () => [add('todo', human), add('ready', app)], true],
    ['all-App history', () => [add('todo', app), add('ready', app), del('todo', app)], true],
    ['a human finished it', () => [add('todo', human), add('ready', human), del('todo', human)], true],
    [
      'human park, then an agent swap',
      () => [add('todo', human), add('blocked', human), del('todo', human), add('ready', app), del('blocked', app)],
      false
    ],
    ['human park left alongside todo', () => [add('todo', human), add('blocked', human), add('ready', app)], false],
    [
      'human closed it, an agent reopened it',
      () => [add('todo', human), state('closed', human), state('reopened', app), add('ready', app)],
      false
    ],
    [
      'human unparked back to todo first',
      () => [
        add('todo', human),
        add('blocked', human),
        del('todo', human),
        add('todo', human),
        del('blocked', human),
        add('ready', app)
      ],
      true
    ],
    ['another bot added ready', () => [add('todo', human), add('ready', other), del('todo', other)], false],
    [
      'another bot touched status later',
      () => [add('todo', human), add('ready', app), add('triage', other), del('triage', other)],
      false
    ],
    ['no ready add visible yet', () => [add('todo', human)], null],
    [
      'unrelated label events are ignored',
      () => [
        add('todo', human),
        { id: ++id, event: 'labeled', label: { name: 'bug' }, actor: other },
        add('ready', app)
      ],
      true
    ]
  ])('%s', (_name, events, expected) => {
    const list = events()
    const ours = list.find(
      (event) => event.event === 'labeled' && event.actor === app && event.label?.name?.endsWith('ready')
    )
    expect(promotionAttributed(list, 'agentconnect', ours?.id ?? null)).toBe(expected)
  })

  it.each([false, true])(
    'rejects a same-App ready re-add after a human removes ready (same second: %s)',
    (sameSecond) => {
      const todo = add('todo', human)
      const ownAdd = add('ready', app)
      const removed = del('ready', human)
      const agentAdd = { ...add('ready', app), created_at: sameSecond ? ownAdd.created_at : '2026-10-16T00:00:01Z' }
      const events = [todo, ownAdd, removed, agentAdd]
      expect(promotionAttributed(events, 'agentconnect', ownAdd.id)).toBe(false)
    }
  )

  it('adopts our event at :00 when the response Date is :01', () => {
    const todo = add('todo', human)
    const ownAdd = { ...add('ready', app), created_at: '2026-10-16T00:00:00.000Z' }
    const started = new Date('2026-10-16T00:00:00.200Z')
    const respondedAt = new Date('2026-10-16T00:00:01.000Z')
    const window = promotionEventWindow(started, respondedAt, started.getTime() + 150)
    expect(Date.parse(ownAdd.created_at)).not.toBe(respondedAt.getTime())
    expect(findOurReadyEvent([todo, ownAdd], 'agentconnect', window.notBefore, window.notAfter)).toBe(ownAdd.id)
    expect(promotionAttributed([todo, ownAdd], 'agentconnect', ownAdd.id)).toBe(true)
    const laterAgent = { ...add('ready', app), created_at: '2026-10-16T00:00:02.000Z' }
    expect(findOurReadyEvent([laterAgent], 'agentconnect', window.notBefore, window.notAfter)).toBeNull()
  })

  it('does not adopt an agent re-add in the same second after a human restores todo', () => {
    const todo = add('todo', human)
    const ownAdd = add('ready', app)
    const removed = del('ready', human)
    const restored = add('todo', human)
    const agentAdd = { ...add('ready', app), created_at: ownAdd.created_at }
    const notAfter = new Date('2026-10-16T00:00:01.000Z')
    expect(promotionAttributed([todo, ownAdd, removed, restored, agentAdd], 'agentconnect', ownAdd.id)).toBe(false)
    expect(
      findOurReadyEvent(
        [todo, ownAdd, removed, restored, agentAdd],
        'agentconnect',
        new Date(ownAdd.created_at!),
        notAfter
      )
    ).toBeNull()
  })

  it('cannot attribute a shared-App ready add without an event id', () => {
    expect(promotionAttributed([add('todo', human), add('ready', app)], 'agentconnect', null)).toBe(false)
  })

  it('defers when our event id is not in the visible history, even if that history ends on a human park', () => {
    const ready = add('ready', app)
    const todo = add('todo', human)
    expect(promotionAttributed([todo, ready], 'agentconnect', ready.id + 1_000)).toBe(null)
    expect(promotionAttributed([add('blocked', human)], 'agentconnect', ready.id + 1_000)).toBe(null)
  })

  it('treats zero or several App ready events inside the window as unidentified', () => {
    const started = new Date('2026-10-16T00:00:00.000Z')
    const notAfter = new Date('2026-10-16T00:00:02.000Z')
    const first = add('ready', app)
    const second = add('ready', app)
    expect(findOurReadyEvent([add('todo', human)], 'agentconnect', started, notAfter)).toBeNull()
    expect(findOurReadyEvent([first, second], 'agentconnect', started, notAfter)).toBeNull()
    expect(findOurReadyEvent([first], 'agentconnect', new Date('2026-10-16T00:00:05.000Z'), notAfter)).toBeNull()
    expect(findOurReadyEvent([first], 'agentconnect', started, null)).toBeNull()
  })

  it('never trusts an App write without a configured slug, and replays by event id', () => {
    const ready = add('ready', app)
    expect(promotionAttributed([add('todo', human), ready], undefined, ready.id)).toBe(false)
    const [park, swap] = [add('blocked', human), add('ready', app)]
    expect(promotionAttributed([swap, park], 'agentconnect', swap.id)).toBe(false)
    expect(isAppActor({ actor: { type: 'User', login: 'agentconnect[bot]' } }, 'agentconnect')).toBe(false)
  })

  it('reads the event history through the store and fails closed past the bound', async () => {
    const EVENTS = 'GET /repositories/42/issues/7/events?per_page=100&page=1'
    const ready = add('ready', app)
    const ok = harness({ [EVENTS]: () => json([add('todo', human), ready]) }, 'agentconnect')
    expect(await ok.store.promotionAttributed(REPO, 7, ready.id)).toBe(true)
    expect(
      await ok.store.identifyReadyEvent(
        REPO,
        7,
        new Date('2026-10-16T00:00:00.000Z'),
        new Date('2026-10-16T00:00:02.000Z')
      )
    ).toBe(ready.id)
    expect(ok.mintKanbanCard).toHaveBeenCalledWith(111n, 'acme/web', 42n, 'read')
    const routes: Record<string, () => Response> = {}
    for (let page = 1; page <= 10; page++) {
      routes[`GET /repositories/42/issues/7/events?per_page=100&page=${page}`] = () =>
        json(Array.from({ length: 100 }, () => add('ready', app)))
    }
    const bounded = harness(routes, 'agentconnect')
    expect(await bounded.store.promotionAttributed(REPO, 7, ready.id)).toBe(null)
    expect(
      await bounded.store.identifyReadyEvent(
        REPO,
        7,
        new Date('2026-10-16T00:00:00.000Z'),
        new Date('2026-10-16T00:00:02.000Z')
      )
    ).toBe(null)
  })
})
