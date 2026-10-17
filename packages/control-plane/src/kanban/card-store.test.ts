// GithubCardStore + KanbanLabelWriter over a scripted fetch: body-free reads, repo-id URLs, per-label add/remove writes.
import { describe, expect, it, vi } from 'vitest'
import type { FetchLike } from '../github/api.js'
import {
  GithubCardStore,
  isAppActor,
  isHumanActor,
  judgePromotion,
  lastPageFromLink,
  type KanbanRepoRef,
  type LabelEvent
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

const eventsPath = (page: number) => `/repositories/42/issues/7/events?per_page=100&page=${page}`

/** One events page as GitHub serves it, with `Link: rel="last"` when the history spans several pages. */
function eventsPage(events: unknown[], last?: number): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (last && last > 1) headers.link = `<https://api.github.com${eventsPath(last)}>; rel="last"`
  return new Response(JSON.stringify(events), { headers })
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
  repository_url: 'https://api.github.com/repos/acme/web',
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
      labels: ['ac/status:ready', 'bug'],
      authorLogin: null,
      authorType: null,
      authorViaGithubApp: false,
      repositoryFullName: 'acme/web'
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

  it.each([{ number: 8 }, { repository: { id: 99 } }])(
    'refuses a redirected issue outside the requested identity: %j',
    async (over) => {
      const h = harness({ 'GET /repositories/42/issues/7': () => json(issue(over)) })
      expect(await h.store.readCard(REPO, 7)).toBeNull()
    }
  )

  // Repo-id addressing survives a rename, so a new name still reads; only the importer fences on the name.
  it.each([
    ['https://api.github.com/repos/other/web', 'other/web'],
    ['https://api.github.com/repos/ACME/Web', 'ACME/Web'],
    [undefined, null]
  ])('reports the repository name %s without refusing the read', async (url, name) => {
    const h = harness({ 'GET /repositories/42/issues/7': () => json(issue({ repository_url: url })) })
    expect(await h.store.readCard(REPO, 7)).toMatchObject({ repositoryFullName: name })
  })

  it.each([false, true])('projects body-free author attribution with App flag %s', async (viaApp) => {
    const h = harness({
      'GET /repositories/42/issues/7': () =>
        json(
          issue({ user: { login: 'alice', type: 'User' }, performed_via_github_app: viaApp ? { slug: 'app' } : null })
        )
    })
    expect(await h.store.readCard(REPO, 7)).toMatchObject({
      authorLogin: 'alice',
      authorType: 'User',
      authorViaGithubApp: viaApp
    })
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
    ['case-variant App status removal', [ev(1, human), ev(2, bot, 'AC/STATUS:blocked', { event: 'unlabeled' })], false],
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

  it('reads the last page first and finds a later bot write without walking the history', async () => {
    const h = harness({
      [EVENTS]: () =>
        eventsPage([ev(1, human), ...Array.from({ length: 99 }, (_, i) => ({ id: i + 2, event: 'closed' }))], 30),
      [`GET ${eventsPath(30)}`]: () => eventsPage([ev(2901, human), ev(2902, bot)], 30)
    })
    expect(await h.store.statusSetByHuman(REPO, 7, 'ready')).toBe(false)
    expect(h.calls.map((c) => c.url.replace('https://api.test', ''))).toEqual([eventsPath(1), eventsPath(30)])
  })

  it('walks backward from the last page until it sees the latest status change and add', async () => {
    const filler = (page: number) => Array.from({ length: 100 }, (_, i) => ({ id: page * 100 + i, event: 'closed' }))
    const h = harness({
      [EVENTS]: () => eventsPage(filler(0), 4),
      [`GET ${eventsPath(2)}`]: () => eventsPage([...filler(1).slice(1), ev(199, human)], 4),
      [`GET ${eventsPath(3)}`]: () => eventsPage(filler(2), 4),
      [`GET ${eventsPath(4)}`]: () => eventsPage(filler(3).slice(0, 5), 4)
    })
    expect(await h.store.statusSetByHuman(REPO, 7, 'ready')).toBe(true)
    expect(h.calls.map((c) => c.url.replace('https://api.test', ''))).toEqual([1, 4, 3, 2].map(eventsPath))
  })

  it('fails closed past the history bound and on a read failure', async () => {
    const routes: Record<string, () => Response> = { [EVENTS]: () => eventsPage([ev(1, human)], 12) }
    for (let page = 2; page <= 12; page++) {
      routes[`GET ${eventsPath(page)}`] = () =>
        eventsPage(
          Array.from({ length: 100 }, (_, i) => ({ id: page * 100 + i, event: 'closed' })),
          12
        )
    }
    const h = harness(routes)
    expect(await h.store.statusSetByHuman(REPO, 7, 'ready')).toBe(false)
    expect(h.calls).toHaveLength(10)
    await expect(harness({}).store.statusSetByHuman(REPO, 7, 'ready')).rejects.toThrow()
  })

  it('reads every event oldest first, keeping only body-free attribution fields', async () => {
    const h = harness({
      [EVENTS]: () =>
        eventsPage([
          ev(3, human, 'ac/agent:worker', {
            performed_via_github_app: { slug: 'other' },
            actor: { ...human, email: 'x' }
          }),
          { id: 2, event: 'renamed', rename: { from: 'Secret roadmap', to: 'SECRET-BODY' }, actor: human },
          ev(1, human)
        ])
    })
    const events = await h.store.readLabelEvents(REPO, 7)
    expect(events).toEqual([
      { id: 1, event: 'labeled', label: { name: 'ac/status:ready' }, actor: human },
      { id: 2, event: 'renamed', actor: human },
      { id: 3, event: 'labeled', label: { name: 'ac/agent:worker' }, actor: human, performed_via_github_app: true }
    ])
    expect(JSON.stringify(events)).not.toMatch(/SECRET|roadmap|email/)
  })

  it('refuses a history past the page bound instead of answering from part of it', async () => {
    const routes: Record<string, () => Response> = { [EVENTS]: () => eventsPage([ev(1, human)], 12) }
    for (let page = 2; page <= 12; page++) routes[`GET ${eventsPath(page)}`] = () => eventsPage([ev(page, human)], 12)
    await expect(harness(routes).store.readLabelEvents(REPO, 7)).rejects.toThrow(/page bound/)
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
      'POST /repositories/42/issues/7/labels': () => json([{ id: 1, name: 'ac/status:ready' }]),
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
    expect(added).toHaveBeenCalledWith('ac/status:ready')
    expect(h.calls.map((call) => call.method)).toEqual(['POST', 'DELETE'])
  })

  it('does not notify when the ready POST times out or is refused', async () => {
    for (const response of [() => json({ message: 'unavailable' }, 503), () => json({ message: 'nope' }, 422)]) {
      const h = harness({ 'POST /repositories/42/issues/7/labels': response })
      const added = vi.fn()
      const plan = {
        outcome: 'accepted' as const,
        status: 'ready' as const,
        releaseLease: false,
        addLabels: ['ac/status:ready'],
        removeLabels: []
      }
      await expect(h.store.applyPlan(REPO, 7, { state: 'open', labels: [] }, plan, added)).rejects.toThrow()
      expect(added).not.toHaveBeenCalled()
    }
  })
})

describe('half-landed promotion attribution (events after the pre-POST cursor)', () => {
  const human = { type: 'User', login: 'maintainer' }
  const app = { type: 'Bot', login: 'AgentConnect[bot]' }
  const other = { type: 'Bot', login: 'renovate[bot]' }
  const CURSOR = 500
  let id = CURSOR
  const add = (name: string, actor: unknown): LabelEvent => ({
    id: ++id,
    event: 'labeled',
    label: { name: name.includes('/') ? name : `ac/status:${name}` },
    actor: actor as LabelEvent['actor']
  })
  const del = (name: string, actor: unknown): LabelEvent => ({ ...add(name, actor), event: 'unlabeled' })
  const state = (event: 'closed' | 'reopened', actor: unknown): LabelEvent => ({
    id: ++id,
    event,
    actor: actor as LabelEvent['actor']
  })
  // History before the cursor: a human filed the card as todo; it never counts toward the window.
  const before = (): LabelEvent[] => [{ id: 10, event: 'labeled', label: { name: 'ac/status:todo' }, actor: human }]

  it.each([
    ['our add, then our todo removal', () => [add('ready', app), del('todo', app)], true, 'adopt'],
    ['our add while the removal is still pending (residue)', () => [add('ready', app)], true, 'adopt'],
    ['a human finished it by hand', () => [add('ready', human), del('todo', human)], false, 'adopt'],
    [
      'a human re-added ready after an agent swap',
      () => [add('ready', app), del('ready', human), add('ready', human)],
      false,
      'adopt'
    ],
    [
      'unrelated non-managed labels are ignored',
      () => [{ ...add('ready', other), label: { name: 'bug' } }, add('ready', app)],
      true,
      'adopt'
    ],
    ['no ready add visible yet (lag)', () => [], true, 'inconclusive'],
    ['only our removal is visible yet', () => [del('todo', app)], true, 'inconclusive'],
    // Blocker 1: the POST timed out, so an App ready-add in the window may be an agent's.
    ['timed-out POST with an agent ready-add in the window', () => [add('ready', app)], false, 'reject'],
    ['timed-out POST with an agent add and removal', () => [add('ready', app), del('todo', app)], false, 'reject'],
    // Two App ready events: ours and an agent's are indistinguishable.
    [
      'two App ready-adds after a human removal',
      () => [add('ready', app), del('ready', human), add('ready', app)],
      true,
      'reject'
    ],
    [
      'another App ac/* write in the window',
      () => [add('ready', app), del('todo', app), add('ac/mode:write', app)],
      true,
      'reject'
    ],
    [
      'an App status change after our add',
      () => [add('ready', app), add('blocked', app), del('blocked', app)],
      true,
      'reject'
    ],
    [
      'App reopened the issue',
      () => [state('closed', human), state('reopened', app), add('ready', app)],
      true,
      'reject'
    ],
    ['a removal that is not our todo', () => [add('ready', app), del('triage', app)], true, 'reject'],
    ['another bot added ready', () => [add('ready', other)], true, 'reject'],
    ['another bot touched status later', () => [add('ready', app), add('triage', other)], true, 'reject'],
    [
      'human park, then an agent swap to ready',
      () => [add('blocked', human), del('todo', human), add('ready', app), del('blocked', app)],
      true,
      'reject'
    ]
  ] as const)('%s', (_name, window, postAccepted, expected) => {
    expect(judgePromotion([...before(), ...window()], 'agentconnect', CURSOR, postAccepted)).toBe(expected)
  })

  it('ignores App events at or before the cursor and never trusts an App write without a slug', () => {
    const old = { id: CURSOR, event: 'labeled', label: { name: 'ac/status:ready' }, actor: app } as LabelEvent
    expect(judgePromotion([old, add('ready', app)], 'agentconnect', CURSOR, true)).toBe('adopt')
    expect(judgePromotion([old], 'agentconnect', CURSOR, true)).toBe('inconclusive')
    expect(judgePromotion([add('ready', app)], undefined, CURSOR, true)).toBe('reject')
    expect(isAppActor({ actor: { type: 'User', login: 'agentconnect[bot]' } }, 'agentconnect')).toBe(false)
  })

  it('parses only the rel="last" page from a Link header', () => {
    const link = `<https://api.github.com${eventsPath(2)}>; rel="next", <https://api.github.com${eventsPath(9)}>; rel="last"`
    expect(lastPageFromLink(link)).toBe(9)
    expect(lastPageFromLink(`<https://api.github.com${eventsPath(2)}>; rel="next"`)).toBeNull()
    expect(lastPageFromLink(null)).toBeNull()
  })

  it('reads the cursor from the last page, and the window back to the cursor', async () => {
    const filler = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: from + i, event: 'closed', actor: human }))
    const h = harness(
      {
        [`GET ${eventsPath(1)}`]: () => eventsPage(filler(1, 100), 15),
        [`GET ${eventsPath(14)}`]: () => eventsPage(filler(1301, 100), 15),
        [`GET ${eventsPath(15)}`]: () =>
          eventsPage([...filler(1401, 30), { ...add('ready', app), id: 1431 }, { ...del('todo', app), id: 1432 }], 15)
      },
      'agentconnect'
    )
    expect(await h.store.lastEventId(REPO, 7)).toBe(1432)
    expect(h.calls.map((c) => c.url.replace('https://api.test', ''))).toEqual([eventsPath(1), eventsPath(15)])
    h.calls.length = 0
    // Over 1,400 events in all, yet the window after a recent cursor is one page back.
    expect(await h.store.promotionVerdict(REPO, 7, 1420, true)).toBe('adopt')
    expect(await h.store.promotionVerdict(REPO, 7, 1420, false)).toBe('reject')
    expect(await h.store.promotionVerdict(REPO, 7, 1431, true)).toBe('inconclusive')
    expect(h.mintKanbanCard).toHaveBeenCalledWith(111n, 'acme/web', 42n, 'read')
    expect(await harness({ [`GET ${eventsPath(1)}`]: () => eventsPage([]) }).store.lastEventId(REPO, 7)).toBe(0)
  })

  it('walks back from an empty rel="last" page to the newest event instead of falling to cursor 0', async () => {
    const filler = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i, event: 'closed' }))
    const h = harness({
      [`GET ${eventsPath(1)}`]: () => eventsPage(filler(1, 100), 3),
      [`GET ${eventsPath(2)}`]: () => eventsPage(filler(101, 100), 3),
      [`GET ${eventsPath(3)}`]: () => eventsPage([], 3)
    })
    expect(await h.store.lastEventId(REPO, 7)).toBe(200)
    expect(h.calls.map((c) => c.url.replace('https://api.test', ''))).toEqual([
      eventsPath(1),
      eventsPath(3),
      eventsPath(2)
    ])
  })

  it('throws rather than anchor at 0 when every page within the bound is empty', async () => {
    const routes: Record<string, () => Response> = {}
    for (let page = 1; page <= 12; page++) routes[`GET ${eventsPath(page)}`] = () => eventsPage([], 12)
    await expect(harness(routes).store.lastEventId(REPO, 7)).rejects.toThrow('page bound')
  })

  it('is inconclusive when the window reaches past the page bound (1,000+ events since the cursor)', async () => {
    const routes: Record<string, () => Response> = {}
    for (let page = 1; page <= 12; page++) {
      routes[`GET ${eventsPath(page)}`] = () =>
        eventsPage(
          Array.from({ length: 100 }, (_, i) =>
            page === 12 && i === 99 ? add('ready', app) : { id: page * 100 + i, event: 'closed' }
          ),
          12
        )
    }
    const h = harness(routes, 'agentconnect')
    expect(await h.store.promotionVerdict(REPO, 7, 50, true)).toBe('inconclusive')
    expect(h.calls).toHaveLength(10)
  })
})
