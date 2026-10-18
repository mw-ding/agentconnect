// Persist create intents and filed issue numbers before the next external effect.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type PendingCreateEntry = (
  { issueNumber: number; filedAt: number; lookedUp?: boolean } | { issueNumber: null; startedAt: number }
) & { rejectedIssueNumbers?: number[] }

export type PendingCreateMap = Map<string, PendingCreateEntry> & { unknown?: boolean }

export interface PendingJournalLog {
  warn(message: string): void
}

const validNumber = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0
const validTime = (n: unknown, now: number): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= now + 60_000

const isEntry = (value: unknown, now: number): value is PendingCreateEntry => {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  if (
    entry.rejectedIssueNumbers !== undefined &&
    (!Array.isArray(entry.rejectedIssueNumbers) ||
      entry.rejectedIssueNumbers.length > 300 ||
      !entry.rejectedIssueNumbers.every(validNumber))
  )
    return false
  if (entry.issueNumber === null) return entry.filedAt === undefined && validTime(entry.startedAt, now)
  return (
    entry.startedAt === undefined &&
    validNumber(entry.issueNumber) &&
    validTime(entry.filedAt, now) &&
    (entry.lookedUp === undefined || typeof entry.lookedUp === 'boolean')
  )
}

const cleanEntry = (value: PendingCreateEntry): PendingCreateEntry => {
  const rejected =
    value.rejectedIssueNumbers !== undefined ? { rejectedIssueNumbers: [...value.rejectedIssueNumbers] } : {}
  if (value.issueNumber === null) return { issueNumber: null, startedAt: value.startedAt, ...rejected }
  return value.lookedUp === undefined
    ? { issueNumber: value.issueNumber, filedAt: value.filedAt, ...rejected }
    : { issueNumber: value.issueNumber, filedAt: value.filedAt, lookedUp: value.lookedUp, ...rejected }
}

// Corruption is evidence of lost state; an absent journal on first use is a fresh start.
export function loadPendingJournal(
  path: string | undefined,
  log?: PendingJournalLog,
  now = Date.now()
): PendingCreateMap {
  const pending: PendingCreateMap = new Map()
  if (!path) return pending
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    pending.unknown = (error as NodeJS.ErrnoException).code !== 'ENOENT'
    log?.warn(`kanban pending journal unreadable, starting empty: ${path}`)
    return pending
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    pending.unknown = true
    log?.warn(`kanban pending journal unreadable, starting empty: ${path}`)
    return pending
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (isEntry(value, now)) pending.set(key, cleanEntry(value))
    else pending.unknown = true
  }
  return pending
}

// Sync both the contents and the rename so power loss cannot silently reopen the POST window.
export function savePendingJournal(
  path: string | undefined,
  pending: PendingCreateMap,
  log?: PendingJournalLog
): boolean {
  if (!path) return true
  const temp = `${path}.${process.pid}.tmp`
  let fd: number | undefined
  try {
    mkdirSync(dirname(path), { recursive: true })
    fd = openSync(temp, 'w', 0o600)
    writeFileSync(fd, `${JSON.stringify(Object.fromEntries(pending))}\n`)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, path)
    if (process.platform !== 'win32') {
      fd = openSync(dirname(path), 'r')
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
    }
    return true
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    rmSync(temp, { force: true })
    log?.warn(`kanban pending journal unwritten: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}
