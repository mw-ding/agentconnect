// Pure helpers for the Kanban board view: grouping, the titles request key, and age math.
import { KANBAN_STATUSES, type KanbanCardMetaDto, type KanbanStatus } from '@/lib/kanban-api'

/** Done and archived hold the board's history, so they start collapsed. */
export const COLLAPSED_BY_DEFAULT: ReadonlySet<KanbanStatus> = new Set(['done', 'archived'])

export function groupByStatus(cards: readonly KanbanCardMetaDto[]): Record<KanbanStatus, KanbanCardMetaDto[]> {
  const groups = Object.fromEntries(KANBAN_STATUSES.map((s) => [s, [] as KanbanCardMetaDto[]])) as Record<
    KanbanStatus,
    KanbanCardMetaDto[]
  >
  for (const card of cards) groups[card.status].push(card)
  return groups
}

/** Sorted, comma-joined issue numbers: the stable SWR key for one set of live titles. */
export function titlesKey(cards: readonly Pick<KanbanCardMetaDto, 'issueNumber'>[]): string {
  return cards
    .map((c) => c.issueNumber)
    .sort((a, b) => a - b)
    .join(',')
}

export function parseTitlesKey(key: string): number[] {
  return key === '' ? [] : key.split(',').map(Number)
}

export type AgeUnit = 'seconds' | 'minutes' | 'hours' | 'days'

/** Whole units since `iso`, never negative (clock skew shows as zero). */
export function ageSince(iso: string, nowMs: number): { unit: AgeUnit; count: number } {
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000))
  if (seconds < 60) return { unit: 'seconds', count: seconds }
  if (seconds < 3600) return { unit: 'minutes', count: Math.floor(seconds / 60) }
  if (seconds < 86_400) return { unit: 'hours', count: Math.floor(seconds / 3600) }
  return { unit: 'days', count: Math.floor(seconds / 86_400) }
}

/** The GitHub issue page for a card, built from the board's repository, never from a server-supplied URL. */
export function issueUrl(repoFullName: string, issueNumber: number): string {
  return `https://github.com/${repoFullName}/issues/${issueNumber}`
}
