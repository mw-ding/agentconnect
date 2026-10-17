import { describe, expect, it, vi } from 'vitest'
import type { KanbanReport } from '@agentconnect.md/protocol'
import {
  KanbanCommentPublisher,
  kanbanFinalCommentBody,
  kanbanLeaseMarker,
  type KanbanCommentStore
} from '../../src/kanban/kanban-comments.js'
import type { KanbanCommentRow } from '../../src/store/local-store.js'
import type { KanbanTerminalEntry } from '../../src/kanban/kanban-worker.js'

const report: KanbanReport = {
  boardId: '11111111-1111-4111-8111-111111111111',
  cardId: '22222222-2222-4222-8222-222222222222',
  agentId: '33333333-3333-4333-8333-333333333333',
  leaseId: '44444444-4444-4444-8444-444444444444',
  attempt: 1,
  dispatchRevision: '3',
  outcome: 'completed'
}

const entry: KanbanTerminalEntry = {
  report,
  repoFullName: 'acme/web',
  issueNumber: 42,
  summary: 'shipped the fix',
  reason: 'needed a migration'
}

interface Row extends KanbanCommentRow {
  nextAt: number
  failed?: boolean
}

function memoryStore(): KanbanCommentStore & { rows: Map<string, Row> } {
  const rows = new Map<string, Row>()
  return {
    rows,
    dueKanbanComments: async (now, limit) =>
      [...rows.values()].filter((row) => !row.failed && row.nextAt <= now).slice(0, limit),
    markKanbanCommentAttempt: async (leaseId, nextAt, githubAt) => {
      const row = rows.get(leaseId)!
      const { attemptedAt: _first, ...rest } = row
      rows.set(leaseId, {
        ...rest,
        attempts: row.attempts + 1,
        attempted: true,
        ...(!row.attempted && githubAt !== null
          ? { attemptedAt: githubAt }
          : row.attemptedAt !== undefined
            ? { attemptedAt: row.attemptedAt }
            : {}),
        nextAt
      })
    },
    deferKanbanComment: async (leaseId, nextAt) => {
      const row = rows.get(leaseId)!
      rows.set(leaseId, { ...row, nextAt })
    },
    deferKanbanCommentLookup: async (leaseId, nextAt) => {
      const row = rows.get(leaseId)!
      rows.set(leaseId, { ...row, lookupMisses: row.lookupMisses + 1, nextAt })
    },
    failKanbanComment: async (leaseId) => {
      const row = rows.get(leaseId)!
      rows.set(leaseId, { ...row, failed: true })
    },
    removeKanbanComment: async (leaseId) => {
      rows.delete(leaseId)
    }
  }
}

function seed(store: { rows: Map<string, Row> }, patch: Partial<Row> = {}): void {
  store.rows.set(report.leaseId, {
    entry,
    attempts: 0,
    attempted: false,
    lookupMisses: 0,
    recordedAt: 1,
    nextAt: 0,
    ...patch
  })
}

/** A GitHub issue-comments endpoint as it really behaves: oldest first, sort/direction ignored, since honoured. */
function fakeGithub(now: () => number, opts: { sendDate?: boolean } = {}) {
  const comments: Array<{ id: number; body: string; updatedAt: number }> = []
  const lists: URL[] = []
  let failPosts = 0
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if ((init?.method ?? 'GET') !== 'GET') {
      const { body } = JSON.parse(String(init?.body)) as { body: string }
      comments.push({ id: comments.length + 1, body, updatedAt: now() })
      // The comment lands even when the response is lost.
      if (failPosts > 0) {
        failPosts -= 1
        return new Response('bad gateway', { status: 502 })
      }
      return new Response(JSON.stringify({ id: comments.length }), { status: 201 })
    }
    if (url.searchParams.get('per_page') !== '1') lists.push(url)
    const since = url.searchParams.get('since')
    const perPage = Number(url.searchParams.get('per_page') ?? 30)
    const page = Number(url.searchParams.get('page') ?? 1)
    const matching = comments.filter((comment) => !since || comment.updatedAt >= Date.parse(since))
    const slice = matching.slice((page - 1) * perPage, page * perPage)
    const headers = new Headers()
    if (opts.sendDate !== false) headers.set('date', new Date(now()).toUTCString())
    if (page * perPage < matching.length) {
      const next = new URL(url)
      next.searchParams.set('page', String(page + 1))
      headers.set('link', `<${next.toString()}>; rel="next"`)
    }
    return new Response(JSON.stringify(slice.map(({ id, body }) => ({ id, body }))), { status: 200, headers })
  })
  return {
    comments,
    lists,
    fetchImpl: fetchImpl as typeof fetch,
    failNextPost: () => {
      failPosts += 1
    },
    seedOld: (count: number, at: number) => {
      for (let i = 0; i < count; i++)
        comments.push({ id: comments.length + 1, body: `old comment ${i}`, updatedAt: at })
    }
  }
}

describe('KanbanCommentPublisher', () => {
  it('posts the summary once through GithubFinalPoster and does not post it again', async () => {
    const store = memoryStore()
    seed(store)
    const calls: Array<{ method: string; url: string; body?: string }> = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? 'GET',
        url: String(url),
        ...(init?.body ? { body: String(init.body) } : {})
      })
      return new Response(JSON.stringify({ id: 99 }), { status: 201 })
    })
    const publisher = new KanbanCommentPublisher({
      clock: { now: () => 1_000 },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      store,
      token: async () => 'ghs_test',
      fetchImpl: fetchImpl as typeof fetch,
      baseUrl: 'https://api.test'
    })
    await publisher.drain()
    await publisher.drain()
    // One GET reads GitHub's clock before the single POST.
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST'])
    expect(calls[1]).toMatchObject({ method: 'POST', url: 'https://api.test/repos/acme/web/issues/42/comments' })
    const posted = JSON.parse(calls[1]!.body!) as { body: string }
    expect(posted.body).toContain('shipped the fix')
    expect(posted.body).toContain('needed a migration')
    expect(posted.body).toContain(kanbanLeaseMarker(report.leaseId))
    expect(posted.body).toBe(kanbanFinalCommentBody(entry))
    expect(store.rows.size).toBe(0)
  })

  it('retries a failed post without dropping it, and will not post again once the marker is on the issue', async () => {
    const store = memoryStore()
    seed(store)
    let now = 1_000
    let posts = 0
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        const body = posts >= 2 ? [{ body: `done\n<!-- ${kanbanLeaseMarker(report.leaseId)} -->` }] : []
        return new Response(JSON.stringify(body), { status: 200 })
      }
      posts += 1
      if (posts === 1) return new Response('no', { status: 500 })
      return new Response(JSON.stringify({ id: 7 }), { status: 201 })
    })
    const publisher = new KanbanCommentPublisher({
      clock: { now: () => now },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      store,
      token: async () => 'ghs_test',
      fetchImpl: fetchImpl as typeof fetch,
      baseUrl: 'https://api.test'
    })
    await publisher.drain()
    expect(posts).toBe(1)
    expect(store.rows.get(report.leaseId)).toMatchObject({ attempted: true })
    now = 20_000
    await publisher.drain()
    expect(posts).toBe(2)
    expect(store.rows.size).toBe(0)
    seed(store, { attempted: true, attempts: 2 })
    await publisher.drain()
    expect(posts).toBe(2)
    expect(store.rows.size).toBe(0)
  })

  it('does not mistake a progress note for the final comment when it looks for the lease marker', async () => {
    const store = memoryStore()
    seed(store, { attempted: true, attempts: 1 })
    let posts = 0
    const note = `working on it\n<!-- ac-kanban-note:${report.leaseId}:1 -->`
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify([{ body: note }]), { status: 200 })
      posts += 1
      return new Response(JSON.stringify({ id: 9 }), { status: 201 })
    })
    const publisher = new KanbanCommentPublisher({
      clock: { now: () => 1_000 },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      store,
      token: async () => 'ghs_test',
      fetchImpl: fetchImpl as typeof fetch,
      baseUrl: 'https://api.test'
    })
    await publisher.drain()
    expect(posts).toBe(1)
    expect(store.rows.size).toBe(0)
  })

  it('defers without posting when the token mint fails', async () => {
    const store = memoryStore()
    seed(store)
    const fetchImpl = vi.fn()
    const publisher = new KanbanCommentPublisher({
      clock: { now: () => 5_000 },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      store,
      token: async () => {
        throw new Error('offline')
      },
      fetchImpl: fetchImpl as typeof fetch
    })
    await publisher.drain()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(store.rows.get(report.leaseId)).toMatchObject({ attempted: false, nextAt: 20_000 })
  })

  it('finds a marker posted after 600 older comments through since, and does not post it twice', async () => {
    const t0 = Date.parse('2026-10-16T10:00:00Z')
    let now = t0
    const github = fakeGithub(() => now)
    github.seedOld(600, t0 - 24 * 60 * 60_000)
    const store = memoryStore()
    seed(store, { recordedAt: t0 - 60 * 60_000 })
    const publisher = new KanbanCommentPublisher({
      clock: { now: () => now },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      store,
      token: async () => 'ghs_test',
      fetchImpl: github.fetchImpl,
      baseUrl: 'https://api.test'
    })
    github.failNextPost()
    await publisher.drain()
    expect(github.comments).toHaveLength(601)
    expect(store.rows.get(report.leaseId)).toMatchObject({ attempted: true, attemptedAt: t0 })
    now = t0 + 60_000
    await publisher.drain()
    expect(github.comments).toHaveLength(601)
    expect(store.rows.size).toBe(0)
    expect(github.lists).toHaveLength(1)
    const listed = github.lists[0]!
    expect(listed.searchParams.get('since')).toBe(new Date(t0 - 2 * 60_000).toISOString())
    expect(listed.searchParams.get('per_page')).toBe('100')
    expect(listed.searchParams.has('sort')).toBe(false)
    expect(listed.searchParams.has('direction')).toBe(false)
  })

  it.each([60 * 60_000, -60 * 60_000])(
    'does not repost when the local clock is %i ms off GitHub and the POST response is lost',
    async (skew) => {
      const githubT0 = Date.parse('2026-10-16T10:00:00Z')
      let githubNow = githubT0
      const github = fakeGithub(() => githubNow)
      const store = memoryStore()
      seed(store)
      const publisher = new KanbanCommentPublisher({
        clock: { now: () => githubNow + skew },
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        store,
        token: async () => 'ghs_test',
        fetchImpl: github.fetchImpl,
        baseUrl: 'https://api.test'
      })
      github.failNextPost()
      await publisher.drain()
      expect(github.comments).toHaveLength(1)
      // The bound is GitHub's clock, not the skewed local one.
      expect(store.rows.get(report.leaseId)).toMatchObject({ attempted: true, attemptedAt: githubT0 })
      githubNow += 5_000
      const row = store.rows.get(report.leaseId)!
      const retry = new KanbanCommentPublisher({
        clock: { now: () => row.nextAt },
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        store,
        token: async () => 'ghs_test',
        fetchImpl: github.fetchImpl,
        baseUrl: 'https://api.test'
      })
      await retry.drain()
      expect(github.comments).toHaveLength(1)
      expect(store.rows.size).toBe(0)
    }
  )

  it('scans without a since bound when GitHub gave no readable clock, and still does not repost', async () => {
    const t0 = Date.parse('2026-10-16T10:00:00Z')
    const github = fakeGithub(() => t0, { sendDate: false })
    const store = memoryStore()
    seed(store)
    const publisher = new KanbanCommentPublisher({
      clock: { now: () => t0 + 60 * 60_000 },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      store,
      token: async () => 'ghs_test',
      fetchImpl: github.fetchImpl,
      baseUrl: 'https://api.test'
    })
    github.failNextPost()
    await publisher.drain()
    expect(store.rows.get(report.leaseId)?.attemptedAt).toBeUndefined()
    store.rows.get(report.leaseId)!.nextAt = 0
    await publisher.drain()
    expect(github.comments).toHaveLength(1)
    expect(store.rows.size).toBe(0)
    expect(github.lists[0]!.searchParams.has('since')).toBe(false)
  })

  const publisherFor = (
    store: ReturnType<typeof memoryStore>,
    fetchImpl: typeof fetch,
    now: () => number,
    extra: Partial<ConstructorParameters<typeof KanbanCommentPublisher>[0]> = {}
  ) =>
    new KanbanCommentPublisher({
      clock: { now },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      store,
      token: async () => 'ghs_test',
      fetchImpl,
      baseUrl: 'https://api.test',
      ...extra
    })

  it.each([
    ['a garbled Date header', 'not a date'],
    ['an empty Date header', '']
  ])('records no bound for %s, and the lookup that follows scans from the start', async (_label, date) => {
    const t0 = Date.parse('2026-10-16T10:00:00Z')
    const github = fakeGithub(() => t0)
    const garbled = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const res = await github.fetchImpl(input, init)
      if ((init?.method ?? 'GET') !== 'GET') return res
      const headers = new Headers(res.headers)
      headers.set('date', date)
      return new Response(await res.text(), { status: res.status, headers })
    })
    const store = memoryStore()
    seed(store)
    const publisher = publisherFor(store, garbled as typeof fetch, () => t0)
    github.failNextPost()
    await publisher.drain()
    expect(store.rows.get(report.leaseId)?.attemptedAt).toBeUndefined()
    store.rows.get(report.leaseId)!.nextAt = 0
    await publisher.drain()
    expect(github.comments).toHaveLength(1)
    expect(github.lists[0]!.searchParams.has('since')).toBe(false)
  })

  it.each([
    ['a non-2xx clock read', () => new Response('nope', { status: 500, headers: { date: new Date(0).toUTCString() } })],
    [
      'a clock read that throws',
      () => {
        throw new Error('socket hang up')
      }
    ]
  ])('posts anyway with no bound after %s', async (_label, onClockRead) => {
    const store = memoryStore()
    seed(store)
    const posts: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return onClockRead()
      posts.push(String(url))
      return new Response(JSON.stringify({ id: 1 }), { status: 201 })
    })
    await publisherFor(store, fetchImpl as typeof fetch, () => 1_000).drain()
    expect(posts).toHaveLength(1)
    expect(store.rows.size).toBe(0)
  })

  it('stops waiting on a clock read that never returns, then posts with no bound', async () => {
    const store = memoryStore()
    seed(store)
    const posts: string[] = []
    const fetchImpl = vi.fn(
      (url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          if ((init?.method ?? 'GET') !== 'GET') {
            posts.push(String(url))
            resolve(new Response(JSON.stringify({ id: 1 }), { status: 201 }))
            return
          }
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
        })
    )
    await publisherFor(store, fetchImpl as typeof fetch, () => 1_000, { serverTimeTimeoutMs: 30 }).drain()
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) })
    expect(posts).toHaveLength(1)
    expect(store.rows.size).toBe(0)
  })

  it('keeps the first attempt bound on a retry, reads the clock only once, and posts again when the marker is absent', async () => {
    const t0 = Date.parse('2026-10-16T10:00:00Z')
    let githubNow = t0
    const github = fakeGithub(() => githubNow)
    const store = memoryStore()
    seed(store)
    const publisher = publisherFor(store, github.fetchImpl, () => githubNow + 3_600_000)
    // A 502 before the comment is stored would leave no marker: model it by dropping the comment again.
    github.failNextPost()
    await publisher.drain()
    expect(store.rows.get(report.leaseId)).toMatchObject({ attemptedAt: t0 })
    github.comments.length = 0
    githubNow = t0 + 120_000
    const row = store.rows.get(report.leaseId)!
    await publisherFor(store, github.fetchImpl, () => row.nextAt).drain()
    expect(github.comments).toHaveLength(1)
    expect(store.rows.size).toBe(0)
    // One clock read (per_page=1) in total: the retry reused the stored bound.
    const clockReads = (github.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url]) => String(url).includes('per_page=1&') || String(url).endsWith('per_page=1')
    )
    expect(clockReads).toHaveLength(1)
  })

  it('does not repost after five page-bound lookups; it parks the row for an operator', async () => {
    const t0 = Date.parse('2026-10-16T10:00:00Z')
    const github = fakeGithub(() => t0)
    github.seedOld(600, t0)
    const store = memoryStore()
    seed(store, { attempted: true, attempts: 1, attemptedAt: t0, recordedAt: t0 })
    let now = t0
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const publisher = new KanbanCommentPublisher({
      clock: { now: () => now },
      log,
      store,
      token: async () => 'ghs_test',
      fetchImpl: github.fetchImpl,
      baseUrl: 'https://api.test'
    })
    for (let i = 0; i < 5; i++) {
      await publisher.drain()
      now = store.rows.get(report.leaseId)!.nextAt
    }
    expect(store.rows.get(report.leaseId)).toMatchObject({ failed: true })
    expect(log.error).toHaveBeenCalledOnce()
    expect(github.comments).toHaveLength(600)
  })

  it('defers instead of posting when more than five pages changed since the attempt', async () => {
    const t0 = Date.parse('2026-10-16T10:00:00Z')
    const github = fakeGithub(() => t0)
    github.seedOld(600, t0)
    const store = memoryStore()
    seed(store, { attempted: true, attempts: 1, attemptedAt: t0, recordedAt: t0 })
    const publisher = new KanbanCommentPublisher({
      clock: { now: () => t0 },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      store,
      token: async () => 'ghs_test',
      fetchImpl: github.fetchImpl,
      baseUrl: 'https://api.test'
    })
    await publisher.drain()
    expect(github.comments).toHaveLength(600)
    expect(github.lists).toHaveLength(5)
    expect(store.rows.get(report.leaseId)).toMatchObject({ attempted: true, nextAt: t0 + 30_000 })
  })

  it('defers a timed-out marker lookup without posting and still drains the next comment', async () => {
    const store = memoryStore()
    seed(store, { attempted: true, attempts: 1 })
    const otherReport: KanbanReport = { ...report, leaseId: '55555555-5555-4555-8555-555555555555' }
    const other: KanbanTerminalEntry = { ...entry, report: otherReport, issueNumber: 43, summary: 'second card' }
    store.rows.set(otherReport.leaseId, {
      entry: other,
      attempts: 0,
      attempted: false,
      lookupMisses: 0,
      recordedAt: 2,
      nextAt: 0
    })
    const posts: string[] = []
    let bodyCancelled = false
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url)
      if ((init?.method ?? 'GET') !== 'GET') {
        posts.push(target)
        return new Response(JSON.stringify({ id: 7 }), { status: 201 })
      }
      // Headers arrive, then the body never ends. Only the lookup abort should cancel it.
      const stream = new ReadableStream({
        pull() {
          return new Promise(() => undefined)
        },
        cancel() {
          bodyCancelled = true
        }
      })
      return new Response(stream, { status: 200 })
    })
    const publisher = new KanbanCommentPublisher({
      clock: { now: () => 1_000 },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      store,
      token: async () => 'ghs_test',
      fetchImpl: fetchImpl as typeof fetch,
      baseUrl: 'https://api.test',
      markerLookupTimeoutMs: 50
    })
    await publisher.drain()
    expect(bodyCancelled).toBe(true)
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) })
    expect(posts).toEqual(['https://api.test/repos/acme/web/issues/43/comments'])
    expect(store.rows.get(report.leaseId)).toMatchObject({ attempted: true, nextAt: 31_000 })
    expect(store.rows.has(otherReport.leaseId)).toBe(false)
  })

  it('defers when the marker fetch itself never returns', async () => {
    const store = memoryStore()
    seed(store, { attempted: true, attempts: 1 })
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          const abort = () => reject(signal?.reason ?? new DOMException('The operation was aborted', 'TimeoutError'))
          if (!signal) return
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        })
    )
    const publisher = new KanbanCommentPublisher({
      clock: { now: () => 1_000 },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      store,
      token: async () => 'ghs_test',
      fetchImpl: fetchImpl as typeof fetch,
      baseUrl: 'https://api.test',
      markerLookupTimeoutMs: 50
    })
    await publisher.drain()
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(store.rows.get(report.leaseId)).toMatchObject({ attempted: true, nextAt: 31_000 })
  })

  it('parks the comment as failed with an error after five undecided lookups, never posting', async () => {
    const store = memoryStore()
    seed(store, { attempted: true, attempts: 1, attemptedAt: 1_000 })
    let now = 1_000
    const posts: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'GET') {
        posts.push(String(url))
        return new Response(JSON.stringify({ id: 1 }), { status: 201 })
      }
      return new Response('unavailable', { status: 503 })
    })
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const publisher = new KanbanCommentPublisher({
      clock: { now: () => now },
      log,
      store,
      token: async () => 'ghs_test',
      fetchImpl: fetchImpl as typeof fetch,
      baseUrl: 'https://api.test'
    })
    const waits: number[] = []
    for (let i = 0; i < 4; i++) {
      await publisher.drain()
      const row = store.rows.get(report.leaseId)!
      expect(row).toMatchObject({ lookupMisses: i + 1 })
      waits.push(row.nextAt - now)
      now = row.nextAt
    }
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000])
    expect(log.error).not.toHaveBeenCalled()
    await publisher.drain()
    expect(store.rows.get(report.leaseId)).toMatchObject({ failed: true })
    expect(log.error).toHaveBeenCalledOnce()
    expect(log.error.mock.calls[0]?.[0]).toContain(report.leaseId)
    expect(log.error.mock.calls[0]?.[0]).toContain('acme/web#42')
    now += 60 * 60_000
    await publisher.drain()
    expect(fetchImpl).toHaveBeenCalledTimes(5)
    expect(posts).toEqual([])
  })

  it.each([401, 403])(
    'drops the cached token when the marker lookup gets %i, then finds the marker with a fresh one',
    async (status) => {
      const store = memoryStore()
      seed(store, { attempted: true, attempts: 1, attemptedAt: 1_000 })
      let now = 1_000
      let cached: string | undefined
      let minted = 0
      const invalidated: string[] = []
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get('authorization')
        if (auth === 'Bearer ghs_1') return new Response('bad credentials', { status })
        return new Response(JSON.stringify([{ body: `<!-- ${kanbanLeaseMarker(report.leaseId)} -->` }]), {
          status: 200
        })
      })
      const publisher = new KanbanCommentPublisher({
        clock: { now: () => now },
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        store,
        token: async () => (cached ??= `ghs_${++minted}`),
        invalidateToken: (target, token) => {
          expect(target.report.leaseId).toBe(report.leaseId)
          invalidated.push(token)
          if (cached === token) cached = undefined
        },
        fetchImpl: fetchImpl as typeof fetch,
        baseUrl: 'https://api.test'
      })
      await publisher.drain()
      expect(invalidated).toEqual(['ghs_1'])
      expect(store.rows.get(report.leaseId)).toMatchObject({ lookupMisses: 1 })
      now = store.rows.get(report.leaseId)!.nextAt
      await publisher.drain()
      expect(minted).toBe(2)
      expect(store.rows.size).toBe(0)
      expect(fetchImpl.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true)
    }
  )
})
