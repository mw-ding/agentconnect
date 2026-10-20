// Kanban title reads (issue #2 Lane 4b): the in-memory TTL cache, single-flight sharing, abort-on-failure, and ETag refresh.
import { describe, expect, it, vi } from 'vitest'
import { githubKanbanTitleSource, TITLE_CACHE_MAX, TITLE_TTL_MS, type GithubTitleSourceDeps } from './card-titles.js'
import { OrgId } from '../domain/ids.js'
import { GithubApiError } from '../github/api.js'
import { InstallationTokenInvalidatedError } from '../github/installation-token.service.js'
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
      repository_url: 'https://api.github.com/repos/acme/web'
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

describe('vera-528: title TTL cache', () => {
  it('starts freshness when a slow GitHub read finishes', async () => {
    let now = 1_000_000
    const fetchImpl = vi.fn(async () => {
      now += TITLE_TTL_MS + 1
      return issueResponse(1)
    })
    const { src } = source(fetchImpl, { clock: () => now })
    await src.read(BOARD, [1])
    expect((await src.read(BOARD, [1])).titles.get(1)?.title).toBe('title 1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refuses a 304 when a stale title had no ETag validator', async () => {
    let now = 1_000_000
    let reads = 0
    const fetchImpl = vi.fn(async () =>
      ++reads === 1 ? issueResponse(1, 'unvalidated', '') : new Response(null, { status: 304 })
    )
    const { src } = source(fetchImpl, { clock: () => now })
    await src.read(BOARD, [1])
    now += TITLE_TTL_MS + 1
    const result = await src.read(BOARD, [1])
    expect(result.titles.size).toBe(0)
    expect(result.missing).toEqual([1])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('vera-528: a repeated board view within TTL makes zero second GitHub calls', async () => {
    const now = 1_000_000
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
    expect(a?.titles.get(1)?.title).toBe('title 1')
    expect(b?.titles.get(2)?.title).toBe('title 2')
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

  it('vera-528: missing numbers share the TTL and are retried after expiry', async () => {
    let now = 1_000_000
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }))
    const { src } = source(fetchImpl, { clock: () => now })
    expect((await src.read(BOARD, [9])).missing).toEqual([9])
    expect((await src.read(BOARD, [9])).missing).toEqual([9])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    now += TITLE_TTL_MS + 1
    expect((await src.read(BOARD, [9])).missing).toEqual([9])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('isolates cached titles and ETags by installation even when the repository is the same', async () => {
    const fetchImpl = vi.fn(async () => issueResponse(7, 'private title', 'W/"private"'))
    const mint = vi.fn(async (id: bigint) => {
      if (id === 11n) throw new Error('old installation has no access')
      return { token: 'new-installation-token' }
    })
    const { src } = source(fetchImpl, {
      installations: {
        liveByOrgAndAccount: async (orgId) => ({ ...installation, installationId: orgId === BOARD.orgId ? 11n : 22n })
      },
      tokens: { mintKanbanCard: mint } as never
    })
    expect((await src.read({ ...BOARD, orgId: OrgId('org-2') }, [7])).titles.get(7)?.title).toBe('private title')
    await expect(src.read(BOARD, [7])).rejects.toMatchObject({ code: 'github_app_not_configured' })
    expect(mint.mock.calls.map(([id]) => id)).toEqual([22n, 11n])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not join another installation’s in-flight title or validator', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      if (headers.authorization?.includes('token-22')) await gate
      expect(headers['if-none-match']).toBeUndefined()
      return issueResponse(7, headers.authorization?.includes('token-22') ? 'new title' : 'old title')
    })
    const { src } = source(fetchImpl, {
      installations: {
        liveByOrgAndAccount: async (orgId) => ({ ...installation, installationId: orgId === BOARD.orgId ? 11n : 22n })
      },
      tokens: { mintKanbanCard: async (id: bigint) => ({ token: `token-${id}` }) } as never
    })
    const pending = src.read({ ...BOARD, orgId: OrgId('org-2') }, [7])
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    expect((await src.read(BOARD, [7])).titles.get(7)?.title).toBe('old title')
    release()
    expect((await pending).titles.get(7)?.title).toBe('new title')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('rechecks fresh entries when queued reads reach a worker', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchImpl = vi.fn(async (url: string) => {
      const n = Number(/\/issues\/(\d+)$/.exec(url)?.[1])
      if (n < 9) await gate
      return issueResponse(n)
    })
    const { src } = source(fetchImpl)
    const pending = src.read(
      BOARD,
      Array.from({ length: 9 }, (_, i) => i + 1)
    )
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(8))
    await src.read(BOARD, [9])
    release()
    expect((await pending).titles.get(9)?.title).toBe('title 9')
    expect(fetchImpl).toHaveBeenCalledTimes(9)
  })
})

describe('vera-528 r2: title source boundaries', () => {
  it('owns its cache: a second source never serves the first one’s titles', async () => {
    const fetchImpl = vi.fn(async () => issueResponse(1))
    await source(fetchImpl).src.read(BOARD, [1])
    await source(fetchImpl).src.read(BOARD, [1])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not follow a transfer redirect and reports the number as missing', async () => {
    const inits: Array<RequestInit | undefined> = []
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      inits.push(init)
      return new Response(
        JSON.stringify({ message: 'Moved Permanently', url: 'https://api.github.com/repositories/9999/issues/3' }),
        { status: 301, headers: { location: 'https://api.github.com/repositories/9999/issues/3' } }
      )
    })
    const { src } = source(fetchImpl)
    expect(await src.read(BOARD, [7])).toEqual({ titles: new Map(), missing: [7] })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(inits[0]?.redirect).toBe('manual')
  })

  it.each([
    ['a denied mint (404)', 'github_app_not_configured', new GithubApiError('denied', 404, 'LEASE_DENIED', false)],
    ['a bad app JWT (401)', 'github_app_not_configured', new GithubApiError('bad jwt', 401, 'INTERNAL', false)],
    ['a missing app key', 'github_app_not_configured', new Error('no private key')],
    ['a rate-limited mint', 'github_rate_limited', new GithubApiError('limited', 429, 'RATE_LIMITED', true)],
    ['a GitHub outage', 'github_unavailable', new GithubApiError('down', 503, 'INTERNAL', true)],
    ['an unreachable GitHub', 'github_unavailable', new GithubApiError('unreachable', 0, 'INTERNAL', true)],
    ['an installation change mid-mint', 'github_unavailable', new InstallationTokenInvalidatedError()]
  ])('maps %s to %s without reading any issue', async (_label, code, failure) => {
    const fetchImpl = vi.fn(async () => issueResponse(1))
    const { src } = source(fetchImpl, {
      tokens: {
        mintKanbanCard: async () => {
          throw failure
        }
      } as never
    })
    await expect(src.read(BOARD, [1])).rejects.toMatchObject({ code })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('vera-528: title abort-on-failure', () => {
  it('stops successful workers from draining 100 numbers after the first read is rate limited', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchImpl = vi.fn(async (url: string) => {
      const n = Number(/\/issues\/(\d+)$/.exec(url)?.[1])
      if (n === 1) return new Response('{}', { status: 429 })
      await gate
      return issueResponse(n)
    })
    const { src } = source(fetchImpl)
    await expect(
      src.read(
        BOARD,
        Array.from({ length: 100 }, (_, i) => i + 1)
      )
    ).rejects.toMatchObject({ code: 'github_rate_limited' })
    release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchImpl).toHaveBeenCalledTimes(8)
  })
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
