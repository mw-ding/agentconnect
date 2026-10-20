// Live, body-free PR bindings and check facts for completion contracts.
import { GithubApiError, githubRequest, type FetchLike } from '../github/api.js'
import type { InstallationTokenService } from '../github/installation-token.service.js'
import type { KanbanRepoRef } from './card-store.js'
import type { CheckRunFacts, LivePullRequest } from './contracts.js'

const PAGE = 100
// An unread page could hold a failure, so every list is bounded and reports truncation.
const MAX_CHECK_PAGES = 3

export interface PrReader {
  // A missing or non-PR number returns null; binding metadata is projected from live GitHub reads.
  readPullRequest(repo: KanbanRepoRef, prNumber: number): Promise<LivePullRequest | null>
  // Truncating either the check or workflow list sets complete=false; actionsUnreadable means no actions:read.
  readCheckRuns(
    repo: KanbanRepoRef,
    sha: string
  ): Promise<{ runs: CheckRunFacts[]; complete: boolean; actionsUnreadable?: boolean }>
}

export interface GithubPrReaderDeps {
  tokens: Pick<InstallationTokenService, 'mintKanbanPr' | 'mintKanbanActions'>
  fetchImpl?: FetchLike
  baseUrl?: string
}

interface GhPull {
  number: number
  state: 'open' | 'closed'
  merged?: boolean
  merged_at?: string | null
  user?: { login?: string; type?: string } | null
  merged_by?: { login?: string } | null
  head?: { sha?: string; ref?: string; repo?: { id?: number } | null }
  base?: { ref?: string }
  created_at?: string
}

interface GhCheckRun {
  id: number
  name?: string
  status?: string
  conclusion?: string | null
  app?: { id?: number; slug?: string } | null
  check_suite?: { id: number } | null
}

// Hosted Actions has a stable app id; the slug also identifies Actions on enterprise installations.
function isGithubActions(run: GhCheckRun): boolean {
  return run.app?.slug ? run.app.slug === 'github-actions' : run.app?.id === 15368
}

interface GhCheckRuns {
  total_count: number
  check_runs: GhCheckRun[]
}

interface GhWorkflowRuns {
  total_count: number
  workflow_runs: Array<{ check_suite_id: number; path: string; event?: string }>
}

// Missing actions:read (or Actions turned off): a mint refusal or a non-rate-limit 403/404/422 from the runs list.
function actionsRefused(err: unknown): boolean {
  return err instanceof GithubApiError && [403, 404, 422].includes(err.status) && err.code !== 'RATE_LIMITED'
}

/** The workflow run behind one Actions check suite: its file and the event that triggered it. */
export interface WorkflowIdentity {
  path: string
  event?: string
}

// filter=latest is suite-scoped; Actions reruns supersede only runs from the same workflow path and event.
export function newestPerCheck<T extends GhCheckRun>(
  runs: readonly T[],
  workflows: ReadonlyMap<number, WorkflowIdentity> = new Map()
): T[] {
  const newest = new Map<string, T>()
  for (const run of runs) {
    const wf = isGithubActions(run) && run.check_suite ? workflows.get(run.check_suite.id) : undefined
    const identity = wf ? ['workflow', wf.path, wf.event ?? ''] : ['suite', run.check_suite?.id ?? run.id]
    const key = JSON.stringify([run.app?.id, identity, run.name ?? `#${run.id}`])
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
    const repository = await this.get<{ default_branch?: string }>(repo, '')
    return {
      number: pull.number,
      state: pull.state,
      merged: pull.merged === true || !!pull.merged_at,
      headSha: pull.head.sha,
      authorLogin: pull.user?.login ?? null,
      authorType: pull.user?.type ?? null,
      headRef: pull.head.ref ?? null,
      headRepoId:
        Number.isSafeInteger(pull.head.repo?.id) && pull.head.repo!.id! > 0 ? BigInt(pull.head.repo!.id!) : null,
      baseRef: pull.base?.ref ?? null,
      defaultBranch: repository.default_branch ?? null,
      createdAt: pull.created_at ? new Date(pull.created_at) : null,
      mergedByLogin: pull.merged_by?.login ?? null
    }
  }

  async readCheckRuns(
    repo: KanbanRepoRef,
    sha: string
  ): Promise<{ runs: CheckRunFacts[]; complete: boolean; actionsUnreadable?: boolean }> {
    const all: GhCheckRun[] = []
    let complete = false
    for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
      const res = await this.get<GhCheckRuns>(
        repo,
        `/commits/${encodeURIComponent(sha)}/check-runs?filter=latest&per_page=${PAGE}&page=${page}`
      )
      all.push(...res.check_runs)
      if (all.length >= res.total_count || res.check_runs.length < PAGE) {
        complete = true
        break
      }
    }
    const workflows = new Map<number, WorkflowIdentity>()
    let actionsUnreadable = false
    if (all.some((r) => isGithubActions(r) && r.check_suite)) {
      let count = 0
      let workflowsComplete = false
      try {
        for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
          const res = await this.get<GhWorkflowRuns>(
            repo,
            `/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=${PAGE}&page=${page}`,
            'actions'
          )
          count += res.workflow_runs.length
          for (const run of res.workflow_runs) {
            if (run.path)
              workflows.set(run.check_suite_id, { path: run.path, ...(run.event ? { event: run.event } : {}) })
          }
          if (count >= res.total_count || res.workflow_runs.length < PAGE) {
            workflowsComplete = true
            break
          }
        }
      } catch (err) {
        // Only a refused permission fails closed as a verdict; anything transient throws and the sweep retries.
        if (!actionsRefused(err)) throw err
        actionsUnreadable = true
      }
      complete &&= workflowsComplete
    }
    const runs = newestPerCheck(all, workflows).map((r) => ({
      status: r.status ?? 'queued',
      conclusion: r.conclusion ?? null
    }))
    return { runs, complete, ...(actionsUnreadable ? { actionsUnreadable: true } : {}) }
  }

  // The workflow lookup alone uses the separate actions:read token, so pr_merged never depends on that permission.
  private async get<T>(repo: KanbanRepoRef, path: string, token: 'pr' | 'actions' = 'pr'): Promise<T> {
    const mint = token === 'actions' ? this.deps.tokens.mintKanbanActions : this.deps.tokens.mintKanbanPr
    const grant = await mint.call(this.deps.tokens, repo.installationId, repo.repoFullName, repo.repoId)
    return githubRequest<T>(`/repositories/${repo.repoId}${path}`, {
      auth: grant.token,
      fetchImpl: this.deps.fetchImpl,
      baseUrl: this.deps.baseUrl
    })
  }
}
