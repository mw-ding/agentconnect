// Live issue titles for the console board (issue #2 Lane 4b): read through on every call, never stored, logged, or cached.
// This is the one place an issue title enters the CP, and it only passes through to the response.
import { GithubApiError, githubRequest, type FetchLike } from '../github/api.js'
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
}

/** Reads titles with the read-scoped kanban card token, minted for this one repository id. */
export function githubKanbanTitleSource(deps: GithubTitleSourceDeps): KanbanTitleSource {
  return {
    async read(board, numbers) {
      const owner = board.repoFullName.split('/', 1)[0]
      const installation = owner ? await deps.installations.liveByOrgAndAccount(board.orgId, owner) : null
      if (!installation || installation.revokedAt || installation.suspendedAt) {
        throw new KanbanTitleError('github_app_not_configured')
      }
      const titles = new Map<number, LiveIssueTitle>()
      const missing: number[] = []
      try {
        const grant = await deps.tokens.mintKanbanCard(
          installation.installationId,
          board.repoFullName,
          board.repoId,
          'read'
        )
        const queue = [...numbers]
        const worker = async () => {
          for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
            const issue = await readIssue(deps, grant.token, board.repoId, n)
            if (issue) titles.set(n, issue)
            else missing.push(n)
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

async function readIssue(
  deps: GithubTitleSourceDeps,
  token: string,
  repoId: bigint,
  number: number
): Promise<LiveIssueTitle | null> {
  let issue: GhIssueTitle
  try {
    issue = await githubRequest<GhIssueTitle>(`/repositories/${repoId}/issues/${number}`, {
      auth: token,
      fetchImpl: deps.fetchImpl,
      baseUrl: deps.baseUrl
    })
  } catch (err) {
    if (err instanceof GithubApiError && (err.status === 404 || err.status === 410)) return null
    throw err
  }
  // A transfer redirect can land on another issue or repository, and a pull request is not a card.
  if (issue.pull_request !== undefined || issue.number !== number) return null
  if (issue.repository?.id !== undefined && BigInt(issue.repository.id) !== repoId) return null
  if (typeof issue.title !== 'string' || typeof issue.html_url !== 'string') return null
  return { title: issue.title, state: issue.state === 'closed' ? 'closed' : 'open', htmlUrl: issue.html_url }
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
