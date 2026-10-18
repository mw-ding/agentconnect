'use client'

// Kanban board (`/kanban/[boardId]`): CP metadata grouped into status columns, live titles merged in from GitHub.
// Titles are untrusted text fetched once per visible card set, never polled; the CP never stores them. Owners also set run modes here.

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import {
  getKanbanBoard,
  getKanbanCardTitles,
  KANBAN_STATUSES,
  listKanbanCards,
  setKanbanBoardMode,
  type KanbanRunMode,
  type KanbanStatus
} from '@/lib/kanban-api'
import { consoleKeys } from '@/lib/swr-keys'
import { useOrgs } from '@/lib/org-context'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { ConfirmStrip } from '@/components/console/ConfirmStrip'
import { KanbanCardTile, modeErrorMessage } from '@/components/console/kanban/KanbanCardTile'
import { COLLAPSED_BY_DEFAULT, groupByStatus, parseTitlesKey, titlesKey } from '@/components/console/kanban/helpers'

/** The board and its cards refresh on this cadence so a dispatch shows up without a reload. */
const REFRESH_MS = 15_000

export default function KanbanBoardView() {
  const t = useTranslations('Kanban')
  const { boardId } = useParams<{ boardId: string }>()
  const { activeOrg, orgPath } = useOrgs()
  const orgId = activeOrg?.id
  const board = useSWR(consoleKeys.kanbanBoard(orgId, boardId), () => getKanbanBoard(boardId))
  const cards = useSWR(consoleKeys.kanbanCards(orgId, boardId), () => listKanbanCards(boardId), {
    refreshInterval: REFRESH_MS
  })
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<KanbanStatus>>(new Set())
  const [pendingWrite, setPendingWrite] = useState(false)
  const [busy, setBusy] = useState(false)
  const [modeError, setModeError] = useState<string | null>(null)

  const all = cards.data?.cards
  // Titles load once per visible set and never poll: requesting only rendered, non-terminal cards keeps one open tab
  // from draining the installation rate limit that dispatch shares. Done and archived are never requested, collapsed
  // columns are skipped until shown, and the attention filter narrows the set further.
  const titleCards = useMemo(() => {
    const listed = attentionOnly ? (all ?? []).filter((c) => c.needsAttention) : (all ?? [])
    return listed.filter(
      (c) =>
        c.status !== 'done' &&
        c.status !== 'archived' &&
        !(COLLAPSED_BY_DEFAULT.has(c.status) && !expanded.has(c.status))
    )
  }, [all, attentionOnly, expanded])
  const numbers = useMemo(() => titlesKey(titleCards), [titleCards])
  // Titles load after the metadata and fail on their own: a GitHub outage leaves every card as `#n`.
  const titles = useSWR(
    numbers !== '' ? consoleKeys.kanbanTitles(orgId, boardId, numbers) : null,
    () => getKanbanCardTitles(boardId, parseTitlesKey(numbers)),
    { revalidateOnFocus: false }
  )

  if (board.error || cards.error) {
    const status = (board.error as { status?: number } | undefined)?.status
    return <div role="alert">{status === 404 ? t('boardNotFound') : t('loadFailed')}</div>
  }
  if (!board.data || !cards.data) return <LoadingState />

  const b = board.data
  const visible = attentionOnly ? cards.data.cards.filter((c) => c.needsAttention) : cards.data.cards
  const groups = groupByStatus(visible)
  const refresh = () => {
    void board.mutate()
    void cards.mutate()
  }

  const applyBoardMode = async (mode: KanbanRunMode) => {
    setBusy(true)
    setModeError(null)
    try {
      await setKanbanBoardMode(b.id, mode)
      setPendingWrite(false)
      refresh()
    } catch (err) {
      setModeError(modeErrorMessage(err, t))
    } finally {
      setBusy(false)
    }
  }

  const toggleExpanded = (status: KanbanStatus) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(status)) next.add(status)
      return next
    })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={orgPath('/kanban')} className="font-sans text-[12px] text-(--text-tertiary)">
          {t('allBoards')}
        </Link>
        <h1 className="font-sans text-[18px] font-semibold leading-normal">{b.name}</h1>
        <span className="mono text-[12px] text-(--text-tertiary)">{b.repoFullName}</span>
        <span className="badge bg-(--surface-sunken) text-[9.5px] text-(--text-secondary)">
          {b.enabled ? t('enabled') : t('paused')}
        </span>
        <span className="badge bg-(--surface-sunken) text-[9.5px] text-(--text-secondary)">
          {t('defaultMode', { mode: b.defaultMode })}
        </span>
        {b.canEdit && (
          <span role="group" aria-label={t('boardMode')} className="flex gap-1">
            <Button
              variant={b.defaultMode === 'read' ? 'primary' : 'secondary'}
              size="xs"
              disabled={busy || b.defaultMode === 'read'}
              onClick={() => void applyBoardMode('read')}
            >
              {t('modeRead')}
            </Button>
            <Button
              variant={b.defaultMode === 'write' ? 'primary' : 'secondary'}
              size="xs"
              disabled={busy || b.defaultMode === 'write'}
              onClick={() => setPendingWrite(true)}
            >
              {t('modeWrite')}
            </Button>
          </span>
        )}
        <Button
          variant={attentionOnly ? 'primary' : 'secondary'}
          size="xs"
          ariaExpanded={attentionOnly}
          onClick={() => setAttentionOnly((v) => !v)}
        >
          {t('filterAttention')}
        </Button>
      </div>
      {pendingWrite && (
        <ConfirmStrip
          prompt={t('confirmBoardWrite')}
          confirm={t('confirmWrite')}
          keep={t('cancel')}
          busy={busy}
          onConfirm={() => void applyBoardMode('write')}
          onKeep={() => setPendingWrite(false)}
        />
      )}
      {modeError && (
        <div role="alert" className="font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
          {modeError}
        </div>
      )}
      {titles.data?.failed && (
        <div
          role="status"
          className="flex items-center gap-2 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)"
        >
          <Icon name="triangle-alert" size={14} />
          {t('titlesUnavailable')}
        </div>
      )}
      {cards.data.truncated && (
        <div role="status" className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          {t('truncated', { shown: cards.data.cards.length, total: cards.data.total })}
        </div>
      )}
      <div className="flex flex-col gap-3 desktop:flex-row desktop:items-start desktop:overflow-x-auto">
        {KANBAN_STATUSES.map((status) => {
          const column = groups[status]
          const collapsed = COLLAPSED_BY_DEFAULT.has(status) && !expanded.has(status)
          return (
            <section
              key={status}
              aria-label={t(`columns.${status}`)}
              data-testid={`kanban-column-${status}`}
              className="flex min-w-0 flex-col gap-2 desktop:w-[260px] desktop:flex-none"
            >
              <div className="flex items-center gap-2">
                <h2 className="font-sans text-[12px] font-semibold uppercase leading-normal text-(--text-secondary)">
                  {t(`columns.${status}`)}
                </h2>
                <span className="mono text-[11px] text-(--text-tertiary)">{column.length}</span>
                {COLLAPSED_BY_DEFAULT.has(status) && (
                  <Button
                    variant="secondary"
                    size="xs"
                    ariaExpanded={!collapsed}
                    onClick={() => toggleExpanded(status)}
                  >
                    {collapsed ? t('show') : t('hide')}
                  </Button>
                )}
              </div>
              {!collapsed &&
                column.map((card) => (
                  <KanbanCardTile
                    key={card.id}
                    boardId={b.id}
                    repoFullName={b.repoFullName}
                    boardDefaultMode={b.defaultMode}
                    canEdit={b.canEdit}
                    card={card}
                    title={titles.data?.titles[String(card.issueNumber)]}
                    onChanged={refresh}
                  />
                ))}
            </section>
          )
        })}
      </div>
    </div>
  )
}
