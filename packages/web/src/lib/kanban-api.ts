// Kanban board client (issue #2 Lane 4b): types mirror the CP DTOs in control-plane/src/http/dto/index.ts.
// Card metadata comes from the CP; titles are a separate live GitHub read that the CP never stores.
import { ApiError, apiGet, apiPut, orgBase } from '@/lib/api'

export type KanbanRunMode = 'read' | 'write'
export type KanbanStatus = 'triage' | 'todo' | 'ready' | 'running' | 'blocked' | 'review' | 'done' | 'archived'
export const KANBAN_STATUSES: readonly KanbanStatus[] = [
  'triage',
  'todo',
  'ready',
  'running',
  'blocked',
  'review',
  'done',
  'archived'
]

export interface KanbanBoardDto {
  id: string
  name: string
  repoFullName: string
  defaultMode: KanbanRunMode
  enabled: boolean
  maxInProgress: number
  maxInProgressPerAgent: number
  /** Board configuration is owner-only, like run mode. */
  canEdit: boolean
}

export interface KanbanCardMetaDto {
  id: string
  issueNumber: number
  status: KanbanStatus
  assigneeAgentId: string | null
  assignee: { name: string; displayName: string | null } | null
  priority: number
  /** Effective run mode: the card's own override, else the board default. */
  mode: KanbanRunMode
  modeOverride: KanbanRunMode | null
  needsAttention: boolean
  attentionReason: string | null
  blockKind: 'dependency' | 'needs_input' | 'capability' | 'transient' | null
  consecutiveFailures: number
  protocolViolations: number
  blockRecurrence: number
  cooldownUntil: string | null
  notBefore: string | null
  promotionPending: boolean
  linkedPrNumber: number | null
  stateRevision: string
  openRun: {
    attempt: number
    agentId: string
    dispatchedAt: string
    ackedAt: string | null
    heartbeatAt: string | null
  } | null
}

export interface KanbanBoardCardsDto {
  boardId: string
  cards: KanbanCardMetaDto[]
  total: number
  truncated: boolean
}

/** UNTRUSTED external text from GitHub, read live and never stored: render as plain text only. */
export interface KanbanLiveTitle {
  title: string
  state: 'open' | 'closed'
  htmlUrl: string
}

export interface KanbanTitlesDto {
  titles: Record<string, KanbanLiveTitle>
  missing: number[]
}

export interface KanbanCardExplainDto {
  boardId: string
  cardId: string
  issueNumber: number
  status: string
  verdict: { eligible: boolean; role?: 'work' | 'verify'; agentId?: string; gate?: string }
  /** A sentence from the CP's static table keyed by the gate; no issue text. */
  hint: string
  evaluatedAt: string
}

/** The titles route takes at most this many numbers per request. */
export const KANBAN_TITLES_MAX = 100

const boardPath = (boardId: string) => `${orgBase()}/kanban/boards/${encodeURIComponent(boardId)}`

export async function listKanbanBoards(): Promise<KanbanBoardDto[]> {
  return (await apiGet<{ boards: KanbanBoardDto[] }>(`${orgBase()}/kanban/boards`)).boards
}

export function getKanbanBoard(boardId: string): Promise<KanbanBoardDto> {
  return apiGet<KanbanBoardDto>(boardPath(boardId))
}

export function listKanbanCards(boardId: string): Promise<KanbanBoardCardsDto> {
  return apiGet<KanbanBoardCardsDto>(`${boardPath(boardId)}/cards`)
}

export function explainKanbanCard(boardId: string, cardId: string): Promise<KanbanCardExplainDto> {
  return apiGet<KanbanCardExplainDto>(`${boardPath(boardId)}/cards/${encodeURIComponent(cardId)}/explain`)
}

/** Live titles for any number of cards, requested in chunks the CP accepts; a failed chunk leaves its cards untitled. */
export async function getKanbanCardTitles(
  boardId: string,
  numbers: readonly number[]
): Promise<{ titles: Record<string, KanbanLiveTitle>; failed: boolean }> {
  const chunks: number[][] = []
  for (let i = 0; i < numbers.length; i += KANBAN_TITLES_MAX) chunks.push(numbers.slice(i, i + KANBAN_TITLES_MAX))
  const settled = await Promise.allSettled(
    chunks.map((chunk) => apiGet<KanbanTitlesDto>(`${boardPath(boardId)}/cards/titles?numbers=${chunk.join(',')}`))
  )
  const titles: Record<string, KanbanLiveTitle> = {}
  let failed = false
  for (const result of settled) {
    if (result.status === 'fulfilled') Object.assign(titles, result.value.titles)
    else failed = true
  }
  return { titles, failed }
}

export function setKanbanBoardMode(
  boardId: string,
  mode: KanbanRunMode
): Promise<{ boardId: string; defaultMode: KanbanRunMode }> {
  return apiPut(`${boardPath(boardId)}/mode`, { mode })
}

/** `null` clears the card's override so it inherits the board default. */
export function setKanbanCardMode(
  boardId: string,
  cardId: string,
  mode: KanbanRunMode | null
): Promise<{ boardId: string; cardId: string; mode: KanbanRunMode | null }> {
  return apiPut(`${boardPath(boardId)}/cards/${encodeURIComponent(cardId)}/mode`, { mode })
}

/** The stable code a mode write failed with, so the UI can say "sign in interactively" instead of a bare 403. */
export function kanbanErrorCode(err: unknown): string | undefined {
  return err instanceof ApiError ? err.code : undefined
}
