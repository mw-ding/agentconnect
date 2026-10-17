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

  it('reports a claimed delivery as in flight until it is committed, past the committed TTL', () => {
    const clock = new FakeClock()
    const dedup = new GithubDeliveryDedup(clock, { ttlMs: 1_000 })
    expect(dedup.claim('a')).toBe('new')
    clock.advance(60_000)
    expect(dedup.claim('a')).toBe('in-flight')
    dedup.commit('a')
    expect(dedup.claim('a')).toBe('committed')
  })

  it('reclaims an in-flight delivery that was never settled once the in-flight bound elapses', () => {
    const clock = new FakeClock()
    const dedup = new GithubDeliveryDedup(clock, { ttlMs: 1_000, inFlightMs: 5 * 60 * 1000 })
    expect(dedup.claim('a')).toBe('new')
    clock.advance(5 * 60 * 1000 - 1)
    expect(dedup.claim('a')).toBe('in-flight')
    clock.advance(1)
    expect(dedup.claim('a')).toBe('new')
    expect(dedup.claim('a')).toBe('in-flight')
    dedup.commit('a')
    expect(dedup.claim('a')).toBe('committed')
  })

  it('evicts an abandoned in-flight claim before a live one at the cap', () => {
    const clock = new FakeClock()
    const dedup = new GithubDeliveryDedup(clock, { inFlightMs: 1_000, maxEntries: 2 })
    dedup.claim('stale')
    clock.advance(500)
    dedup.claim('live')
    clock.advance(500)
    expect(dedup.claim('c')).toBe('new')
    expect(dedup.claim('live')).toBe('in-flight')
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
