// Kanban title reads (issue #2 Lane 4b): the in-memory TTL cache, single-flight sharing, abort-on-failure, and ETag refresh.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearKanbanTitleCache,
  githubKanbanTitleSource,
  TITLE_CACHE_MAX,
  TITLE_TTL_MS,
  type GithubTitleSourceDeps
} from './card-titles.js'
import { OrgId } from '../domain/ids.js'
import type { GithubInstallationRecord } from '../persistence/ports.js'

const BOARD = { orgId: OrgId('org-1'), repoId: 4242n, repoFullName: 'acme/web' }

const installation: GithubInstallationRecord = {
  id: 'titles-unit-inst',
  orgId: OrgId('org-1'),
  installationId: 11n,
  accountLogin: 'acme',
  accountType: 'Organization',
  permissions: { issues: 'read' },
  repositorySelection: 'selected',
  revokedAt: null,
  suspendedAt: null,
  createdAt: new Date(0)
}

const issueResponse = (n: number, title = `title ${n}`, etag = 'W/"v1"') =>
  new Response(
    JSON.stringify({
      number: n,
      title,
      state: 'open',
      html_url: `https://github.com/acme/web/issues/${n}`,
      repository: { id: 4242 }
    }),
    { status: 200, headers: { etag } }
  )

function source(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  extra: Partial<GithubTitleSourceDeps> = {}
) {
  const mint = vi.fn(async () => ({ token: 'unit-token' }))
  const src = githubKanbanTitleSource({
    installations: { liveByOrgAndAccount: async () => installation },
    tokens: { mintKanbanCard: mint } as never,
    fetchImpl: fetchImpl as never,
    ...extra
  })
  return { src, mint }
}

beforeEach(() => {
  clearKanbanTitleCache()
})

describe('vera-528: title TTL cache', () => {
  it('vera-528: a repeated board view within TTL makes zero second GitHub calls', async () => {
    let now = 1_000_000
    const fetchImpl = vi.fn(async (url: string) => issueResponse(Number(/\/issues\/(\d+)$/.exec(url)?.[1])))
    const { src, mint } = source(fetchImpl, { clock: () => now })
    const first = await src.read(BOARD, [1, 2, 3])
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(Object.keys(Object.fromEntries(first.titles))).toEqual(['1', '2', '3'])
    const second = await src.read(BOARD, [3, 2, 1])
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect([...second.titles.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3])
    // A fully cached view needs no token either: it returns before minting.
    expect(mint).toHaveBeenCalledTimes(1)
    expect(TITLE_TTL_MS).toBe(60_000)
  })

  it('vera-528: concurrent identical requests share one GitHub call per number', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchImpl = vi.fn(async (url: string) => {
      await gate
      return issueResponse(Number(/\/issues\/(\d+)$/.exec(url)?.[1]))
    })
    const { src } = source(fetchImpl)
    const pending = [src.read(BOARD, [1, 2]), src.read(BOARD, [2, 1])]
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
    // The second request joined the first one's in-flight reads: no new calls while gated.
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    release()
    const [a, b] = await Promise.all(pending)
    expect(a.titles.get(1)?.title).toBe('title 1')
    expect(b.titles.get(2)?.title).toBe('title 2')
  })

  it('vera-528: stale entries revalidate with If-None-Match and a 304 refreshes the TTL', async () => {
    let now = 1_000_000
    const seen: Array<Record<string, string>> = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push(Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)))
      if (seen.length === 1) return issueResponse(1, 'title 1', 'W/"abc"')
      return new Response(null, { status: 304 })
    })
    const { src } = source(fetchImpl, { clock: () => now })
    expect((await src.read(BOARD, [1])).titles.get(1)?.title).toBe('title 1')
    now += TITLE_TTL_MS + 1
    const stale = await src.read(BOARD, [1])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(seen[1]).toMatchObject({ 'if-none-match': 'W/"abc"' })
    expect(stale.titles.get(1)?.title).toBe('title 1')
    // The 304 refreshed the TTL: a third view inside the window makes no call.
    expect((await src.read(BOARD, [1])).titles.get(1)?.title).toBe('title 1')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('vera-528: the cache is bounded and evicts the oldest entries first', async () => {
    const fetchImpl = vi.fn(async (url: string) => issueResponse(Number(/\/issues\/(\d+)$/.exec(url)?.[1])))
    const { src } = source(fetchImpl)
    const numbers = Array.from({ length: TITLE_CACHE_MAX + 5 }, (_, i) => i + 1)
    await src.read(BOARD, numbers)
    expect(fetchImpl).toHaveBeenCalledTimes(TITLE_CACHE_MAX + 5)
    // The first five aged out; the last five are still cached.
    await src.read(BOARD, [1, 2, 3, 4, 5])
    expect(fetchImpl).toHaveBeenCalledTimes(TITLE_CACHE_MAX + 10)
    await src.read(BOARD, numbers.slice(-5))
    expect(fetchImpl).toHaveBeenCalledTimes(TITLE_CACHE_MAX + 10)
  })

  it('vera-528: numbers GitHub no longer serves are not cached', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }))
    const { src } = source(fetchImpl)
    expect((await src.read(BOARD, [9])).missing).toEqual([9])
    expect((await src.read(BOARD, [9])).missing).toEqual([9])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('vera-528: title abort-on-failure', () => {
  it('vera-528: a failing request stops the remaining workers', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'rate limited' }), { status: 429 }))
    const { src } = source(fetchImpl)
    const err = await src
      .read(
        BOARD,
        Array.from({ length: 100 }, (_, i) => i + 1)
      )
      .catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('github_rate_limited')
    // Eight workers each started exactly one number (429 is not retried); the other 92 were never taken.
    expect(fetchImpl).toHaveBeenCalledTimes(8)
  })

  it('vera-528: 100 numbers ending in 502 cost exactly 102 calls', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const n = Number(/\/issues\/(\d+)$/.exec(url)?.[1])
      if (n === 100) return new Response(JSON.stringify({ message: 'bad gateway' }), { status: 502 })
      return issueResponse(n)
    })
    const { src } = source(fetchImpl)
    const err = await src
      .read(
        BOARD,
        Array.from({ length: 100 }, (_, i) => i + 1)
      )
      .catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('github_unavailable')
    // 99 successes plus the failing number's initial call and its two read retries.
    expect(fetchImpl).toHaveBeenCalledTimes(102)
  })
})
