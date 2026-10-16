// Bounded LRU + TTL for GitHub webhook delivery ids. A retry of the same X-GitHub-Delivery must not forward twice.
import type { Clock } from '@agentconnect.md/connection'

export interface GithubDeliveryDedupOpts {
  /** How long a seen delivery stays deduped. Default 10 minutes. */
  ttlMs?: number
  /** Max tracked ids. The least recently used id is dropped past this. Default 10_000. */
  maxEntries?: number
}

export class GithubDeliveryDedup {
  private readonly seen = new Map<string, number>()
  private readonly ttlMs: number
  private readonly maxEntries: number

  constructor(
    private readonly clock: Clock,
    opts: GithubDeliveryDedupOpts = {}
  ) {
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000
    this.maxEntries = opts.maxEntries ?? 10_000
  }

  /** True when `deliveryId` was already accepted and is still inside the TTL. An absent id is never deduped. */
  seenDelivery(deliveryId: string | undefined): boolean {
    if (!deliveryId) return false
    const now = this.clock.now()
    const expiry = this.seen.get(deliveryId)
    if (expiry !== undefined && expiry > now) {
      this.seen.delete(deliveryId)
      this.seen.set(deliveryId, expiry)
      return true
    }
    if (expiry !== undefined) this.seen.delete(deliveryId)
    this.evict(now)
    this.seen.set(deliveryId, now + this.ttlMs)
    return false
  }

  private evict(now: number): void {
    if (this.seen.size < this.maxEntries) return
    for (const [id, expiry] of this.seen) if (expiry <= now) this.seen.delete(id)
    while (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.keys().next().value
      if (oldest === undefined) return
      this.seen.delete(oldest)
    }
  }
}
