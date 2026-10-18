// Kanban boards and run mode (issue #2): members read what they may see; only an interactive OIDC owner session configures.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { ctxOf, denyNonInteractive, denyNonOwner, orgOf } from '../rbac.js'
import { Tag } from '../plugins/openapi.js'
import { canView } from '../../authorization/policy.js'
import { githubKanbanRepoResolver } from '../../kanban/repo-resolver.js'
import { KanbanTitleError } from '../../kanban/card-titles.js'
import { capDeferralHint, claimFactsOf, gateHint } from '../../kanban/claim-explain.js'
import type {
  KanbanBoardCardRow,
  KanbanBoardView,
  KanbanBoardWriteRefusal,
  KanbanCardExplanation
} from '../../persistence/ports.js'
import { resolveShareSet } from '../sharing.js'
import {
  CreateKanbanBoardBody,
  ErrorDto,
  KanbanBoardCardsDto,
  KanbanBoardDto,
  KanbanBoardExplainDto,
  KanbanBoardListDto,
  type KanbanBoardDtoT,
  KanbanBoardModeDto,
  KanbanBoardParams,
  KanbanCardExplainDto,
  KanbanCardModeDto,
  KanbanCardParams,
  KanbanTitlesDto,
  KanbanTitlesQuery,
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

/** The dry-run entry as the wire carries it: the verdict, a static-table hint, and body-free facts only. */
function explainDto(boardId: string, entry: KanbanCardExplanation, evaluatedAt: string) {
  const facts = claimFactsOf(entry.input)
  const hint = !entry.verdict.eligible
    ? gateHint(entry.verdict.gate, facts)
    : entry.capBound
      ? capDeferralHint(entry.capBound, facts)
      : `eligible: the next claim dispatches it to agent ${entry.verdict.agentId}`
  return {
    boardId,
    cardId: entry.cardId,
    issueNumber: entry.issueNumber,
    status: entry.input.card.status,
    verdict: entry.verdict,
    hint,
    facts,
    ...(entry.claimOrder !== undefined ? { claimOrder: entry.claimOrder } : {}),
    ...(entry.capBound ? { capBound: entry.capBound } : {}),
    evaluatedAt
  }
}

/** Cards listed per board view; `total` and `truncated` say when a board holds more. */
const BOARD_CARDS_CAP = 500
/** Issue numbers one titles request may name. */
const TITLES_MAX_NUMBERS = 100

const TITLE_ERRORS = {
  github_app_not_configured: { statusCode: 409, error: 'Conflict' },
  github_rate_limited: { statusCode: 429, error: 'Too Many Requests' },
  github_unavailable: { statusCode: 502, error: 'Bad Gateway' }
} as const

function cardMetaDto(card: KanbanBoardCardRow, boardDefaultMode: 'read' | 'write') {
  return {
    id: card.id,
    issueNumber: card.issueNumber,
    status: card.status,
    assigneeAgentId: card.assigneeAgentId,
    assignee: card.assigneeName === null ? null : { name: card.assigneeName, displayName: card.assigneeDisplayName },
    priority: card.priority,
    mode: card.mode ?? boardDefaultMode,
    modeOverride: card.mode,
    needsAttention: card.needsAttention,
    attentionReason: card.attentionReason,
    blockKind: card.blockKind,
    consecutiveFailures: card.consecutiveFailures,
    protocolViolations: card.protocolViolations,
    blockRecurrence: card.blockRecurrence,
    cooldownUntil: card.cooldownUntil?.toISOString() ?? null,
    notBefore: card.notBefore?.toISOString() ?? null,
    promotionPending: card.promotionPending,
    linkedPrNumber: card.linkedPrNumber,
    stateRevision: card.stateRevision.toString(),
    openRun: card.openRun
      ? {
          attempt: card.openRun.attempt,
          agentId: card.openRun.agentId,
          dispatchedAt: card.openRun.dispatchedAt.toISOString(),
          ackedAt: card.openRun.ackedAt?.toISOString() ?? null,
          heartbeatAt: card.openRun.heartbeatAt?.toISOString() ?? null
        }
      : null
  }
}

/** `1,2,3` → unique positive issue numbers; null when any item is not one. */
function parseIssueNumbers(raw: string): number[] | null {
  const numbers: number[] = []
  for (const part of raw.split(',')) {
    if (!/^[1-9][0-9]{0,9}$/.test(part)) return null
    const n = Number(part)
    if (n > 2_147_483_647) return null
    if (!numbers.includes(n)) numbers.push(n)
  }
  return numbers
}

export function kanbanRoutes(deps: HttpDeps) {
  return async function kanbanRoutesPlugin(app: FastifyInstance): Promise<void> {
    ownerGateByDefault(app)
    const r = app.withTypeProvider<ZodTypeProvider>()
    const resolver =
      deps.kanbanRepoResolver ??
      githubKanbanRepoResolver({ installations: deps.repos.githubInstallation, github: deps.github })

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

    // The dry run reads the SAME liveness the dispatcher gives the claim, and writes, locks, audits and calls GitHub never.
    const explainOpts = async () => ({
      now: await deps.repos.kanbanDispatch.now(),
      isDaemonLive: (daemonId: string) => deps.daemonConns.get(daemonId)?.state === 'READY'
    })

    r.get(
      '/kanban/boards/:boardId/explain',
      {
        config: { kanbanAccess: 'viewer' },
        schema: {
          tags: [Tag.Kanban],
          summary: 'Explain why a board’s cards are or are not dispatched',
          description:
            'Read-only dry run of the claim for every card that is not done or archived, plus `wouldClaimNext`: the ids the next claim would take, in order, with the board and per-agent caps applied cumulatively. Has no side effects: no row changes, no audit rows, no GitHub calls, no dispatcher wake-up. Body-free: ids, statuses, gate codes, counts and timestamps. A board in another organization, or a restricted board not shared with the caller, reads as 404.',
          operationId: 'explainKanbanBoard',
          params: KanbanBoardParams,
          response: { 200: KanbanBoardExplainDto, 401: ErrorDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const board = await visibleBoard(req, req.params.boardId)
        if (!board) return reply.code(404).send({ ...notFound, message: 'board not found' })
        const explanation = await deps.repos.kanbanDispatch.explainBoard(board.id, await explainOpts())
        if (!explanation) return reply.code(404).send({ ...notFound, message: 'board not found' })
        const evaluatedAt = explanation.now.toISOString()
        const cards = explanation.cards.map((c) => explainDto(board.id, c, evaluatedAt))
        const numberOf = new Map(cards.map((c) => [c.cardId, c.issueNumber]))
        return {
          boardId: board.id,
          evaluatedAt,
          cards,
          wouldClaimNext: explanation.wouldClaimNext,
          wouldClaimNextIssueNumbers: explanation.wouldClaimNext.map((id) => numberOf.get(id)!)
        }
      }
    )

    r.get(
      '/kanban/boards/:boardId/cards/:cardId/explain',
      {
        config: { kanbanAccess: 'viewer' },
        schema: {
          tags: [Tag.Kanban],
          summary: 'Explain why a card is or is not dispatched',
          description:
            'Read-only dry run of the claim for one card (any status): the verdict, the first blocking gate with a human hint, and body-free facts. Has no side effects. A card not on the board, a board in another organization, or a restricted board not shared with the caller reads as 404.',
          operationId: 'explainKanbanCard',
          params: KanbanCardParams,
          response: { 200: KanbanCardExplainDto, 401: ErrorDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const board = await visibleBoard(req, req.params.boardId)
        if (!board) return reply.code(404).send({ ...notFound, message: 'board not found' })
        const opts = await explainOpts()
        const entry = await deps.repos.kanbanDispatch.explainCard(board.id, req.params.cardId, opts)
        if (!entry) return reply.code(404).send({ ...notFound, message: 'card not found' })
        return explainDto(board.id, entry, opts.now.toISOString())
      }
    )

    r.get(
      '/kanban/boards/:boardId/cards',
      {
        config: { kanbanAccess: 'viewer' },
        schema: {
          tags: [Tag.Kanban],
          summary: 'List a board’s cards',
          description:
            'CP metadata for the cards of one board, for the console board view: status, assignee, effective run mode, attention and failure counters, cooldowns and the open run. Body-free: issue titles are NOT included and are never stored; read them live with `getKanbanCardTitles`. Returns at most 500 cards (priority, then age); `total` and `truncated` say when there are more. A board in another organization, or a restricted board not shared with the caller, reads as 404.',
          operationId: 'listKanbanCards',
          params: KanbanBoardParams,
          response: { 200: KanbanBoardCardsDto, 401: ErrorDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const board = await visibleBoard(req, req.params.boardId)
        if (!board) return reply.code(404).send({ ...notFound, message: 'board not found' })
        const { cards, total } = await deps.repos.kanbanDispatch.listBoardCards(board.id, BOARD_CARDS_CAP)
        return {
          boardId: board.id,
          cards: cards.map((c) => cardMetaDto(c, board.defaultMode)),
          total,
          truncated: total > cards.length
        }
      }
    )

    r.get(
      '/kanban/boards/:boardId/cards/titles',
      {
        config: { kanbanAccess: 'viewer' },
        schema: {
          tags: [Tag.Kanban],
          summary: 'Read live issue titles for cards',
          description:
            'Reads the titles and open/closed state of up to 100 cards from GitHub live, with the read-scoped Kanban card token for this board’s repository, and returns them with `Cache-Control: no-store`. Titles are UNTRUSTED external text: render as plain text. They are never written to the database, never logged and never cached. Numbers that are not cards of this board, or that GitHub no longer serves as an issue, come back in `missing`. GitHub failures answer 409 `github_app_not_configured`, 429 `github_rate_limited` or 502 `github_unavailable` without affecting the cards route.',
          operationId: 'getKanbanCardTitles',
          params: KanbanBoardParams,
          querystring: KanbanTitlesQuery,
          response: {
            200: KanbanTitlesDto,
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
        void reply.header('cache-control', 'no-store')
        const board = await visibleBoard(req, req.params.boardId)
        if (!board) return reply.code(404).send({ ...notFound, message: 'board not found' })
        const requested = parseIssueNumbers(req.query.numbers)
        if (!requested) {
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            code: 'invalid_numbers',
            message: 'numbers must be comma-separated positive issue numbers'
          })
        }
        if (requested.length > TITLES_MAX_NUMBERS) {
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            code: 'too_many_numbers',
            message: `at most ${TITLES_MAX_NUMBERS} numbers per request`
          })
        }
        const onBoard = new Set(await deps.repos.kanbanDispatch.cardNumbersOnBoard(board.id, requested))
        const cardNumbers = requested.filter((n) => onBoard.has(n))
        const notCards = requested.filter((n) => !onBoard.has(n))
        if (cardNumbers.length === 0) return { titles: {}, missing: notCards.sort((a, b) => a - b) }
        try {
          if (!deps.kanbanTitles) throw new KanbanTitleError('github_app_not_configured')
          const live = await deps.kanbanTitles.read(
            { orgId: board.orgId, repoId: board.repoId, repoFullName: board.repoFullName },
            cardNumbers
          )
          return {
            titles: Object.fromEntries(live.titles),
            missing: [...live.missing, ...notCards].sort((a, b) => a - b)
          }
        } catch (err) {
          if (!(err instanceof KanbanTitleError)) throw err
          const mapped = TITLE_ERRORS[err.code]
          return reply.code(mapped.statusCode).send({
            ...mapped,
            code: err.code,
            message:
              err.code === 'github_app_not_configured'
                ? 'GitHub is not configured for this board'
                : 'GitHub could not be read'
          })
        }
      }
    )
  }
}
