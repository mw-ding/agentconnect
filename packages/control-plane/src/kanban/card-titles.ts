// Live issue titles for the console board (issue #2 Lane 4b): a short in-memory TTL over the reads, never stored, logged, or cached anywhere else.
// This is the one place an issue title enters the CP, and it only passes through to the response.
// TTL and installation-scoped single-flight limit reads; ETag revalidation preserves the shared REST budget.
import { GithubApiError, GithubNotModified, githubRequestPage, type FetchLike } from '../github/api.js'
import type { InstallationTokenService } from '../github/installation-token.service.js'
import type { OrgId } from '../domain/ids.js'
import type { GithubInstallationRepo } from '../persistence/ports.js'

/** Untrusted external text: whoever can file an issue on the repo chose this title. */
export interface LiveIssueTitle {
  title: string
  state: 'open' | 'closed'
  htmlUrl: string
}

export interface LiveTitles {
  titles: Map<number, LiveIssueTitle>
  /** Numbers GitHub no longer serves as an issue of this repository (deleted, transferred, or a pull request). */
  missing: number[]
}

export type KanbanTitleErrorCode = 'github_app_not_configured' | 'github_rate_limited' | 'github_unavailable'

/** A failure the route maps to a stable code; the message never carries GitHub response text. */
export class KanbanTitleError extends Error {
  constructor(readonly code: KanbanTitleErrorCode) {
    super(`kanban titles: ${code}`)
    this.name = 'KanbanTitleError'
  }
}

export interface KanbanTitleBoard {
  orgId: OrgId
  repoId: bigint
  repoFullName: string
}

export interface KanbanTitleSource {
  read(board: KanbanTitleBoard, numbers: readonly number[]): Promise<LiveTitles>
}

/** Parallel issue reads per request; the route caps one request at 100 numbers. */
const READ_CONCURRENCY = 8
/** Fresh entries are served without any GitHub call; a 304 refreshes the TTL without re-parsing a title. */
export const TITLE_TTL_MS = 60_000
/** Upper bound on cached entries across every board; the oldest entry goes first. Memory only, never the database. */
export const TITLE_CACHE_MAX = 2000

interface TitleCacheEntry {
  title: LiveIssueTitle | null
  etag: string | null
  expiresAt: number
}

const titleCache = new Map<string, TitleCacheEntry>()
const titleInflight = new Map<string, Promise<TitleCacheEntry>>()
const keyOf = (installationId: bigint, repoId: bigint, number: number) => `${installationId}:${repoId}:${number}`

/** Test hook: drop every cached and in-flight title (call between tests, never in production). */
export function clearKanbanTitleCache(): void {
  titleCache.clear()
  titleInflight.clear()
}

function storeEntry(key: string, title: LiveIssueTitle | null, etag: string | null, now: number) {
  const entry: TitleCacheEntry = { title, etag, expiresAt: now + TITLE_TTL_MS }
  titleCache.delete(key)
  titleCache.set(key, entry)
  while (titleCache.size > TITLE_CACHE_MAX) {
    const oldest = titleCache.keys().next()
    if (oldest.done) break
    titleCache.delete(oldest.value)
  }
  return entry
}

interface GhIssueTitle {
  number?: number
  title?: string
  state?: string
  html_url?: string
  pull_request?: unknown
  repository?: { id?: number }
}

export interface GithubTitleSourceDeps {
  installations: Pick<GithubInstallationRepo, 'liveByOrgAndAccount'>
  tokens: Pick<InstallationTokenService, 'mintKanbanCard'>
  fetchImpl?: FetchLike
  baseUrl?: string
  /** Clock for TTL tests; defaults to the wall clock. */
  clock?: () => number
}

/** Reads titles with the read-scoped kanban card token, minted for this one repository id. */
export function githubKanbanTitleSource(deps: GithubTitleSourceDeps): KanbanTitleSource {
  const now = () => (deps.clock ?? Date.now)()
  return {
    async read(board, numbers) {
      const owner = board.repoFullName.split('/', 1)[0]
      const installation = owner ? await deps.installations.liveByOrgAndAccount(board.orgId, owner) : null
      if (!installation || installation.revokedAt || installation.suspendedAt) {
        throw new KanbanTitleError('github_app_not_configured')
      }
      const titles = new Map<number, LiveIssueTitle>()
      const missing: number[] = []
      const seen = new Set<number>()
      const queue: number[] = []
      const validators = new Map<number, TitleCacheEntry>()
      const at = now()
      for (const n of numbers) {
        if (seen.has(n)) continue
        seen.add(n)
        const key = keyOf(installation.installationId, board.repoId, n)
        const cached = titleCache.get(key)
        // A hit refreshes its recency; a stale entry still lends its validator to the revalidation below.
        if (cached && cached.expiresAt > at) {
          titleCache.delete(key)
          titleCache.set(key, cached)
          if (cached.title) titles.set(n, cached.title)
          else missing.push(n)
        } else {
          if (cached) validators.set(n, cached)
          queue.push(n)
        }
      }
      if (queue.length === 0) return { titles, missing: missing.sort((a, b) => a - b) }
      try {
        const grant = await deps.tokens.mintKanbanCard(
          installation.installationId,
          board.repoFullName,
          board.repoId,
          'read'
        )
        // One read per key across concurrent requests: the second request awaits the first one's promise.
        // Sharing is limited to the same installation, repository and issue.
        const readKey = (n: number): Promise<TitleCacheEntry> => {
          const key = keyOf(installation.installationId, board.repoId, n)
          const cached = titleCache.get(key)
          if (cached && cached.expiresAt > now()) {
            titleCache.delete(key)
            titleCache.set(key, cached)
            return Promise.resolve(cached)
          }
          const running = titleInflight.get(key)
          if (running) return running
          const started = (async (): Promise<TitleCacheEntry> => {
            try {
              return await fetchIssue(deps, grant.token, key, board.repoId, n, cached ?? validators.get(n), now)
            } finally {
              titleInflight.delete(key)
            }
          })()
          titleInflight.set(key, started)
          return started
        }
        let aborted = false
        const worker = async () => {
          for (let n = queue.shift(); n !== undefined && !aborted; n = queue.shift()) {
            try {
              const entry = await readKey(n)
              if (entry.title) titles.set(n, entry.title)
              else missing.push(n)
            } catch (err) {
              aborted = true
              throw err
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, queue.length) }, worker))
      } catch (err) {
        throw toTitleError(err)
      }
      return { titles, missing: missing.sort((a, b) => a - b) }
    }
  }
}

async function fetchIssue(
  deps: GithubTitleSourceDeps,
  token: string,
  key: string,
  repoId: bigint,
  number: number,
  validator: TitleCacheEntry | undefined,
  now: () => number
): Promise<TitleCacheEntry> {
  const missing = () => storeEntry(key, null, null, now())
  let title: LiveIssueTitle
  let etag: string | null
  try {
    const page = await githubRequestPage<GhIssueTitle>(`/repositories/${repoId}/issues/${number}`, {
      auth: token,
      fetchImpl: deps.fetchImpl,
      baseUrl: deps.baseUrl,
      ...(validator?.etag ? { etag: validator.etag } : {})
    })
    const issue = page.data
    // A transfer redirect can land on another issue or repository, and a pull request is not a card.
    if (issue.pull_request !== undefined || issue.number !== number) return missing()
    if (issue.repository?.id !== undefined && BigInt(issue.repository.id) !== repoId) return missing()
    if (typeof issue.title !== 'string' || typeof issue.html_url !== 'string') return missing()
    title = { title: issue.title, state: issue.state === 'closed' ? 'closed' : 'open', htmlUrl: issue.html_url }
    etag = page.etag ?? null
  } catch (err) {
    // The validator held: the cached copy is still current, so refresh its TTL and serve it.
    if (err instanceof GithubNotModified) {
      if (!validator?.etag) return missing()
      return storeEntry(key, validator.title, validator.etag, now())
    }
    if (err instanceof GithubApiError && (err.status === 404 || err.status === 410)) return missing()
    throw err
  }
  // Missing entries share the short TTL so deleted or transferred issues do not consume a read on every view.
  return storeEntry(key, title, etag, now())
}

function toTitleError(err: unknown): KanbanTitleError {
  if (err instanceof KanbanTitleError) return err
  if (err instanceof GithubApiError) {
    return new KanbanTitleError(
      err.code === 'RATE_LIMITED' || err.status === 429 ? 'github_rate_limited' : 'github_unavailable'
    )
  }
  return new KanbanTitleError('github_unavailable')
}
