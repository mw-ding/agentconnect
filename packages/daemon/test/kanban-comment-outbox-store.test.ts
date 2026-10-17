// The kanban comment outbox through the real store: SQLite by default, the pool store under the `store-postgres` project.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KanbanReport } from '@agentconnect.md/protocol'
import { KanbanCommentPublisher, kanbanLeaseMarker } from '../src/kanban/kanban-comments.js'
import type { KanbanTerminalEntry } from '../src/kanban/kanban-worker.js'
import type { LocalStore } from '../src/store/local-store.js'
import { openTestStore } from './store-support.js'

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
  summary: 'shipped',
  reason: 'why'
}
/** A real epoch in milliseconds: it overflows a 32-bit column. */
const EPOCH_MS = Date.parse('2026-10-16T10:00:00Z')

const stores: LocalStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})
async function queued(): Promise<LocalStore> {
  const store = await openTestStore()
  stores.push(store)
  expect(await store.recordKanbanTerminal(entry, 1)).toBe(true)
  await store.settleKanbanTerminal(report.leaseId, true)
  return store
}

describe('the kanban comment outbox store', () => {
  it('keeps the first attempt bound across retries and round-trips a full epoch in milliseconds', async () => {
    const store = await queued()
    await store.markKanbanCommentAttempt(report.leaseId, EPOCH_MS + 15_000, EPOCH_MS)
    await store.markKanbanCommentAttempt(report.leaseId, EPOCH_MS + 30_000, EPOCH_MS + 20_000)
    await store.markKanbanCommentAttempt(report.leaseId, EPOCH_MS + 60_000, null)
    expect(await store.dueKanbanComments(EPOCH_MS, 10)).toEqual([])
    expect(await store.dueKanbanComments(EPOCH_MS + 60_000, 10)).toMatchObject([
      { attempted: true, attempts: 3, attemptedAt: EPOCH_MS, lookupMisses: 0, recordedAt: 1 }
    ])
  })

  it('keeps an unreadable first clock unreadable: a later reading does not invent a bound', async () => {
    const store = await queued()
    await store.markKanbanCommentAttempt(report.leaseId, 10, null)
    await store.markKanbanCommentAttempt(report.leaseId, 10, EPOCH_MS)
    const [row] = await store.dueKanbanComments(10, 10)
    expect(row).toMatchObject({ attempted: true, attempts: 2 })
    expect(row).not.toHaveProperty('attemptedAt')
  })

  it('counts undecided lookups and defers, then parks and removes', async () => {
    const store = await queued()
    await store.markKanbanCommentAttempt(report.leaseId, 5, EPOCH_MS)
    await store.deferKanbanCommentLookup(report.leaseId, 50)
    await store.deferKanbanCommentLookup(report.leaseId, 60)
    expect(await store.dueKanbanComments(55, 10)).toEqual([])
    expect(await store.dueKanbanComments(60, 10)).toMatchObject([{ lookupMisses: 2, attemptedAt: EPOCH_MS }])
    await store.deferKanbanComment(report.leaseId, 70)
    expect(await store.dueKanbanComments(65, 10)).toEqual([])
    await store.failKanbanComment(report.leaseId)
    expect(await store.dueKanbanComments(1e15, 10)).toEqual([])
    await store.removeKanbanComment(report.leaseId)
    await store.removeKanbanComment(report.leaseId)
  })

  it.each([60 * 60_000, -60 * 60_000])(
    'does not repost through the real store when the local clock is %i ms off GitHub and the POST response is lost',
    async (skew) => {
      const store = await queued()
      let githubNow = EPOCH_MS
      const comments: Array<{ body: string; updatedAt: number }> = []
      let loseResponse = true
      const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input))
        if ((init?.method ?? 'GET') === 'POST') {
          comments.push({ body: (JSON.parse(String(init?.body)) as { body: string }).body, updatedAt: githubNow })
          if (loseResponse) {
            loseResponse = false
            return new Response('bad gateway', { status: 502 })
          }
          return new Response(JSON.stringify({ id: 1 }), { status: 201 })
        }
        const since = url.searchParams.get('since')
        const found = comments.filter((c) => !since || c.updatedAt >= Date.parse(since))
        const body = url.searchParams.get('per_page') === '1' ? [] : found
        return new Response(JSON.stringify(body), { status: 200, headers: { date: new Date(githubNow).toUTCString() } })
      })
      let localNow = githubNow + skew
      const publisher = new KanbanCommentPublisher({
        clock: { now: () => localNow },
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        store,
        token: async () => 'ghs_test',
        fetchImpl: fetchImpl as typeof fetch,
        baseUrl: 'https://api.test'
      })
      await publisher.drain()
      expect(comments).toHaveLength(1)
      expect(comments[0]!.body).toContain(kanbanLeaseMarker(report.leaseId))
      githubNow += 5_000
      localNow = githubNow + skew + 60_000
      await publisher.drain()
      expect(comments).toHaveLength(1)
      expect(await store.dueKanbanComments(Number.MAX_SAFE_INTEGER, 10)).toEqual([])
    }
  )
})
