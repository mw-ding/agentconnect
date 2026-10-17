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

  it('passes through a missing or unparsable URL', () => {
    expect(withUtcSession(undefined)).toBeUndefined()
    expect(withUtcSession('not a url')).toBe('not a url')
  })
})
