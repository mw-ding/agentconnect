// Kanban Projects v2 Status projection writer (issue #2 M5): one-way mirror of card status onto an org-owned
// project's single-select Status field. Best-effort by contract: project() never throws, so a projection failure
// can never block or roll back the label transition it follows.
import { GithubApiError, githubGraphql, type FetchLike } from '../github/api.js'
import type { InstallationTokenService } from '../github/installation-token.service.js'
import type { KanbanBoardAdminRepo, KanbanCardRepo } from '../persistence/ports.js'
import type { KanbanStatus } from './card-state.js'
import type { KanbanRepoRef } from './card-store.js'
import { PROJECT_READ_QUERY } from './project-guard.js'

/** CP status → Project option name; matched case-insensitively because admins capitalize option names freely. */
export const PROJECT_STATUS_OPTIONS: Record<KanbanStatus, string> = {
  triage: 'Triage',
  todo: 'Todo',
  ready: 'Ready',
  running: 'Running',
  blocked: 'Blocked',
  review: 'Review',
  done: 'Done',
  archived: 'Archived'
}

/** Body-free reason codes for a swallowed projection failure; the option names and ids cached here are metadata. */
export type ProjectWriteReason =
  | 'project_issue_node_missing'
  | 'project_not_org_owned'
  | 'project_owner_mismatch'
  | 'project_option_missing'
  | 'project_item_add_failed'
  | 'project_item_missing'
  | 'project_field_write_failed'
  | 'project_access_denied'
  | 'project_rate_limited'

export interface KanbanProjectWriterDeps {
  tokens: Pick<InstallationTokenService, 'mintKanbanProject'>
  fetchImpl?: FetchLike
  baseUrl?: string
  log?: { info(o: object, msg: string): void }
  now?: () => number
  /** Field cache bound (tests shrink it); the least recently used entry is evicted past it. */
  fieldCacheMax?: number
}

/** Short-lived field metadata per (installation, project, field): options plus the owner the runtime guard re-checks. */
interface FieldCacheEntry {
  at: number
  ownerType?: string
  ownerLogin?: string
  options: Array<{ id: string; name: string }>
}

/** Field options stay fresh for minutes; a stale entry only risks one write against a renamed option set. */
const FIELD_CACHE_TTL_MS = 5 * 60_000
const FIELD_CACHE_MAX = 256

const ADD_ITEM_MUTATION = `mutation KanbanProjectAddItem($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
}`

const SET_STATUS_MUTATION = `mutation KanbanProjectSetStatus($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(
    input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }
  ) {
    projectV2Item { id }
  }
}`

/** The card's projection cache: an item id is only meaningful together with the project it was added to. */
export interface ProjectCardCache {
  issueNodeId?: string | null
  projectItemId?: string | null
  projectItemProjectId?: string | null
}

/** GitHub answers NOT_FOUND for an item id that no longer exists in the project; FORBIDDEN stays a denial. */
function itemMissing(err: unknown): boolean {
  return err instanceof GithubApiError && (err.graphqlErrorTypes?.includes('NOT_FOUND') ?? false)
}

export class KanbanProjectWriter {
  private readonly fields = new Map<string, FieldCacheEntry>()

  constructor(private readonly deps: KanbanProjectWriterDeps) {}

  /**
   * Mirror one status onto the board's project. Returns the item id for the caller to cache on the card, or null
   * when skipped (no projection, no issue node) or failed (logged with a body-free reason, then swallowed).
   */
  async project(args: {
    repo: KanbanRepoRef
    board: { projectNodeId: string | null; statusFieldId: string | null }
    card: ProjectCardCache
    status: KanbanStatus
  }): Promise<{ itemId: string } | null> {
    try {
      return await this.write(args)
    } catch (err) {
      // Total by contract: even a bug above this line degrades to a swallowed write, never a failed transition.
      this.deps.log?.info({ reason: this.reason(err, 'project_field_write_failed') }, 'kanban project write')
      return null
    }
  }

  private async write(args: {
    repo: KanbanRepoRef
    board: { projectNodeId: string | null; statusFieldId: string | null }
    card: ProjectCardCache
    status: KanbanStatus
  }): Promise<{ itemId: string } | null> {
    const { projectNodeId, statusFieldId } = args.board
    // No projection configured: no mint, no call.
    if (!projectNodeId || !statusFieldId) return null
    const issueNodeId = args.card.issueNodeId ?? null
    if (!issueNodeId) {
      this.deps.log?.info({ reason: 'project_issue_node_missing' satisfies ProjectWriteReason }, 'kanban project write')
      return null
    }
    const grant = await this.deps.tokens.mintKanbanProject(
      args.repo.installationId,
      args.repo.repoFullName,
      args.repo.repoId
    )
    const gql = <T>(query: string, variables: Record<string, unknown>) =>
      githubGraphql<T>(query, variables, {
        auth: grant.token,
        fetchImpl: this.deps.fetchImpl,
        baseUrl: this.deps.baseUrl,
        idempotent: true,
        // Mutations must not report partial data as success; the guard read must keep a denial's reason.
        strictErrors: true
      })
    // Every part of the key is load-bearing: a cached verdict never crosses an installation, a project, or a field.
    const fieldKey = `${args.repo.installationId}:${projectNodeId}:${statusFieldId}`
    let field: FieldCacheEntry
    try {
      field = await this.resolveField(gql, fieldKey, projectNodeId, statusFieldId)
    } catch (err) {
      this.deps.log?.info({ reason: this.reason(err, 'project_field_write_failed') }, 'kanban project write')
      return null
    }
    // Runtime org-only guard: a row that somehow names a user-owned project is never written to.
    if (field.ownerType !== 'Organization') {
      this.deps.log?.info({ reason: 'project_not_org_owned' satisfies ProjectWriteReason }, 'kanban project write')
      return null
    }
    // Same owner as the board repo: a PAT fallback can reach other orgs' projects, an installation token cannot.
    const repoOwner = args.repo.repoFullName.split('/')[0] ?? ''
    if (field.ownerLogin?.toLowerCase() !== repoOwner.toLowerCase()) {
      this.deps.log?.info({ reason: 'project_owner_mismatch' satisfies ProjectWriteReason }, 'kanban project write')
      return null
    }
    const option = field.options.find((o) => o.name.toLowerCase() === PROJECT_STATUS_OPTIONS[args.status].toLowerCase())
    if (!option) {
      this.deps.log?.info({ reason: 'project_option_missing' satisfies ProjectWriteReason }, 'kanban project write')
      return null
    }
    const add = async () =>
      (
        await gql<{ addProjectV2ItemById: { item: { id: string } } }>(ADD_ITEM_MUTATION, {
          project: projectNodeId,
          content: issueNodeId
        })
      ).addProjectV2ItemById.item.id
    // A failed write re-reads the field next time (e.g. a deleted option) instead of waiting out the TTL.
    const setStatus = (item: string) =>
      gql(SET_STATUS_MUTATION, { project: projectNodeId, item, field: statusFieldId, option: option.id }).catch(
        (err: unknown) => {
          this.fields.delete(fieldKey)
          throw err
        }
      )
    // Only an item cached for this very project is reused; a re-pointed board or a legacy row re-adds (idempotent).
    const cached = args.card.projectItemProjectId === projectNodeId ? (args.card.projectItemId ?? null) : null
    if (cached) {
      try {
        await setStatus(cached)
        return { itemId: cached }
      } catch (err) {
        if (!itemMissing(err)) {
          this.deps.log?.info({ reason: this.reason(err, 'project_field_write_failed') }, 'kanban project write')
          return null
        }
      }
      // Removed from the project by hand: re-add once and hand back the new id, logging exactly one line either way.
      let step: 'project_item_add_failed' | 'project_field_write_failed' = 'project_item_add_failed'
      try {
        const itemId = await add()
        step = 'project_field_write_failed'
        await setStatus(itemId)
        this.deps.log?.info({ reason: 'project_item_missing', recovered: true }, 'kanban project write')
        return { itemId }
      } catch (err) {
        this.deps.log?.info(
          { reason: 'project_item_missing', recovered: false, cause: this.reason(err, step) },
          'kanban project write'
        )
        return null
      }
    }
    let itemId: string
    try {
      itemId = await add()
    } catch (err) {
      this.deps.log?.info({ reason: this.reason(err, 'project_item_add_failed') }, 'kanban project write')
      return null
    }
    try {
      await setStatus(itemId)
    } catch (err) {
      this.deps.log?.info({ reason: this.reason(err, 'project_field_write_failed') }, 'kanban project write')
      return null
    }
    return { itemId }
  }

  private async resolveField(
    gql: <T>(query: string, variables: Record<string, unknown>) => Promise<T>,
    key: string,
    projectNodeId: string,
    statusFieldId: string
  ): Promise<FieldCacheEntry> {
    const now = this.deps.now?.() ?? Date.now()
    const cached = this.fields.get(key)
    this.fields.delete(key)
    if (cached && now - cached.at < FIELD_CACHE_TTL_MS) {
      // Re-inserting keeps the Map in least-recently-used order for eviction.
      this.fields.set(key, cached)
      return cached
    }
    const readback = await gql<{
      project?: { id?: string; owner?: { __typename?: string; login?: string } | null } | null
      field?: {
        __typename?: string
        id?: string
        project?: { id?: string } | null
        options?: Array<{ id?: string; name?: string }> | null
      } | null
    }>(PROJECT_READ_QUERY, { project: projectNodeId, field: statusFieldId })
    const owner = readback.project?.id === projectNodeId ? readback.project.owner : undefined
    const entry: FieldCacheEntry = {
      at: now,
      ownerType: owner?.__typename,
      ownerLogin: owner?.login,
      options: (readback.field?.project?.id === projectNodeId ? (readback.field.options ?? []) : []).flatMap((o) =>
        o.id && o.name ? [{ id: o.id, name: o.name }] : []
      )
    }
    this.fields.set(key, entry)
    const max = this.deps.fieldCacheMax ?? FIELD_CACHE_MAX
    for (const oldest of this.fields.keys()) {
      if (this.fields.size <= max) break
      this.fields.delete(oldest)
    }
    return entry
  }

  /** A denial or a limit keeps its own reason; a 401 is our credential misconfig, every other fault the step's. */
  private reason(err: unknown, step: 'project_item_add_failed' | 'project_field_write_failed'): ProjectWriteReason {
    if (err instanceof GithubApiError) {
      if (err.code === 'LEASE_DENIED') return 'project_access_denied'
      if (err.code === 'RATE_LIMITED') return 'project_rate_limited'
    }
    return step
  }
}

/** The dispatcher's one hook: load the board pair and the card cache, project, and remember a fresh item id. */
export interface KanbanProjectHook {
  /** Best-effort after a status label write; never throws, so the transition it follows cannot fail. */
  projectAfterLabel(args: {
    boardId: string
    orgId: string
    cardId: string
    repo: KanbanRepoRef
    status: KanbanStatus
    issueNodeId?: string | null
  }): Promise<void>
}

export function kanbanProjectHook(deps: {
  boards: Pick<KanbanBoardAdminRepo, 'getForOrg'>
  cards: Pick<KanbanCardRepo, 'getCard' | 'setProjectItemId'>
  writer: Pick<KanbanProjectWriter, 'project'>
}): KanbanProjectHook {
  return {
    async projectAfterLabel(args) {
      try {
        const board = await deps.boards.getForOrg(args.orgId, args.boardId)
        if (!board?.projectNodeId || !board.statusFieldId) return
        const card = await deps.cards.getCard(args.cardId)
        if (!card || card.boardId !== args.boardId) return
        const result = await deps.writer.project({
          repo: args.repo,
          board: { projectNodeId: board.projectNodeId, statusFieldId: board.statusFieldId },
          card: {
            issueNodeId: args.issueNodeId ?? card.issueNodeId,
            projectItemId: card.projectItemId,
            projectItemProjectId: card.projectItemProjectId
          },
          status: args.status
        })
        // Overwrite on any change of id or project, so a re-added or re-pointed item replaces the stale cache.
        const fresh =
          result && (result.itemId !== card.projectItemId || card.projectItemProjectId !== board.projectNodeId)
        if (fresh) await deps.cards.setProjectItemId(args.cardId, board.projectNodeId, result.itemId)
      } catch {
        // Best-effort projection: the writer already logged its own reason; a loader fault stays silent.
      }
    }
  }
}
