'use client'

// One Kanban card: CP metadata, the live title (plain text only), a "why isn't this running?" disclosure, and owner mode controls.

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { ApiError } from '@/lib/api'
import {
  explainKanbanCard,
  setKanbanCardMode,
  type KanbanCardMetaDto,
  type KanbanLiveTitle,
  type KanbanRunMode
} from '@/lib/kanban-api'
import { consoleKeys } from '@/lib/swr-keys'
import { useOrgs } from '@/lib/org-context'
import { Button } from '@/components/ui'
import { ConfirmStrip } from '@/components/console/ConfirmStrip'
import { ageSince, issueUrl } from './helpers'

type KanbanT = ReturnType<typeof useTranslations<'Kanban'>>

/** A write that failed, in words: the interactive-sign-in refusal gets its own sentence, anything else the CP's message. */
export function modeErrorMessage(err: unknown, t: KanbanT): string {
  if (err instanceof ApiError && err.code === 'INTERACTIVE_AUTH_REQUIRED') return t('interactiveRequired')
  return err instanceof Error && err.message ? err.message : t('modeFailed')
}

function Age({ iso, label }: { iso: string; label: string }) {
  const t = useTranslations('Kanban')
  const age = ageSince(iso, Date.now())
  return (
    <span>
      {label} {t(`age.${age.unit}`, { count: age.count })}
    </span>
  )
}

function Explain({ boardId, cardId }: { boardId: string; cardId: string }) {
  const t = useTranslations('Kanban')
  const { activeOrg } = useOrgs()
  const { data, error, isLoading } = useSWR(consoleKeys.kanbanCardExplain(activeOrg?.id, boardId, cardId), () =>
    explainKanbanCard(boardId, cardId)
  )
  return (
    <div
      data-testid="kanban-explain"
      className="mt-2 rounded-md bg-(--surface-sunken) px-3 py-2 font-sans text-[12px] font-normal leading-normal text-(--text-secondary)"
    >
      {isLoading && <span>{t('explainLoading')}</span>}
      {error && <span role="alert">{t('explainFailed')}</span>}
      {data &&
        (data.verdict.eligible ? (
          <span>{t('explainEligible')}</span>
        ) : (
          <>
            <span className="mono text-[11px] text-(--text-primary)">{data.verdict.gate}</span>
            {/* The hint is the CP's static English sentence for the gate, never issue text. */}
            <span className="ml-2">{data.hint}</span>
          </>
        ))}
    </div>
  )
}

export function KanbanCardTile({
  boardId,
  repoFullName,
  boardDefaultMode,
  canEdit,
  card,
  title,
  onChanged
}: {
  boardId: string
  repoFullName: string
  boardDefaultMode: KanbanRunMode
  canEdit: boolean
  card: KanbanCardMetaDto
  title: KanbanLiveTitle | undefined
  onChanged: () => void
}) {
  const t = useTranslations('Kanban')
  const [explainOpen, setExplainOpen] = useState(false)
  const [pendingWrite, setPendingWrite] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const assignee = card.assignee ? (card.assignee.displayName ?? card.assignee.name) : null

  const applyMode = async (mode: KanbanRunMode | null) => {
    setBusy(true)
    setError(null)
    try {
      await setKanbanCardMode(boardId, card.id, mode)
      setPendingWrite(false)
      onChanged()
    } catch (err) {
      setError(modeErrorMessage(err, t))
    } finally {
      setBusy(false)
    }
  }

  const onSelect = (value: string) => {
    if (value === 'write') {
      setError(null)
      setPendingWrite(true)
    } else {
      setPendingWrite(false)
      void applyMode(value === 'read' ? 'read' : null)
    }
  }

  const failures = [
    card.consecutiveFailures > 0 && t('failures', { count: card.consecutiveFailures }),
    card.protocolViolations > 0 && t('violations', { count: card.protocolViolations }),
    card.blockRecurrence > 0 && t('recurrence', { count: card.blockRecurrence })
  ].filter(Boolean)

  return (
    <div data-testid={`kanban-card-${card.issueNumber}`} className="card flex flex-col gap-1.5 p-3">
      <div className="flex min-w-0 items-baseline gap-2">
        <a
          href={issueUrl(repoFullName, card.issueNumber)}
          target="_blank"
          rel="noreferrer noopener"
          className="mono flex-none text-[12px] text-(--text-secondary)"
        >
          #{card.issueNumber}
        </a>
        {/* Untrusted external text: a text node only, clipped by CSS. */}
        {title && (
          <span
            data-testid="kanban-title"
            className="min-w-0 truncate font-sans text-[13px] font-semibold leading-normal text-(--text-primary)"
          >
            {title.title}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="badge bg-(--surface-sunken) text-[9.5px] text-(--text-secondary)">
          {card.mode === 'write' ? t('modeWrite') : t('modeRead')}
        </span>
        {card.needsAttention && (
          <span className="badge bg-(--status-error-soft) text-[9.5px] font-semibold text-(--status-error)">
            {t('needsAttention')}
            {(card.blockKind ?? card.attentionReason) && `: ${card.blockKind ?? card.attentionReason}`}
          </span>
        )}
        {!card.needsAttention && card.blockKind && (
          <span className="badge bg-(--surface-sunken) text-[9.5px] text-(--text-secondary)">{card.blockKind}</span>
        )}
        {assignee && (
          <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">{assignee}</span>
        )}
      </div>
      {failures.length > 0 && (
        <div className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
          {failures.join(' · ')}
        </div>
      )}
      {card.status === 'running' && card.openRun && (
        <div className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
          {card.openRun.heartbeatAt ? (
            <Age iso={card.openRun.heartbeatAt} label={t('heartbeat')} />
          ) : (
            <Age iso={card.openRun.dispatchedAt} label={t('dispatched')} />
          )}
        </div>
      )}
      {card.status !== 'running' && (
        <div>
          <Button variant="secondary" size="xs" ariaExpanded={explainOpen} onClick={() => setExplainOpen((v) => !v)}>
            {t('whyNotRunning')}
          </Button>
          {explainOpen && <Explain boardId={boardId} cardId={card.id} />}
        </div>
      )}
      {canEdit && (
        <label className="flex items-center gap-2 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
          {t('cardMode')}
          <select
            aria-label={t('cardMode')}
            value={card.modeOverride ?? 'inherit'}
            disabled={busy}
            onChange={(e) => onSelect(e.target.value)}
            className="rounded-sm border border-(--border-subtle) bg-(--surface-card) px-1 py-0.5 text-[12px] text-(--text-primary)"
          >
            <option value="inherit">{t('modeInherit', { mode: boardDefaultMode })}</option>
            <option value="read">{t('modeRead')}</option>
            <option value="write">{t('modeWrite')}</option>
          </select>
        </label>
      )}
      {pendingWrite && (
        <ConfirmStrip
          prompt={t('confirmCardWrite')}
          confirm={t('confirmWrite')}
          keep={t('cancel')}
          busy={busy}
          onConfirm={() => void applyMode('write')}
          onKeep={() => setPendingWrite(false)}
        />
      )}
      {error && (
        <div role="alert" className="font-sans text-[12px] font-normal leading-normal text-(--status-error)">
          {error}
        </div>
      )}
    </div>
  )
}
