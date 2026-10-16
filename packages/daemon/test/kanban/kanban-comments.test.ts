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
}

function memoryStore(): KanbanCommentStore & { rows: Map<string, Row> } {
  const rows = new Map<string, Row>()
  return {
    rows,
    dueKanbanComments: (now, limit) => [...rows.values()].filter((row) => row.nextAt <= now).slice(0, limit),
    markKanbanCommentAttempt: (leaseId, nextAt) => {
      const row = rows.get(leaseId)!
      rows.set(leaseId, { ...row, attempts: row.attempts + 1, attempted: true, nextAt })
    },
    deferKanbanComment: (leaseId, nextAt) => {
      const row = rows.get(leaseId)!
      rows.set(leaseId, { ...row, nextAt })
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
    recordedAt: 1,
    nextAt: 0,
    ...patch
  })
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
      log: { info: vi.fn(), warn: vi.fn() },
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
      log: { info: vi.fn(), warn: vi.fn() },
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
      log: { info: vi.fn(), warn: vi.fn() },
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

  it('defers instead of posting when the marker is not in the newest 500 comments', async () => {
    const store = memoryStore()
    seed(store, { attempted: true, attempts: 1 })
    const posts: string[] = []
    let pages = 0
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'GET') {
        posts.push(String(url))
        return new Response(JSON.stringify({ id: 1 }), { status: 201 })
      }
      pages += 1
      const comments = Array.from({ length: 100 }, (_, i) => ({ body: `older comment ${pages}-${i}` }))
      const headers = new Headers({ link: `<https://api.test/comments?page=${pages + 1}>; rel="next"` })
      return new Response(JSON.stringify(comments), { status: 200, headers })
    })
    const publisher = new KanbanCommentPublisher({
      clock: { now: () => 1_000 },
      log: { info: vi.fn(), warn: vi.fn() },
      store,
      token: async () => 'ghs_test',
      fetchImpl: fetchImpl as typeof fetch,
      baseUrl: 'https://api.test'
    })
    await publisher.drain()
    expect(posts).toEqual([])
    expect(pages).toBe(5)
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('sort=created')
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('direction=desc')
    expect(store.rows.get(report.leaseId)).toMatchObject({ attempted: true, nextAt: 31_000 })
  })
})
