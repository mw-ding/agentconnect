// Live repository permission for one GitHub login (issue #2 §7): the Kanban gate for human-authored cards and actions.
import { GithubApiError, githubRequest, type FetchLike } from './api.js'
import type { InstallationTokenService } from './installation-token.service.js'

/** GitHub's role ladder, most to least privileged; `none` also covers non-collaborators and unknown logins. */
export type RepoPermissionLevel = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none'

export interface RepoPermissionTarget {
  installationId: bigint
  repoId: bigint
  repoFullName: string
}

export interface RepoPermissionLookup {
  /** Throws on transient GitHub failures; callers that gate must treat a throw as no access. */
  permission(repo: RepoPermissionTarget, login: string): Promise<RepoPermissionLevel>
}

const WRITE_LEVELS: ReadonlySet<RepoPermissionLevel> = new Set(['admin', 'maintain', 'write'])

export function hasWriteAccess(level: RepoPermissionLevel): boolean {
  return WRITE_LEVELS.has(level)
}

/** The legacy `permission` field folds maintain into write and triage into read; `role_name` restores both built-ins. */
export function parseRepoPermission(res: { permission?: string; role_name?: string }): RepoPermissionLevel {
  if (res.role_name === 'triage') return 'triage'
  const p = res.permission
  if (res.role_name === 'maintain' && p === 'write') return 'maintain'
  return p === 'admin' || p === 'write' || p === 'read' ? p : 'none'
}

export interface GithubRepoPermissionDeps {
  tokens: Pick<InstallationTokenService, 'mintKanbanCard'>
  fetchImpl?: FetchLike
  baseUrl?: string
  /** Non-write results are reused this long; write levels are never cached, so a demotion is seen at once. 0 = off. */
  ttlMs?: number
  now?: () => number
}

const DEFAULT_TTL_MS = 60_000
const MAX_CACHE_ENTRIES = 1_000

/** Asks GitHub with a read-scoped Kanban installation token, addressed by repo id so a rename cannot misroute it. */
export class GithubRepoPermission implements RepoPermissionLookup {
  private readonly cache = new Map<string, { level: RepoPermissionLevel; expiresAt: number }>()

  constructor(private readonly deps: GithubRepoPermissionDeps) {}

  async permission(repo: RepoPermissionTarget, login: string): Promise<RepoPermissionLevel> {
    const ttl = this.deps.ttlMs ?? DEFAULT_TTL_MS
    const now = this.deps.now ?? Date.now
    const key = `${repo.repoId}:${login.toLowerCase()}`
    const hit = this.cache.get(key)
    if (hit && hit.expiresAt > now()) return hit.level
    const level = await this.fetch(repo, login)
    // A cached write would outlive a demotion and hide an outage from the fail-closed gate; negatives are safe to reuse.
    if (ttl > 0 && !hasWriteAccess(level)) {
      if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(key, { level, expiresAt: now() + ttl })
    }
    return level
  }

  private async fetch(repo: RepoPermissionTarget, login: string): Promise<RepoPermissionLevel> {
    const grant = await this.deps.tokens.mintKanbanCard(repo.installationId, repo.repoFullName, repo.repoId, 'read')
    try {
      const res = await githubRequest<{ permission?: string; role_name?: string }>(
        `/repositories/${repo.repoId}/collaborators/${encodeURIComponent(login)}/permission`,
        { auth: grant.token, fetchImpl: this.deps.fetchImpl, baseUrl: this.deps.baseUrl }
      )
      return parseRepoPermission(res)
    } catch (err) {
      // 404 is a non-collaborator on a private repo or an unknown login; 422 is a login that cannot be a collaborator.
      if (err instanceof GithubApiError && (err.status === 404 || err.status === 422)) return 'none'
      throw err
    }
  }
}

/** Fail closed: a lookup that throws is no write access, never a pass. */
export async function checkWriteAccess(
  lookup: RepoPermissionLookup,
  repo: RepoPermissionTarget,
  login: string
): Promise<{ level: RepoPermissionLevel; write: boolean; error?: unknown }> {
  try {
    const level = await lookup.permission(repo, login)
    return { level, write: hasWriteAccess(level) }
  } catch (error) {
    return { level: 'none', write: false, error }
  }
}
