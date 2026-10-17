// withUtcSession pins the Postgres session timezone without dropping other connection options.
import { describe, expect, it } from 'vitest'
import { withUtcSession } from './prisma.js'

const options = (url: string | undefined) => new URL(url!).searchParams.get('options')

describe('withUtcSession', () => {
  it('adds a UTC timezone option', () => {
    expect(options(withUtcSession('postgresql://u:p@h:5432/db'))).toBe('-c timezone=UTC')
  })

  it('keeps other options and query parameters', () => {
    const url = withUtcSession('postgresql://u:p@h/db?sslmode=require&options=-c%20statement_timeout%3D5000')!
    expect(options(url)).toBe('-c statement_timeout=5000 -c timezone=UTC')
    expect(new URL(url).searchParams.get('sslmode')).toBe('require')
  })

  it('replaces an explicit non-UTC timezone', () => {
    expect(options(withUtcSession('postgresql://h/db?options=-c%20timezone%3DAmerica/Los_Angeles'))).toBe(
      '-c timezone=UTC'
    )
    expect(options(withUtcSession('postgresql://h/db?options=--timezone%3DEST'))).toBe('-c timezone=UTC')
  })

  it('pins an empty-host libpq URL without parsing it', () => {
    expect(withUtcSession('postgresql://u:p@/db?host=localhost')).toBe(
      'postgresql://u:p@/db?host=localhost&options=-c%20timezone%3DUTC'
    )
    expect(withUtcSession('postgresql:///db?host=/var/run/postgresql')).toBe(
      'postgresql:///db?host=/var/run/postgresql&options=-c%20timezone%3DUTC'
    )
  })

  it('keeps and replaces options on an empty-host URL, and keeps the fragment', () => {
    const url = withUtcSession(
      'postgres:///db?host=/tmp&options=-c%20timezone%3DEST%20-c%20statement_timeout%3D5&x=1#f'
    )!
    expect(url.endsWith('#f')).toBe(true)
    const query = new URLSearchParams(url.slice(url.indexOf('?') + 1, url.indexOf('#')))
    expect(query.get('options')).toBe('-c statement_timeout=5 -c timezone=UTC')
    expect(query.get('host')).toBe('/tmp')
    expect(query.get('x')).toBe('1')
  })

  it('merges repeated options parameters and pins exactly once', () => {
    const url = withUtcSession('postgresql://h/db?options=-c%20a%3D1&options=--timezone%3DEST')!
    expect(new URL(url).searchParams.getAll('options')).toEqual(['-c a=1 -c timezone=UTC'])
  })

  it('passes a missing URL through and fails closed on anything it cannot pin', () => {
    expect(withUtcSession(undefined)).toBeUndefined()
    expect(withUtcSession('')).toBe('')
    expect(() => withUtcSession('not a url')).toThrow(/postgres/)
    expect(() => withUtcSession('mysql://u:p@h/db')).toThrow(/postgres/)
    expect(() => withUtcSession('host=localhost dbname=x')).toThrow(/postgres/)
    expect(() => withUtcSession('postgresql://h/db?options=%E0%A4%A')).toThrow(/malformed/)
  })
})
