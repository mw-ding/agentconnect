// Attributes a label to its latest VISIBLE labeled/unlabeled event; callers handle events-API lag (replay, deferral, doorbell sender).
import {
  checkWriteAccess,
  type RepoPermissionLevel,
  type RepoPermissionLookup,
  type RepoPermissionTarget
} from '../github/repo-permission.js'
import { isAppActor, isHumanActor, type LabelEvent } from './card-store.js'

/** The latest event matching `match`, tie-broken by id then created_at; events need not be pre-sorted. */
function latestEvent(events: readonly LabelEvent[], match: (event: LabelEvent) => boolean): LabelEvent | undefined {
  let found: LabelEvent | undefined
  for (const event of events) {
    if (!match(event)) continue
    if (
      !found ||
      event.id > found.id ||
      (event.id === found.id && (event.created_at ?? '') > (found.created_at ?? ''))
    ) {
      found = event
    }
  }
  return found
}

/** The latest visible labeled/unlabeled event for this exact label (case-insensitive name compare), or undefined. */
export function latestLabelEvent(events: readonly LabelEvent[], label: string): LabelEvent | undefined {
  return latestEvent(
    events,
    (event) =>
      (event.event === 'labeled' || event.event === 'unlabeled') &&
      event.label?.name?.toLowerCase() === label.toLowerCase()
  )
}

/** The latest visible `transferred` event, or undefined. */
export function latestTransferEvent(events: readonly LabelEvent[]): LabelEvent | undefined {
  return latestEvent(events, (event) => event.event === 'transferred')
}

/** The webhook sender of a Kanban `labeled`/`unlabeled` doorbell: a human login beside its numeric id. */
export interface DoorbellSender {
  login: string
  id: number
  type: string
}

/** Whether the latest visible event for `label` is the sender's add, i.e. the events API has caught up to a `labeled` doorbell. */
export function doorbellAddVisible(events: readonly LabelEvent[], label: string, sender: DoorbellSender): boolean {
  const latest = latestLabelEvent(events, label)
  if (latest?.event !== 'labeled') return false
  if (latest.actor?.id !== undefined) return latest.actor.id === sender.id
  return (latest.actor?.login ?? '').toLowerCase() === sender.login.toLowerCase()
}

/** How far a visible event must postdate a doorbell's webhook time before that doorbell counts as stale. */
const SUPERSEDE_MARGIN_MS = 5_000

/** Whether the latest visible event for `label` is clearly newer than the doorbell's webhook time `at`, i.e. a late or redelivered doorbell. */
export function doorbellSuperseded(events: readonly LabelEvent[], label: string, at: string | undefined): boolean {
  const since = at === undefined ? NaN : Date.parse(at)
  const created = latestLabelEvent(events, label)?.created_at
  const latest = created === undefined ? NaN : Date.parse(created)
  return Number.isFinite(since) && Number.isFinite(latest) && latest > since + SUPERSEDE_MARGIN_MS
}

/**
 * Who authorized a label currently on the issue: the actor login of the latest visible event for that label, only if it is
 * a `labeled` add by a human (isHumanActor) that is not the App (isAppActor); otherwise null (removal newer, no event = lag,
 * bot/App actor). Write access is NOT checked here (it's async); callers then require live write access for the login.
 */
export function labelAdder(events: readonly LabelEvent[], label: string, appSlug: string | undefined): string | null {
  const latest = latestLabelEvent(events, label)
  if (latest?.event !== 'labeled' || !isHumanActor(latest) || isAppActor(latest, appSlug)) return null
  return latest.actor?.login ?? null
}

/** Async convenience: labelAdder + live write check through a supplied (deduping) writer function; fail closed. */
export async function labelAddedByWriter(
  events: readonly LabelEvent[],
  label: string,
  appSlug: string | undefined,
  writer: (login: string) => Promise<{ write: boolean; level: RepoPermissionLevel }>
): Promise<{ login: string; level: RepoPermissionLevel } | null> {
  const login = labelAdder(events, label, appSlug)
  if (login === null) return null
  const check = await writer(login)
  return check.write ? { login, level: check.level } : null
}

/** Lane 1b: the latest visible labeled/unlabeled event for one exact label, shaped as an add/removed/none verdict. */
export type LabelAttribution =
  { kind: 'add'; event: LabelEvent; eventId: number } | { kind: 'removed'; eventId: number } | { kind: 'none' }

/** Reuses latestLabelEvent so the newest-event rule lives once; the add/removed/none shape is a sync convenience. */
export function attributeLabel(events: readonly LabelEvent[], labelName: string): LabelAttribution {
  const latest = latestLabelEvent(events, labelName)
  if (!latest) return { kind: 'none' }
  if (latest.event === 'labeled') return { kind: 'add', event: latest, eventId: latest.id }
  return { kind: 'removed', eventId: latest.id }
}

/** Lane 1b: a single label's adoption verdict: adopt, revert with a refusal comment, or revert silently. */
export type LabelVerdict = 'writer' | 'non_writer' | 'ignored'

/** Reuses labelAdder (human + not-App) and adds the live write check; fail closed. */
export async function judgeLabelAdd(
  attribution: LabelAttribution,
  opts: {
    repo: RepoPermissionTarget
    permissions: RepoPermissionLookup
    appSlug?: string
    writers: Map<string, Promise<boolean>>
    warn: (err: unknown, repoId: bigint) => void
  }
): Promise<LabelVerdict> {
  if (attribution.kind !== 'add') return 'ignored'
  const login = labelAdder([attribution.event], attribution.event.label?.name ?? '', opts.appSlug)
  if (!login) return 'ignored'
  const id = login.toLowerCase()
  let write = opts.writers.get(id)
  if (!write) {
    write = checkWriteAccess(opts.permissions, opts.repo, id).then((access) => {
      if (access.error) opts.warn(access.error, opts.repo.repoId)
      return access.write
    })
    opts.writers.set(id, write)
  }
  return (await write) ? 'writer' : 'non_writer'
}
