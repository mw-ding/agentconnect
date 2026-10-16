// Posts one accepted Kanban summary to GitHub. The report stays body-free, so the text lives only in this daemon's outbox.
import type { KanbanTerminalEntry } from './kanban-worker.js'
import { GithubFinalPoster } from '../github/poster.js'
import type { KanbanCommentRow } from '../store/local-store.js'

const BATCH = 8
const BACKOFF_BASE_MS = 15_000
const BACKOFF_MAX_MS = 15 * 60_000
/** Comments updated since the first attempt, five pages at most; a sixth page makes the lookup inconclusive. */
const MARKER_PAGE_LIMIT = 5
const MARKER_PAGE_SIZE = 100
/** Widens the since window for clock skew between this daemon and GitHub. */
const MARKER_SINCE_SKEW_MS = 2 * 60_000
/** Undecided marker lookups (bound hit, timeout, error) before the row is parked as failed. */
const MARKER_LOOKUP_LIMIT = 5
/** Bounds the whole marker lookup, including every page fetch and its body. */
const MARKER_LOOKUP_TIMEOUT_MS = 15_000

type MarkerLookup = 'found' | 'absent' | 'inconclusive'

/** Hidden lease marker. A crash during POST retries by looking for this before posting again. */
export function kanbanLeaseMarker(leaseId: string): string {
  return `ac-kanban-lease:${leaseId}`
}

/** The comment body: the agent's summary, its reason when it gave one, and the lease marker. */
export function kanbanFinalCommentBody(entry: KanbanTerminalEntry): string {
  // @-mentions stay literal, matching GithubFinalPoster final-answer text.
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

/** Read a comment page under the lookup's abort signal, cancelling a stalled body instead of waiting it out. */
function readJson(res: Response, signal: AbortSignal): Promise<unknown> {
  const body = res.body
  if (!body) return Promise.resolve(undefined)
  const reader = body.getReader()
  let settled = false
  return new Promise((resolve, reject) => {
    const finish = (err?: unknown, value?: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (err !== undefined) reject(err)
      else resolve(value)
    }
    const onAbort = () => {
      void reader.cancel().catch(() => undefined)
      finish(signal.reason ?? new DOMException('The operation was aborted', 'TimeoutError'))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const chunks: Uint8Array[] = []
    const pump = (): void => {
      reader.read().then(
        ({ done, value }) => {
          if (settled) return
          if (value) chunks.push(value)
          if (!done) {
            pump()
            return
          }
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            finish(undefined, text.length === 0 ? null : JSON.parse(text))
          } catch (err) {
            finish(err)
          }
        },
        (err: unknown) => {
          if (!settled) finish(signal.aborted ? (signal.reason ?? err) : err)
        }
      )
    }
    pump()
  })
}

/** The sqlite rows the publisher drains. LocalStore implements this. */
export interface KanbanCommentStore {
  dueKanbanComments(now: number, limit: number): KanbanCommentRow[]
  markKanbanCommentAttempt(leaseId: string, nextAt: number, at: number): void
  deferKanbanComment(leaseId: string, nextAt: number): void
  deferKanbanCommentLookup(leaseId: string, nextAt: number): void
  failKanbanComment(leaseId: string): void
  removeKanbanComment(leaseId: string): void
}

export interface KanbanCommentPublisherDeps {
  clock: { now(): number }
  log: { info(message: string): void; warn(message: string): void; error(message: string): void }
  store: KanbanCommentStore
  /** CP-minted issues token for this accepted lease. Throws when the CP refuses or is unreachable. */
  token(entry: KanbanTerminalEntry): Promise<string>
  invalidateToken?(entry: KanbanTerminalEntry, token: string): void
  fetchImpl?: typeof fetch
  baseUrl?: string
  /** Marker lookup deadline. Covers the fetches and their bodies; a timeout defers that comment. */
  markerLookupTimeoutMs?: number
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
    const later = () => this.deps.clock.now() + commentBackoff(row.attempts + row.lookupMisses + 1)
    let token: string
    try {
      token = await this.deps.token(entry)
    } catch (err) {
      this.deps.log.warn(`kanban: comment token unavailable for ${leaseId} (${String(err)})`)
      this.deps.store.deferKanbanComment(leaseId, later())
      return
    }
    if (row.attempted) {
      let lookup: MarkerLookup
      try {
        lookup = await this.findMarker(row, token)
      } catch (err) {
        this.lookupMissed(row, later(), `failed (${String(err)})`)
        return
      }
      if (lookup === 'found') {
        this.deps.store.removeKanbanComment(leaseId)
        this.deps.log.info(`kanban: final comment already on ${entry.repoFullName}#${entry.issueNumber}`)
        return
      }
      if (lookup === 'inconclusive') {
        this.lookupMissed(row, later(), 'hit the page bound')
        return
      }
    }
    // Mark before the POST so a crash mid-request looks before it posts a second copy.
    this.deps.store.markKanbanCommentAttempt(leaseId, later(), this.deps.clock.now())
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

  /** An undecided lookup retries with backoff, then parks the row loudly rather than looping or risking a duplicate. */
  private lookupMissed(row: KanbanCommentRow, nextAt: number, why: string): void {
    const leaseId = row.entry.report.leaseId
    const issue = `${row.entry.repoFullName}#${row.entry.issueNumber}`
    const misses = row.lookupMisses + 1
    if (misses >= MARKER_LOOKUP_LIMIT) {
      this.deps.store.failKanbanComment(leaseId)
      this.deps.log.error(
        `kanban: final comment for lease ${leaseId} on ${issue} needs attention; marker lookup ${why}, ${misses} undecided lookups, not posting`
      )
      return
    }
    this.deps.log.warn(
      `kanban: comment lookup ${why} for lease ${leaseId} on ${issue} (${misses}/${MARKER_LOOKUP_LIMIT})`
    )
    this.deps.store.deferKanbanCommentLookup(leaseId, nextAt)
  }

  private async findMarker(row: KanbanCommentRow, token: string): Promise<MarkerLookup> {
    const entry = row.entry
    const marker = kanbanLeaseMarker(entry.report.leaseId)
    const fetchImpl = this.deps.fetchImpl ?? fetch
    const base = this.deps.baseUrl ?? 'https://api.github.com'
    const signal = AbortSignal.timeout(this.deps.markerLookupTimeoutMs ?? MARKER_LOOKUP_TIMEOUT_MS)
    // This endpoint ignores sort/direction and lists oldest first, so since is what skips the older history.
    const since = new Date((row.attemptedAt ?? row.recordedAt) - MARKER_SINCE_SKEW_MS).toISOString()
    const query = new URLSearchParams({ since, per_page: String(MARKER_PAGE_SIZE) })
    let url: string | undefined = `${base}/repos/${entry.repoFullName}/issues/${entry.issueNumber}/comments?${query}`
    for (let page = 0; page < MARKER_PAGE_LIMIT && url; page++) {
      const res = await fetchImpl(url, {
        signal,
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
      const comments = (await readJson(res, signal)) as Array<{ body?: string }>
      if (!Array.isArray(comments)) throw new Error('GitHub GET comments was not a list')
      if (comments.some((comment) => comment.body?.includes(marker))) return 'found'
      const next = nextLink(res.headers.get('link'))
      if (!next) return 'absent'
      url = next
    }
    // The bound was hit with more pages left, so a miss is not proof the marker is absent.
    return 'inconclusive'
  }
}
