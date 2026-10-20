'use client'

// Kanban boards (`/kanban`): the boards this member may see; each opens its column view.

import Link from 'next/link'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { listKanbanBoards } from '@/lib/kanban-api'
import { consoleKeys } from '@/lib/swr-keys'
import { useOrgs } from '@/lib/org-context'
import { LoadingState } from '@/components/marks'
import { Icon } from '@/components/ui'

export default function KanbanBoardsView() {
  const t = useTranslations('Kanban')
  const { activeOrg, orgPath } = useOrgs()
  const { data, error } = useSWR(consoleKeys.kanbanBoards(activeOrg?.id), listKanbanBoards)

  if (error) return <div role="alert">{t('loadFailed')}</div>
  if (!data) return <LoadingState />
  if (data.length === 0) {
    return (
      <div className="card flex flex-col items-center gap-3 px-6 py-[44px] text-center">
        <Icon name="square-kanban" size={22} color="var(--text-tertiary)" />
        <div className="font-sans text-[15px] font-semibold leading-normal">{t('noBoards')}</div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {data.map((board) => (
        <Link
          key={board.id}
          href={orgPath(`/kanban/${board.id}`)}
          className="row click flex flex-wrap items-center gap-3"
        >
          <span className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">{board.name}</span>
          <span className="mono text-[12px] text-(--text-tertiary)">{board.repoFullName}</span>
          <span className="badge bg-(--surface-sunken) text-[9.5px] text-(--text-secondary)">
            {board.enabled ? t('enabled') : t('paused')}
          </span>
          <span className="badge bg-(--surface-sunken) text-[9.5px] text-(--text-secondary)">
            {t('defaultMode', { mode: board.defaultMode })}
          </span>
        </Link>
      ))}
    </div>
  )
}
