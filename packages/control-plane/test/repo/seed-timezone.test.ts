// The seed CLI opens its client through createPrisma, so it carries the UTC session pin too.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { disconnectPrisma } from '../../src/persistence/prisma.js'
import { openSeedClient } from '../../prisma/seed.js'
import { prisma } from '../setup.db.js'

const url = process.env.DATABASE_URL!
let dbName: string

describe('prisma/seed.ts client (database default America/Los_Angeles)', () => {
  beforeAll(async () => {
    const [row] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
    dbName = row!.db
    await prisma.$executeRawUnsafe(`ALTER DATABASE "${dbName}" SET timezone = 'America/Los_Angeles'`)
  })

  afterAll(async () => {
    await disconnectPrisma()
    await prisma.$executeRawUnsafe(`ALTER DATABASE "${dbName}" RESET timezone`)
  })

  it('opens a UTC-pinned session', async () => {
    const client = openSeedClient(url)
    const [tz] = await client.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`
    expect(tz!.tz).toBe('UTC')
  })

  it('refuses to seed without a database URL', () => {
    expect(() => openSeedClient('')).toThrow(/DATABASE_URL/)
  })
})
