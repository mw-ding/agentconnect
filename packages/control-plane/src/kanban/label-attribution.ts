// Per-label attribution from visible issue events (issue #194): who last added a label, and whether a pass may decide.
import { isAppActor, isHumanActor, type LabelEvent } from './card-store.js'
import { checkWriteAccess, type RepoPermissionLookup, type RepoPermissionTarget } from '../github/repo-permission.js'

/** A managed label is one a human may move the card by: a status or an assignee label. `ac/mode:*` is display-only. */
export function isManagedLabel(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('ac/status:') || lower.startsWith('ac/agent:')
}

/** The latest visible labeled/unlabeled event for one exact label (case-insensitive), tie-broken by id then created_at. */
export type LabelAttribution =
  { kind: 'add'; event: LabelEvent; eventId: number } | { kind: 'removed'; eventId: number } | { kind: 'none' }

export function attributeLabel(events: readonly LabelEvent[], labelName: string): LabelAttribution {
  const target = labelName.toLowerCase()
  let latest: LabelEvent | undefined
  for (const event of events) {
    if ((event.event !== 'labeled' && event.event !== 'unlabeled') || !event.label?.name) continue
    if (event.label.name.toLowerCase() !== target) continue
    if (!latest || laterThan(event, latest)) latest = event
  }
  if (!latest) return { kind: 'none' }
  if (latest.event === 'labeled') return { kind: 'add', event: latest, eventId: latest.id }
  return { kind: 'removed', eventId: latest.id }
}

function laterThan(a: LabelEvent, b: LabelEvent): boolean {
  if (a.id !== b.id) return a.id > b.id
  return (a.created_at ?? '') > (b.created_at ?? '')
}

/** A single label's adoption verdict: adopt, revert with a refusal comment, or revert silently. */
export type LabelVerdict = 'writer' | 'non_writer' | 'ignored'

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
  const event = attribution.event
  if (!isHumanActor(event) || isAppActor(event, opts.appSlug)) return 'ignored'
  const login = event.actor!.login!.toLowerCase()
  let write = opts.writers.get(login)
  if (!write) {
    write = checkWriteAccess(opts.permissions, opts.repo, login).then((access) => {
      if (access.error) opts.warn(access.error, opts.repo.repoId)
      return access.write
    })
    opts.writers.set(login, write)
  }
  return (await write) ? 'writer' : 'non_writer'
}

/** The managed labels currently on an issue, lowercased. */
export function liveManagedLabels(issue: { labels: readonly string[] }): Set<string> {
  const labels = new Set<string>()
  for (const label of issue.labels) if (isManagedLabel(label)) labels.add(label.toLowerCase())
  return labels
}

/** Reconstruct the managed label set by replaying visible events oldest-first from an empty baseline. */
export function replayManagedLabels(events: readonly LabelEvent[]): Set<string> {
  const labels = new Set<string>()
  const ordered = [...events].sort((a, b) =>
    a.id !== b.id ? a.id - b.id : (a.created_at ?? '').localeCompare(b.created_at ?? '')
  )
  for (const event of ordered) {
    if ((event.event !== 'labeled' && event.event !== 'unlabeled') || !event.label?.name) continue
    if (!isManagedLabel(event.label.name)) continue
    if (event.event === 'labeled') labels.add(event.label.name.toLowerCase())
    else labels.delete(event.label.name.toLowerCase())
  }
  return labels
}

export function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}
