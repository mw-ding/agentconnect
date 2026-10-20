// Event-lag reconciliation for the label sync path (Lane 1b): reconstruct the managed labels from visible events and compare
// them to the live issue, so a pass whose visible history does not reproduce the live labels is treated as inconclusive.
import type { LabelEvent } from './card-store.js'

/** A managed label is one a human may move the card by: a status or an assignee label. `ac/mode:*` is display-only. */
export function isManagedLabel(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('ac/status:') || lower.startsWith('ac/agent:')
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
