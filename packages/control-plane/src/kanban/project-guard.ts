// Kanban Projects v2 org-only guard (issue #2 D1): a Status projection is configurable only for an org-owned project of the repo owner.
import { GithubApiError, githubGraphql, type FetchLike } from '../github/api.js'
import type { InstallationTokenService } from '../github/installation-token.service.js'

export type ProjectRefusalCode =
  | 'project_requires_org_repo'
  | 'project_not_found'
  | 'project_not_org_owned'
  | 'project_owner_mismatch'
  | 'status_field_invalid'

/** Stable refusal vocabulary: HTTP status, code, and a message that never carries GitHub error text. */
export const PROJECT_REFUSALS: Record<
  ProjectRefusalCode | 'github_rate_limited' | 'github_unavailable' | 'github_app_not_configured',
  { status: 400 | 409 | 429 | 502; message: string }
> = {
  project_requires_org_repo: {
    status: 400,
    message: 'a project projection requires a repository owned by a GitHub organization'
  },
  project_not_found: { status: 400, message: 'the GitHub project was not found or is not accessible to the App' },
  project_not_org_owned: { status: 400, message: 'the GitHub project is not owned by an organization' },
  project_owner_mismatch: {
    status: 400,
    message: 'the GitHub project belongs to a different organization than the board repository'
  },
  status_field_invalid: { status: 400, message: 'statusFieldId is not a single-select field of that project' },
  github_rate_limited: { status: 429, message: 'GitHub rate limit reached; retry later' },
  github_unavailable: { status: 502, message: 'GitHub is unavailable; retry later' },
  github_app_not_configured: { status: 409, message: 'GitHub App is not configured on this deployment (GITHUB_APP_*)' }
}

export type ProjectVerdict =
  | { ok: true; options: ProjectStatusOption[] }
  | { ok: false; code: keyof typeof PROJECT_REFUSALS; reason?: 'project_access_denied' }

export interface ProjectStatusOption {
  id: string
  name: string
}

/** The live GraphQL read the guard judges; every field optional because GitHub answers null for what it will not show. */
export interface ProjectReadback {
  project?: { id?: string; owner?: { __typename?: string; login?: string } | null } | null
  field?: {
    __typename?: string
    id?: string
    project?: { id?: string } | null
    options?: Array<{ id?: string; name?: string }> | null
  } | null
}

/** Pure verdict: repo owner type first (no GitHub read needed), then project existence, owner, and the Status field. */
export function judgeProjectConfig(args: {
  repoOwner: string
  ownerType: string | undefined
  projectNodeId: string
  statusFieldId: string
  readback?: ProjectReadback
}): ProjectVerdict {
  if (args.ownerType !== 'Organization') return { ok: false, code: 'project_requires_org_repo' }
  const project = args.readback?.project
  if (!project || project.id !== args.projectNodeId) return { ok: false, code: 'project_not_found' }
  if (project.owner?.__typename !== 'Organization') return { ok: false, code: 'project_not_org_owned' }
  if (project.owner.login?.toLowerCase() !== args.repoOwner.toLowerCase()) {
    return { ok: false, code: 'project_owner_mismatch' }
  }
  const field = args.readback?.field
  if (
    field?.__typename !== 'ProjectV2SingleSelectField' ||
    field.id !== args.statusFieldId ||
    field.project?.id !== args.projectNodeId
  ) {
    return { ok: false, code: 'status_field_invalid' }
  }
  const options = (field.options ?? []).flatMap((o) => (o.id && o.name ? [{ id: o.id, name: o.name }] : []))
  return { ok: true, options }
}

/** Both-or-neither: the one place the pair rule lives for callers that hold the two ids. */
export function projectPairComplete(projectNodeId: unknown, statusFieldId: unknown): boolean {
  return (projectNodeId == null) === (statusFieldId == null)
}

/** The board CRUD seam: production asks GitHub; tests inject their own. */
export interface KanbanProjectVerifier {
  verify(args: {
    installationId: bigint
    repoId: bigint
    repoFullName: string
    ownerType: string | undefined
    projectNodeId: string
    statusFieldId: string
  }): Promise<ProjectVerdict>
}

export const PROJECT_READ_QUERY = `query KanbanProjectGuard($project: ID!, $field: ID!) {
  project: node(id: $project) {
    ... on ProjectV2 { id owner { __typename ... on Organization { login } ... on User { login } } }
  }
  field: node(id: $field) {
    __typename
    ... on ProjectV2SingleSelectField { id project { id } options { id name } }
  }
}`

/** Maps a GitHub failure onto the stable codes; a denial is project_not_found with a body-free log reason. */
export function projectFailureVerdict(err: unknown): Extract<ProjectVerdict, { ok: false }> {
  if (err instanceof GithubApiError) {
    if (err.code === 'RATE_LIMITED') return { ok: false, code: 'github_rate_limited' }
    // Only LEASE_DENIED is an access denial (403/404/422, or a GraphQL FORBIDDEN/NOT_FOUND read). A 401 is our own
    // App credential misconfig (api.ts maps it to INTERNAL), so it stays github_unavailable like every other fault.
    if (err.code === 'LEASE_DENIED') {
      return { ok: false, code: 'project_not_found', reason: 'project_access_denied' }
    }
    return { ok: false, code: 'github_unavailable' }
  }
  // Fail closed: an unexpected error (config, clock, bug) refuses the projection without leaking its text to the client.
  return { ok: false, code: 'github_unavailable' }
}

export function githubKanbanProjectVerifier(deps: {
  tokens: Pick<InstallationTokenService, 'mintKanbanProject'>
  fetchImpl?: FetchLike
  baseUrl?: string
}): KanbanProjectVerifier {
  return {
    async verify(args) {
      const repoOwner = args.repoFullName.split('/')[0] ?? ''
      // The owner type is already known: skip the mint and the read for a user-owned repo.
      if (args.ownerType !== 'Organization') {
        return judgeProjectConfig({ ...args, repoOwner })
      }
      try {
        const grant = await deps.tokens.mintKanbanProject(args.installationId, args.repoFullName, args.repoId)
        // strictErrors: a 200 with `errors[]` beside partial data is still a denial (FORBIDDEN/NOT_FOUND read on a
        // token without Projects access) and must keep its project_access_denied reason, not judge the partial data.
        const readback = await githubGraphql<ProjectReadback>(
          PROJECT_READ_QUERY,
          { project: args.projectNodeId, field: args.statusFieldId },
          { auth: grant.token, fetchImpl: deps.fetchImpl, baseUrl: deps.baseUrl, idempotent: true, strictErrors: true }
        )
        return judgeProjectConfig({ ...args, repoOwner, readback })
      } catch (err) {
        // The route owns the single body-free log line for verdict reasons; the verifier never logs here.
        return projectFailureVerdict(err)
      }
    }
  }
}
