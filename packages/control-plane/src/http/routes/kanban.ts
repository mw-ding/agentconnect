// Kanban boards and run mode (issue #2): members read what they may see; only an interactive OIDC owner session configures.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { ctxOf, denyNonInteractive, denyNonOwner, orgOf } from '../rbac.js'
import { Tag } from '../plugins/openapi.js'
import { canView } from '../../authorization/policy.js'
import { githubKanbanProjectVerifier, PROJECT_REFUSALS, type ProjectVerdict } from '../../kanban/project-guard.js'
import { githubKanbanRepoResolver, type KanbanRepoResolution } from '../../kanban/repo-resolver.js'
import type { KanbanBoardView, KanbanBoardWriteRefusal } from '../../persistence/ports.js'
import { resolveShareSet } from '../sharing.js'
import {
  CreateKanbanBoardBody,
  ErrorDto,
  KanbanBoardDto,
  KanbanBoardListDto,
  type KanbanBoardDtoT,
  KanbanBoardModeDto,
  KanbanBoardParams,
  KanbanCardModeDto,
  KanbanCardParams,
  SetKanbanBoardModeBody,
  SetKanbanCardModeBody,
  UpdateKanbanBoardBody
} from '../dto/index.js'

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Kanban routes are owner-gated by default; `viewer` opts a read route out, and its handler must check `canView`. */
    kanbanAccess?: 'viewer'
  }
}

const notFound = { error: 'Not Found', statusCode: 404, code: 'not_found' } as const

// Credentials an agent could hold never reach configuration handlers, and neither do collaborators or viewers.
async function interactiveOwner(req: FastifyRequest, reply: FastifyReply) {
  if (denyNonInteractive(req, reply)) return reply
  if (denyNonOwner(req, reply)) return reply
}

// Owner-gated by default, so a route a later lane adds here cannot ship ungated; read routes opt out explicitly.
export function ownerGateByDefault(app: FastifyInstance): void {
  app.addHook('onRoute', (route) => {
    if (route.config?.kanbanAccess === 'viewer') return
    const existing = route.preValidation
    route.preValidation = [interactiveOwner, ...(existing ? (Array.isArray(existing) ? existing : [existing]) : [])]
  })
}

function boardDto(board: KanbanBoardView, req: FastifyRequest): KanbanBoardDtoT {
  return {
    id: board.id,
    orgId: board.orgId,
    name: board.name,
    repoId: board.repoId.toString(),
    repoFullName: board.repoFullName,
    orchestratorAgentId: board.orchestratorAgentId,
    verifierAgentId: board.verifierAgentId,
    maxInProgress: board.maxInProgress,
    maxInProgressPerAgent: board.maxInProgressPerAgent,
    epicMaxCards: board.epicMaxCards,
    epicMaxActive: board.epicMaxActive,
    staleLeaseSec: board.staleLeaseSec,
    failureLimit: board.failureLimit,
    protocolRetryLimit: board.protocolRetryLimit,
    blockRecurrenceLimit: board.blockRecurrenceLimit,
    defaultMode: board.defaultMode,
    completionContract: board.completionContract,
    enabled: board.enabled,
    configRevision: board.configRevision.toString(),
    visibility: board.visibility,
    sharedWith: board.sharedWith,
    createdBy: board.createdByUserId,
    lastModifiedBy: board.lastModifiedByUserId,
    lastModifiedAt: board.lastModifiedAt.toISOString(),
    createdAt: board.createdAt.toISOString(),
    projectNodeId: board.projectNodeId,
    statusFieldId: board.statusFieldId,
    canEdit: ctxOf(req).role === 'owner'
  }
}

// `code` is the stable, machine-readable reason clients branch on; the message is for people.
const REFUSALS: Record<
  KanbanBoardWriteRefusal,
  { statusCode: 400 | 404 | 409; error: string; message: string; code: KanbanBoardWriteRefusal }
> = {
  not_found: { statusCode: 404, error: 'Not Found', message: 'board not found', code: 'not_found' },
  repo_taken: {
    statusCode: 409,
    error: 'Conflict',
    message: 'this organization already has a board for that repository',
    code: 'repo_taken'
  },
  agent_not_in_org: {
    statusCode: 400,
    error: 'Bad Request',
    message: 'orchestrator and verifier must be agents of this organization',
    code: 'agent_not_in_org'
  },
  empty_audience: {
    statusCode: 400,
    error: 'Bad Request',
    message: 'a restricted board must be shared with at least one current member',
    code: 'empty_audience'
  },
  repo_has_cards: {
    statusCode: 409,
    error: 'Conflict',
    message: 'a board with cards cannot change repository',
    code: 'repo_has_cards'
  },
  active_runs: {
    statusCode: 409,
    error: 'Conflict',
    message: 'board has active runs; disable it and let them end first',
    code: 'active_runs'
  }
}

/** Repository-resolver refusals by status, each with a stable code. */
const UPSTREAM_ERRORS = {
  400: { error: 'Bad Request', code: 'repo_not_covered' },
  409: { error: 'Conflict', code: 'github_app_not_configured' },
  429: { error: 'Too Many Requests', code: 'github_rate_limited' },
  502: { error: 'Bad Gateway', code: 'github_unavailable' }
} as const

function upstreamError(status: keyof typeof UPSTREAM_ERRORS, message: string) {
  return { ...UPSTREAM_ERRORS[status], statusCode: status, message }
}

function projectRefusal(verdict: Extract<ProjectVerdict, { ok: false }>) {
  const { status, message } = PROJECT_REFUSALS[verdict.code]
  const error = { 400: 'Bad Request', 409: 'Conflict', 429: 'Too Many Requests', 502: 'Bad Gateway' }[status]
  return { statusCode: status, error, message, code: verdict.code }
}

export function kanbanRoutes(deps: HttpDeps) {
  return async function kanbanRoutesPlugin(app: FastifyInstance): Promise<void> {
    ownerGateByDefault(app)
    const r = app.withTypeProvider<ZodTypeProvider>()
    const resolver =
      deps.kanbanRepoResolver ??
      githubKanbanRepoResolver({ installations: deps.repos.githubInstallation, github: deps.github })

    const projectVerifier =
      deps.kanbanProjectVerifier ??
      (deps.github ? githubKanbanProjectVerifier({ tokens: deps.github.tokens }) : undefined)

    // Org-only guard for a Status projection: null means accepted; a refusal body is already shaped for the client.
    const checkProject = async (
      req: FastifyRequest,
      resolved: Extract<KanbanRepoResolution, { ok: true }>,
      projectNodeId: string,
      statusFieldId: string
    ) => {
      if (!projectVerifier) return projectRefusal({ ok: false, code: 'github_app_not_configured' })
      const verdict = await projectVerifier.verify({
        installationId: resolved.installationId,
        repoId: resolved.repoId,
        repoFullName: resolved.repoFullName,
        ownerType: resolved.ownerType,
        projectNodeId,
        statusFieldId
      })
      if (verdict.ok) return null
      if (verdict.reason) req.log.info({ reason: verdict.reason }, 'kanban project guard')
      return projectRefusal(verdict)
    }

    // Visible boards only: a restricted board outside the caller's audience is indistinguishable from a missing one.
    const visibleBoard = async (req: FastifyRequest, boardId: string) => {
      const board = await deps.repos.kanbanBoards.getForOrg(orgOf(req), boardId)
      return board && canView(board, ctxOf(req)) ? board : null
    }

    r.get(
      '/kanban/boards',
      {
        config: { kanbanAccess: 'viewer' },
        schema: {
          tags: [Tag.Kanban],
          summary: 'List Kanban boards',
          description:
            'Boards of this organization the caller may see: every org-visible board, plus restricted boards shared with the caller (owners see all). Body-free configuration only; card titles and bodies stay on GitHub.',
          operationId: 'listKanbanBoards',
          response: { 200: KanbanBoardListDto, 401: ErrorDto, 403: ErrorDto }
        }
      },
      async (req) => {
        const ctx = ctxOf(req)
        const boards = await deps.repos.kanbanBoards.listForOrg(orgOf(req))
        return { boards: boards.filter((b) => canView(b, ctx)).map((b) => boardDto(b, req)) }
      }
    )

    r.get(
      '/kanban/boards/:boardId',
      {
        config: { kanbanAccess: 'viewer' },
        schema: {
          tags: [Tag.Kanban],
          summary: 'Get a Kanban board',
          description:
            'One board’s configuration. A board in another organization, or a restricted board not shared with the caller, reads as 404.',
          operationId: 'getKanbanBoard',
          params: KanbanBoardParams,
          response: { 200: KanbanBoardDto, 401: ErrorDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const board = await visibleBoard(req, req.params.boardId)
        if (!board) return reply.code(404).send({ ...notFound, message: 'board not found' })
        return boardDto(board, req)
      }
    )

    r.post(
      '/kanban/boards',
      {
        schema: {
          tags: [Tag.Kanban],
          summary: 'Create a Kanban board',
          description:
            'Owner-only, interactive sign-in only. Binds one GitHub repository (`owner/repo`) to a board. The control plane resolves the numeric repository id live through a non-suspended, non-revoked GitHub App installation of this organization that covers the repository; the id is never taken from the request. One board per repository per organization. Boards start in read run mode; change it with `setKanbanBoardMode`.',
          operationId: 'createKanbanBoard',
          body: CreateKanbanBoardBody,
          response: {
            201: KanbanBoardDto,
            400: ErrorDto,
            404: ErrorDto,
            401: ErrorDto,
            403: ErrorDto,
            409: ErrorDto,
            429: ErrorDto,
            502: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const { orgId, userId } = req.orgCtx!
        const resolved = await resolver.resolve(orgId, req.body.repoFullName)
        if (!resolved.ok) {
          return reply.code(resolved.status).send(upstreamError(resolved.status, resolved.message))
        }
        if (req.body.projectNodeId !== undefined && req.body.statusFieldId !== undefined) {
          const refused = await checkProject(req, resolved, req.body.projectNodeId, req.body.statusFieldId)
          if (refused) return reply.code(refused.statusCode).send(refused)
        }
        const sharedWith = await resolveShareSet(deps.repos.user, orgId, req.body.sharedWith)
        const result = await deps.repos.kanbanBoards.createBoard(orgId, userId, {
          ...req.body,
          sharedWith,
          repoId: resolved.repoId,
          repoFullName: resolved.repoFullName
        })
        if (!result.ok) return reply.code(REFUSALS[result.reason].statusCode).send(REFUSALS[result.reason])
        return reply.code(201).send(boardDto(result.value, req))
      }
    )

    r.patch(
      '/kanban/boards/:boardId',
      {
        schema: {
          tags: [Tag.Kanban],
          summary: 'Update a Kanban board',
          description:
            'Owner-only, interactive sign-in only. Changes board configuration and bumps its config revision. The repository is resolved again through a live installation of this organization. Caps and limits apply from the next claim; active leases are not changed.',
          operationId: 'updateKanbanBoard',
          params: KanbanBoardParams,
          body: UpdateKanbanBoardBody,
          response: {
            200: KanbanBoardDto,
            400: ErrorDto,
            401: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            429: ErrorDto,
            502: ErrorDto
          }
        }
      },
      async (req, reply) => {
        const { orgId, userId } = req.orgCtx!
        const current = await deps.repos.kanbanBoards.getForOrg(orgId, req.params.boardId)
        if (!current) return reply.code(404).send({ ...notFound, message: 'board not found' })
        const { repoFullName, sharedWith, ...rest } = req.body
        // Re-enabling re-proves coverage too, so an uninstalled or suspended App cannot be revived by a toggle.
        const recheck = repoFullName ?? current.repoFullName
        let repo: { repoId: bigint; repoFullName: string } | undefined
        let resolvedRepo: Extract<KanbanRepoResolution, { ok: true }> | undefined
        if (recheck !== undefined) {
          const resolved = await resolver.resolve(orgId, recheck)
          if (!resolved.ok) {
            return reply.code(resolved.status).send(upstreamError(resolved.status, resolved.message))
          }
          if (repoFullName === undefined && resolved.repoId !== current.repoId) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'the repository behind this board changed; set repoFullName explicitly',
              code: 'repo_changed'
            })
          }
          repo = { repoId: resolved.repoId, repoFullName: resolved.repoFullName }
          resolvedRepo = resolved
        }
        // A new project pair, or a repository change under an existing pair, re-proves the org-only guard.
        const finalProject =
          rest.projectNodeId !== undefined
            ? { projectNodeId: rest.projectNodeId, statusFieldId: rest.statusFieldId ?? null }
            : { projectNodeId: current.projectNodeId, statusFieldId: current.statusFieldId }
        const projectTouched = rest.projectNodeId !== undefined || (repoFullName !== undefined && repo !== undefined)
        if (projectTouched && resolvedRepo && finalProject.projectNodeId && finalProject.statusFieldId) {
          const refused = await checkProject(req, resolvedRepo, finalProject.projectNodeId, finalProject.statusFieldId)
          if (refused) return reply.code(refused.statusCode).send(refused)
        }
        const result = await deps.repos.kanbanBoards.updateBoard(orgId, req.params.boardId, userId, {
          ...rest,
          ...(sharedWith !== undefined
            ? { sharedWith: await resolveShareSet(deps.repos.user, orgId, sharedWith) }
            : {}),
          ...(repo ?? {})
        })
        if (!result.ok) return reply.code(REFUSALS[result.reason].statusCode).send(REFUSALS[result.reason])
        return boardDto(result.value, req)
      }
    )

    r.delete(
      '/kanban/boards/:boardId',
      {
        schema: {
          tags: [Tag.Kanban],
          summary: 'Delete a Kanban board',
          description:
            'Owner-only, interactive sign-in only. Deletes the board and its card metadata; GitHub issues and labels are left untouched. Refused with 409 while any card holds an open lease: disable the board first and let its runs end.',
          operationId: 'deleteKanbanBoard',
          params: KanbanBoardParams,
          response: { 204: z.null(), 401: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        const { orgId, userId } = req.orgCtx!
        const result = await deps.repos.kanbanBoards.deleteBoard(orgId, req.params.boardId, userId)
        if (!result.ok) return reply.code(REFUSALS[result.reason].statusCode as 404 | 409).send(REFUSALS[result.reason])
        return reply.code(204).send(null)
      }
    )

    r.put(
      '/kanban/boards/:boardId/mode',
      {
        schema: {
          tags: [Tag.Kanban],
          summary: 'Set a board’s default run mode',
          description:
            'Owner-only, interactive sign-in only (API keys, OAuth tokens, and agent or daemon credentials are refused). Sets the run mode every card on the board inherits unless it carries its own override. Applies from the next claim; an active lease keeps the mode it was dispatched with.',
          operationId: 'setKanbanBoardMode',
          params: KanbanBoardParams,
          body: SetKanbanBoardModeBody,
          response: { 200: KanbanBoardModeDto, 401: ErrorDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const { orgId, userId } = req.orgCtx!
        if (!(await deps.repos.kanbanMode.setDefaultMode(orgId, req.params.boardId, userId, req.body.mode))) {
          return reply.code(404).send({ ...notFound, message: 'board not found' })
        }
        return { boardId: req.params.boardId, defaultMode: req.body.mode }
      }
    )

    r.put(
      '/kanban/boards/:boardId/cards/:cardId/mode',
      {
        schema: {
          tags: [Tag.Kanban],
          summary: 'Set or clear a card’s run-mode override',
          description:
            'Owner-only, interactive sign-in only (API keys, OAuth tokens, and agent or daemon credentials are refused). Overrides the board default for one card; `null` clears the override so the card inherits the board default. Applies from the next claim.',
          operationId: 'setKanbanCardMode',
          params: KanbanCardParams,
          body: SetKanbanCardModeBody,
          response: { 200: KanbanCardModeDto, 401: ErrorDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const { orgId, userId } = req.orgCtx!
        const { boardId, cardId } = req.params
        if (!(await deps.repos.kanbanMode.setCardMode(orgId, boardId, cardId, userId, req.body.mode))) {
          return reply.code(404).send({ ...notFound, message: 'card not found' })
        }
        return { boardId, cardId, mode: req.body.mode }
      }
    )
  }
}
