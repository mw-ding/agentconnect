// Live, body-free reads for PR completion contracts (TRD 4.7): a PR's state and head, and the check runs on that head.
import { GithubApiError, githubRequest, type FetchLike } from '../github/api.js'
import type { InstallationTokenService } from '../github/installation-token.service.js'
import type { KanbanRepoRef } from './card-store.js'
import type { CheckRunFacts, LivePullRequest } from './contracts.js'

const PAGE = 100
/** Past this many runs the head is never judged green: an unread run could be a failure. */
const MAX_CHECK_PAGES = 3

export interface PrReader {
  /** Null when the number is not a pull request in this repository (deleted, or an issue). */
  readPullRequest(repo: KanbanRepoRef, prNumber: number): Promise<LivePullRequest | null>
  /** The newest run of each check on `sha`; `complete` is false when the list ran past the page bound. */
  readCheckRuns(repo: KanbanRepoRef, sha: string): Promise<{ runs: CheckRunFacts[]; complete: boolean }>
}

export interface GithubPrReaderDeps {
  tokens: Pick<InstallationTokenService, 'mintKanbanPr'>
  fetchImpl?: FetchLike
  baseUrl?: string
}

interface GhPull {
  number: number
  state: 'open' | 'closed'
  merged?: boolean
  merged_at?: string | null
  head?: { sha?: string }
}

interface GhCheckRun {
  id: number
  name?: string
  status?: string
  conclusion?: string | null
  app?: { id?: number } | null
}

interface GhCheckRuns {
  total_count: number
  check_runs: GhCheckRun[]
}

/** `filter=latest` dedupes only within a suite, so a re-run in a new suite (a new workflow run) leaves the old one listed. */
export function newestPerCheck<T extends { id: number; name?: string; app?: { id?: number } | null }>(
  runs: readonly T[]
): T[] {
  const newest = new Map<string, T>()
  for (const run of runs) {
    const key = `${run.app?.id ?? ''}:${run.name ?? `#${run.id}`}`
    const seen = newest.get(key)
    if (!seen || run.id > seen.id) newest.set(key, run)
  }
  return [...newest.values()]
}

export class GithubPrReader implements PrReader {
  constructor(private readonly deps: GithubPrReaderDeps) {}

  async readPullRequest(repo: KanbanRepoRef, prNumber: number): Promise<LivePullRequest | null> {
    let pull: GhPull
    try {
      pull = await this.get<GhPull>(repo, `/pulls/${prNumber}`)
    } catch (err) {
      if (err instanceof GithubApiError && (err.status === 404 || err.status === 410)) return null
      throw err
    }
    if (pull.number !== prNumber || !pull.head?.sha) return null
    return {
      number: pull.number,
      state: pull.state,
      merged: pull.merged === true || !!pull.merged_at,
      headSha: pull.head.sha
    }
  }

  async readCheckRuns(repo: KanbanRepoRef, sha: string): Promise<{ runs: CheckRunFacts[]; complete: boolean }> {
    const all: GhCheckRun[] = []
    const facts = () =>
      newestPerCheck(all).map((r) => ({ status: r.status ?? 'queued', conclusion: r.conclusion ?? null }))
    for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
      const res = await this.get<GhCheckRuns>(
        repo,
        `/commits/${encodeURIComponent(sha)}/check-runs?filter=latest&per_page=${PAGE}&page=${page}`
      )
      all.push(...res.check_runs)
      if (all.length >= res.total_count || res.check_runs.length < PAGE) return { runs: facts(), complete: true }
    }
    return { runs: facts(), complete: false }
  }

  private async get<T>(repo: KanbanRepoRef, path: string): Promise<T> {
    const grant = await this.deps.tokens.mintKanbanPr(repo.installationId, repo.repoFullName, repo.repoId)
    return githubRequest<T>(`/repositories/${repo.repoId}${path}`, {
      auth: grant.token,
      fetchImpl: this.deps.fetchImpl,
      baseUrl: this.deps.baseUrl
    })
  }
}
