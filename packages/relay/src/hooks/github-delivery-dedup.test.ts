import { describe, expect, it } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { GithubDeliveryDedup } from './github-delivery-dedup.js'

describe('GithubDeliveryDedup', () => {
  it('forgets a delivery after the TTL and evicts the least recently used id at the cap', () => {
    const clock = new FakeClock()
    const dedup = new GithubDeliveryDedup(clock, { ttlMs: 1_000, maxEntries: 2 })
    expect(dedup.seenDelivery('a')).toBe(false)
    expect(dedup.seenDelivery('a')).toBe(true)
    expect(dedup.seenDelivery(undefined)).toBe(false)

    clock.advance(1_000)
    expect(dedup.seenDelivery('a')).toBe(false)

    expect(dedup.seenDelivery('b')).toBe(false)
    expect(dedup.seenDelivery('a')).toBe(true)
    expect(dedup.seenDelivery('c')).toBe(false)
    expect(dedup.seenDelivery('a')).toBe(true)
    expect(dedup.seenDelivery('b')).toBe(false)
  })
})
