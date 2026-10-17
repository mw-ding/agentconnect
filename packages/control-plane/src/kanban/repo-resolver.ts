// Board repository resolution (issue #2 M1): a board only watches a repo that a live installation of its org covers.
import type { OrgId } from '../domain/ids.js'
import { GithubApiError } from '../github/api.js'
import type { GithubService } from '../github/service.js'
import type { GithubInstallationRepo } from '../persistence/ports.js'

export type KanbanRepoResolution =
  | { ok: true; repoId: bigint; repoFullName: string; installationId: bigint }
  | { ok: false; status: 400 | 409 | 429 | 502; message: string }

/** The board CRUD seam: production asks GitHub through the org's installation; tests and E2E inject their own. */
export interface KanbanRepoResolver {
  resolve(orgId: OrgId, repoFullName: string): Promise<KanbanRepoResolution>
}

const NOT_COVERED = {
  ok: false,
  status: 400,
  message: 'repository is not covered by a live GitHub App installation of this organization'
} as const

/** The hook route's attribution proof: the installation's own token can read the repo, so the org's App covers it. */
export function githubKanbanRepoResolver(deps: {
  installations: Pick<GithubInstallationRepo, 'liveByOrgAndAccount'>
  github?: Pick<GithubService, 'repoRefFor'>
}): KanbanRepoResolver {
  return {
    async resolve(orgId, repoFullName) {
      if (!deps.github) {
        return { ok: false, status: 409, message: 'GitHub App is not configured on this deployment (GITHUB_APP_*)' }
      }
      const [owner, repo] = repoFullName.split('/')
      if (!owner || !repo) return NOT_COVERED
      const ins = await deps.installations.liveByOrgAndAccount(orgId, owner)
      if (!ins || ins.revokedAt || ins.suspendedAt) return NOT_COVERED
      try {
        const ref = await deps.github.repoRefFor(ins, owner, repo)
        if (!ref) return NOT_COVERED
        return { ok: true, repoId: ref.repoId, repoFullName: ref.fullName, installationId: ins.installationId }
      } catch (e) {
        // GitHub being unreachable is upstream trouble, not a policy verdict.
        if (e instanceof GithubApiError) {
          return { ok: false, status: e.code === 'RATE_LIMITED' ? 429 : 502, message: `github: ${e.message}` }
        }
        throw e
      }
    }
  }
}
