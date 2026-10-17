import { describe, expect, it } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { GithubDeliveryDedup } from './github-delivery-dedup.js'

describe('GithubDeliveryDedup', () => {
  it('dedups a committed delivery until the TTL and evicts the least recently used id at the cap', () => {
    const clock = new FakeClock()
    const dedup = new GithubDeliveryDedup(clock, { ttlMs: 1_000, maxEntries: 2 })
    expect(dedup.claim('a')).toBe('new')
    dedup.commit('a')
    expect(dedup.claim('a')).toBe('committed')
    expect(dedup.claim(undefined)).toBe('new')

    clock.advance(1_000)
    expect(dedup.claim('a')).toBe('new')
    dedup.commit('a')

    expect(dedup.claim('b')).toBe('new')
    dedup.commit('b')
    expect(dedup.claim('a')).toBe('committed')
    expect(dedup.claim('c')).toBe('new')
    dedup.commit('c')
    expect(dedup.claim('a')).toBe('committed')
    expect(dedup.claim('b')).toBe('new')
  })

  it('reports a claimed delivery as in flight until it is committed, and never expires it meanwhile', () => {
    const clock = new FakeClock()
    const dedup = new GithubDeliveryDedup(clock, { ttlMs: 1_000 })
    expect(dedup.claim('a')).toBe('new')
    clock.advance(60_000)
    expect(dedup.claim('a')).toBe('in-flight')
    dedup.commit('a')
    expect(dedup.claim('a')).toBe('committed')
  })

  it('forgets a claimed or committed delivery, and a commit after a forget does not re-add it', () => {
    const dedup = new GithubDeliveryDedup(new FakeClock())
    dedup.claim('a')
    dedup.forget('a')
    dedup.commit('a')
    expect(dedup.claim('a')).toBe('new')
    dedup.commit('a')
    dedup.forget('a')
    expect(dedup.claim('a')).toBe('new')
  })
})
