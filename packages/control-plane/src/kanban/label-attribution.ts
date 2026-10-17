// Per-label attribution (Lane 1a importer, reused by Lane 1b): the latest visible labeled/unlabeled event decides who may
// have set a label currently on the issue, so a stale add never authorizes a newer removal or a lagged re-add.
import type { RepoPermissionLevel } from '../github/repo-permission.js'
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
