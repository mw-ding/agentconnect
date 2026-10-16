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
    dueKanbanComments: (now, limit) =>
      [...rows.values()].filter((row) => !row.failed && row.nextAt <= now).slice(0, limit),
    markKanbanCommentAttempt: (leaseId, nextAt, at) => {
      const row = rows.get(leaseId)!
      rows.set(leaseId, {
        ...row,
        attempts: row.attempts + 1,
        attempted: true,
        attemptedAt: row.attemptedAt ?? at,
        nextAt
      })
    },
    deferKanbanComment: (leaseId, nextAt) => {
      const row = rows.get(leaseId)!
      rows.set(leaseId, { ...row, nextAt })
    },
    deferKanbanCommentLookup: (leaseId, nextAt) => {
      const row = rows.get(leaseId)!
      rows.set(leaseId, { ...row, lookupMisses: row.lookupMisses + 1, nextAt })
    },
    failKanbanComment: (leaseId) => {
      const row = rows.get(leaseId)!
      rows.set(leaseId, { ...row, failed: true })
    },
    removeKanbanComment: (leaseId) => {
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
function fakeGithub(now: () => number) {
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
    lists.push(url)
    const since = url.searchParams.get('since')
    const perPage = Number(url.searchParams.get('per_page') ?? 30)
    const page = Number(url.searchParams.get('page') ?? 1)
    const matching = comments.filter((comment) => !since || comment.updatedAt >= Date.parse(since))
    const slice = matching.slice((page - 1) * perPage, page * perPage)
    const headers = new Headers()
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
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.test/repos/acme/web/issues/42/comments' })
    const posted = JSON.parse(calls[0]!.body!) as { body: string }
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
})
