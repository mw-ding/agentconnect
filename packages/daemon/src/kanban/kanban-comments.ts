// Posts one accepted Kanban summary to GitHub. The report stays body-free, so the text lives only in this daemon's outbox.
import type { KanbanTerminalEntry } from './kanban-worker.js'
import { GithubFinalPoster } from '../github/poster.js'
import type { KanbanCommentRow } from '../store/local-store.js'

const BATCH = 8
const BACKOFF_BASE_MS = 15_000
const BACKOFF_MAX_MS = 15 * 60_000

/** Hidden lease marker. A crash during POST retries by looking for this before posting again. */
export function kanbanLeaseMarker(leaseId: string): string {
  return `ac-kanban-lease:${leaseId}`
}

/** The comment body: the agent's summary, its reason when it gave one, and the lease marker. */
export function kanbanFinalCommentBody(entry: KanbanTerminalEntry): string {
  const parts = [entry.summary.trim()]
  if (entry.reason?.trim()) parts.push(entry.reason.trim())
  parts.push(`<!-- ${kanbanLeaseMarker(entry.report.leaseId)} -->`)
  return parts.filter((part) => part.length > 0).join('\n\n')
}

function commentBackoff(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_MAX_MS)
}

function nextLink(header: string | null): string | undefined {
  if (!header) return undefined
  for (const part of header.split(',')) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part)
    if (match?.[1]) return match[1]
  }
  return undefined
}

/** The sqlite rows the publisher drains. LocalStore implements this. */
export interface KanbanCommentStore {
  dueKanbanComments(now: number, limit: number): KanbanCommentRow[]
  markKanbanCommentAttempt(leaseId: string, nextAt: number): void
  deferKanbanComment(leaseId: string, nextAt: number): void
  removeKanbanComment(leaseId: string): void
}

export interface KanbanCommentPublisherDeps {
  clock: { now(): number }
  log: { info(message: string): void; warn(message: string): void }
  store: KanbanCommentStore
  /** CP-minted issues token for this accepted lease. Throws when the CP refuses or is unreachable. */
  token(entry: KanbanTerminalEntry): Promise<string>
  invalidateToken?(entry: KanbanTerminalEntry, token: string): void
  fetchImpl?: typeof fetch
  baseUrl?: string
}

/** Drains accepted summaries. A failed post leaves the card move in place; the lease marker is the durable idempotency key. */
export class KanbanCommentPublisher {
  private draining?: Promise<void>

  constructor(private readonly deps: KanbanCommentPublisherDeps) {}

  drain(): Promise<void> {
    this.draining ??= this.pass().finally(() => {
      this.draining = undefined
    })
    return this.draining
  }

  private async pass(): Promise<void> {
    let due: KanbanCommentRow[]
    try {
      due = this.deps.store.dueKanbanComments(this.deps.clock.now(), BATCH)
    } catch (err) {
      this.deps.log.warn(`kanban: comment outbox read failed (${String(err)})`)
      return
    }
    for (const row of due) {
      try {
        await this.publishOne(row)
      } catch (err) {
        this.deps.log.warn(`kanban: comment publish failed for ${row.entry.report.leaseId} (${String(err)})`)
      }
    }
  }

  private async publishOne(row: KanbanCommentRow): Promise<void> {
    const entry = row.entry
    const leaseId = entry.report.leaseId
    const later = () => this.deps.clock.now() + commentBackoff(row.attempts + 1)
    let token: string
    try {
      token = await this.deps.token(entry)
    } catch (err) {
      this.deps.log.warn(`kanban: comment token unavailable for ${leaseId} (${String(err)})`)
      this.deps.store.deferKanbanComment(leaseId, later())
      return
    }
    if (row.attempted) {
      let found = false
      try {
        found = await this.findMarker(entry, token)
      } catch (err) {
        this.deps.log.warn(`kanban: comment lookup failed for ${leaseId} (${String(err)})`)
        this.deps.store.deferKanbanComment(leaseId, later())
        return
      }
      if (found) {
        this.deps.store.removeKanbanComment(leaseId)
        this.deps.log.info(`kanban: final comment already on ${entry.repoFullName}#${entry.issueNumber}`)
        return
      }
    }
    // Mark before the POST so a crash mid-request looks before it posts a second copy.
    this.deps.store.markKanbanCommentAttempt(leaseId, later())
    const published = await new GithubFinalPoster(
      {
        token: async () => this.deps.token(entry),
        invalidateToken: (presented) => this.deps.invalidateToken?.(entry, presented),
        log: { warn: (message) => this.deps.log.warn(message) },
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
        ...(this.deps.baseUrl ? { baseUrl: this.deps.baseUrl } : {})
      },
      entry.repoFullName,
      entry.issueNumber
    ).publish(kanbanFinalCommentBody(entry))
    if (!published) return
    this.deps.store.removeKanbanComment(leaseId)
    this.deps.log.info(`kanban: posted final comment on ${entry.repoFullName}#${entry.issueNumber}`)
  }

  private async findMarker(entry: KanbanTerminalEntry, token: string): Promise<boolean> {
    const marker = kanbanLeaseMarker(entry.report.leaseId)
    const fetchImpl = this.deps.fetchImpl ?? fetch
    const base = this.deps.baseUrl ?? 'https://api.github.com'
    let url: string | undefined =
      `${base}/repos/${entry.repoFullName}/issues/${entry.issueNumber}/comments?per_page=100`
    for (let page = 0; page < 5 && url; page++) {
      const res = await fetchImpl(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28'
        }
      })
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        throw new Error(`GitHub GET ${res.status}`)
      }
      const comments = (await res.json()) as Array<{ body?: string }>
      if (comments.some((comment) => comment.body?.includes(marker))) return true
      url = nextLink(res.headers.get('link'))
    }
    return false
  }
}
