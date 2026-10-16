// Kanban run mode (issue #2): write lets agents push, so only an interactive OIDC owner session may set it.
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { denyNonInteractive, denyNonOwner } from '../rbac.js'
import { Tag } from '../plugins/openapi.js'
import {
  ErrorDto,
  KanbanBoardModeDto,
  KanbanBoardParams,
  KanbanCardModeDto,
  KanbanCardParams,
  SetKanbanBoardModeBody,
  SetKanbanCardModeBody
} from '../dto/index.js'

const notFound = { error: 'Not Found', statusCode: 404 } as const

export function kanbanRoutes(deps: HttpDeps) {
  return async function kanbanRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    // Encapsulated to this plugin: credentials an agent could hold never reach the handlers below.
    app.addHook('preValidation', async (req, reply) => {
      if (denyNonInteractive(req, reply)) return reply
      if (denyNonOwner(req, reply)) return reply
    })

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
