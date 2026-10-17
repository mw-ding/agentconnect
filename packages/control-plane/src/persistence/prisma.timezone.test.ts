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

  const PIN = 'options=-c%20timezone%3DUTC'

  it.each([
    ['no query', 'postgresql://u:p@h:5432/db', `postgresql://u:p@h:5432/db?${PIN}`],
    ['an empty query', 'postgresql://u:p@h/db?', `postgresql://u:p@h/db?${PIN}`],
    [
      'a query with stray separators',
      'postgresql://u:p@h/db?&&sslmode=require&',
      `postgresql://u:p@h/db?sslmode=require&${PIN}`
    ],
    ['a postgres:// scheme', 'postgres://u:p@h/db', `postgres://u:p@h/db?${PIN}`],
    ['an upper-case scheme', 'POSTGRESQL://u:p@h/db', `POSTGRESQL://u:p@h/db?${PIN}`],
    ['an IPv6 host', 'postgresql://u:p@[::1]:5432/db', `postgresql://u:p@[::1]:5432/db?${PIN}`],
    ['no host and no database', 'postgresql://', `postgresql://?${PIN}`],
    [
      'a unix socket directory',
      'postgresql://u@%2Fvar%2Frun%2Fpostgresql/db',
      `postgresql://u@%2Fvar%2Frun%2Fpostgresql/db?${PIN}`
    ],
    [
      'a socket host parameter',
      'postgresql://u:p@/db?host=/var/run/postgresql&port=5433',
      `postgresql://u:p@/db?host=/var/run/postgresql&port=5433&${PIN}`
    ],
    ['a prisma schema parameter', 'postgresql://u:p@h/db?schema=app', `postgresql://u:p@h/db?schema=app&${PIN}`]
  ])('pins %s and leaves the rest of the URL byte-for-byte', (_label, input, expected) => {
    expect(withUtcSession(input)).toBe(expected)
  })

  it('keeps a percent-encoded password, user and database name untouched', () => {
    const base = 'postgresql://us%40er:p%40ss%2Fw%3Ard%23%3F@/my%20db'
    expect(withUtcSession(`${base}?host=localhost`)).toBe(`${base}?host=localhost&${PIN}`)
    expect(withUtcSession(`${base.replace('@/', '@h:5432/')}`)).toBe(`${base.replace('@/', '@h:5432/')}?${PIN}`)
  })

  it('is idempotent: pinning an already pinned URL pins once more without duplicating the flag', () => {
    const once = withUtcSession('postgresql://u:p@/db?host=localhost&options=-c%20a%3D1')!
    const twice = withUtcSession(once)!
    expect(new URLSearchParams(twice.slice(twice.indexOf('?') + 1)).getAll('options')).toEqual([
      '-c a=1 -c timezone=UTC'
    ])
    expect(twice).toBe(once)
  })

  it.each([
    ['--timezone=EST', '-c timezone=UTC'],
    ['-ctimezone=EST', '-c timezone=UTC'],
    ['-c TimeZone=EST', '-c timezone=UTC'],
    ['-c timezone=EST -c statement_timeout=5', '-c statement_timeout=5 -c timezone=UTC'],
    ['-c a=1 -c timezone=EST -c b=2', '-c a=1 -c b=2 -c timezone=UTC'],
    ['-c timezone=UTC', '-c timezone=UTC'],
    ['-c lock_timeout=1', '-c lock_timeout=1 -c timezone=UTC']
  ])('rewrites the options flag %j', (flag, expected) => {
    const url = withUtcSession(`postgresql:///db?host=/tmp&options=${encodeURIComponent(flag)}`)!
    expect(new URLSearchParams(url.slice(url.indexOf('?') + 1)).getAll('options')).toEqual([expected])
  })

  it('reads a plus sign and an encoded option name as the parameter they spell', () => {
    const url = withUtcSession('postgresql://h/db?opt%69ons=-c+timezone%3DEST+-c+a%3D1')!
    expect(new URLSearchParams(url.slice(url.indexOf('?') + 1)).getAll('options')).toEqual(['-c a=1 -c timezone=UTC'])
  })

  it('treats a bare options parameter as an empty one', () => {
    expect(withUtcSession('postgresql://h/db?options')).toBe(`postgresql://h/db?${PIN}`)
    expect(withUtcSession('postgresql://h/db?options=')).toBe(`postgresql://h/db?${PIN}`)
  })

  it.each([
    ['a leading space', ' postgresql://h/db'],
    ['a scheme without slashes', 'postgresql:h/db'],
    ['a jdbc URL', 'jdbc:postgresql://h/db'],
    ['a keyword/value string', 'host=localhost dbname=x'],
    ['an http URL', 'http://h/db'],
    ['a bare host', 'localhost:5432/db']
  ])('fails closed on %s', (_label, input) => {
    expect(() => withUtcSession(input)).toThrow(/postgres/)
  })
})
