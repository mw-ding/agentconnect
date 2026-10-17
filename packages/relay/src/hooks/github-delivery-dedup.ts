// Bounded LRU + TTL for GitHub webhook delivery ids. A retry of the same X-GitHub-Delivery must not forward twice.
import type { Clock } from '@agentconnect.md/connection'

export interface GithubDeliveryDedupOpts {
  /** How long a committed delivery stays deduped. Default 10 minutes. */
  ttlMs?: number
  /** How long an uncommitted claim blocks redeliveries before it counts as abandoned. Default 5 minutes. */
  inFlightMs?: number
  /** Max tracked ids. The least recently used id is dropped past this. Default 10_000. */
  maxEntries?: number
}

export type GithubDeliveryClaim = 'new' | 'committed' | 'in-flight'

interface Entry {
  until: number
  inFlight: boolean
}

export class GithubDeliveryDedup {
  private readonly seen = new Map<string, Entry>()
  private readonly ttlMs: number
  private readonly inFlightMs: number
  private readonly maxEntries: number

  constructor(
    private readonly clock: Clock,
    opts: GithubDeliveryDedupOpts = {}
  ) {
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000
    this.inFlightMs = opts.inFlightMs ?? 5 * 60 * 1000
    this.maxEntries = opts.maxEntries ?? 10_000
  }

  /** Claims `deliveryId` in flight when it is new; otherwise says whether it is committed or still being forwarded. An absent id is never deduped. */
  claim(deliveryId: string | undefined): GithubDeliveryClaim {
    if (!deliveryId) return 'new'
    const now = this.clock.now()
    const entry = this.seen.get(deliveryId)
    if (entry !== undefined && entry.until > now) {
      this.seen.delete(deliveryId)
      this.seen.set(deliveryId, entry)
      return entry.inFlight ? 'in-flight' : 'committed'
    }
    // An expired in-flight claim was abandoned by a handler that never settled it; reclaim it as new.
    if (entry !== undefined) this.seen.delete(deliveryId)
    this.evict(now)
    this.seen.set(deliveryId, { until: now + this.inFlightMs, inFlight: true })
    return 'new'
  }

  /** Marks a claimed delivery as forwarded; a redelivery is deduped for the TTL. A no-op once the id was forgotten. */
  commit(deliveryId: string | undefined): void {
    if (!deliveryId || !this.seen.get(deliveryId)?.inFlight) return
    this.seen.set(deliveryId, { until: this.clock.now() + this.ttlMs, inFlight: false })
  }

  /** Forgets the id, claimed or committed, so GitHub's redelivery of the same GUID is processed. */
  forget(deliveryId: string | undefined): void {
    if (deliveryId) this.seen.delete(deliveryId)
  }

  private evict(now: number): void {
    if (this.seen.size < this.maxEntries) return
    for (const [id, entry] of this.seen) if (entry.until <= now) this.seen.delete(id)
    while (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.keys().next().value
      if (oldest === undefined) return
      this.seen.delete(oldest)
    }
  }
}
