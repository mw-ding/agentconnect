// Durable copy of the orchestrator pending-create map, so a crash before
// commit_create retries without filing a second issue.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface PendingCreateEntry {
  issueNumber: number
  filedAt: number
}

export type PendingCreateMap = Map<string, PendingCreateEntry>

export interface PendingJournalLog {
  warn(message: string): void
}

const isEntry = (value: unknown): value is PendingCreateEntry => {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return Number.isInteger(entry.issueNumber) && Number.isFinite(entry.filedAt)
}

// A corrupt or missing file just means empty; the marker lookup still covers a lost journal.
export function loadPendingJournal(path: string | undefined, log?: PendingJournalLog): PendingCreateMap {
  const pending: PendingCreateMap = new Map()
  if (!path) return pending
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    log?.warn(`kanban pending journal unreadable, starting empty: ${path}`)
    return pending
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log?.warn(`kanban pending journal unreadable, starting empty: ${path}`)
    return pending
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (isEntry(value)) pending.set(key, { issueNumber: value.issueNumber, filedAt: value.filedAt })
  }
  return pending
}

// tmp + rename keeps a crash from leaving a half-written journal.
export function savePendingJournal(path: string | undefined, pending: PendingCreateMap, log?: PendingJournalLog): void {
  if (!path) return
  const temp = `${path}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temp, `${JSON.stringify(Object.fromEntries(pending))}\n`, { mode: 0o600 })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    log?.warn(`kanban pending journal unwritten: ${error instanceof Error ? error.message : String(error)}`)
  }
}
