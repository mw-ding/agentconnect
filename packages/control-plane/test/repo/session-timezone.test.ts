// The control plane's Prisma client reads timestamps correctly when the database defaults to a non-UTC zone.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../../src/generated/prisma/client.js'
import { createPrisma, disconnectPrisma } from '../../src/persistence/prisma.js'
import { prisma } from '../setup.db.js'

const PACIFIC = 'America/Los_Angeles'
const url = process.env.DATABASE_URL!
let dbName: string

async function clockSkewMs(client: PrismaClient): Promise<number> {
  const [row] = await client.$queryRaw<{ now: Date }[]>`SELECT now() AS now`
  return Math.abs(row!.now.getTime() - Date.now())
}

async function boundDateMatches(client: PrismaClient, instant: Date): Promise<boolean> {
  const [row] = await client.$queryRaw<{ eq: boolean }[]>`
    SELECT ${instant}::timestamptz = ${instant.toISOString()}::timestamptz AS eq`
  return row!.eq
}

describe('Postgres session timezone (database default America/Los_Angeles)', () => {
  beforeAll(async () => {
    const [row] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`
    dbName = row!.db
    await prisma.$executeRawUnsafe(`ALTER DATABASE "${dbName}" SET timezone = '${PACIFIC}'`)
  })

  afterAll(async () => {
    await disconnectPrisma()
    await prisma.$executeRawUnsafe(`ALTER DATABASE "${dbName}" RESET timezone`)
  })

  it('an unpinned adapter session inherits the Pacific default and drifts (the hazard)', async () => {
    const raw = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
    try {
      const [tz] = await raw.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`
      expect(tz!.tz).toBe(PACIFIC)
      expect(await clockSkewMs(raw)).toBeGreaterThan(60 * 60_000)
    } finally {
      await raw.$disconnect()
    }
  })

  it('createPrisma pins UTC, so now() and bound Dates stay correct', async () => {
    const client = createPrisma(url)
    const [tz] = await client.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`
    expect(tz!.tz).toBe('UTC')
    expect(await clockSkewMs(client)).toBeLessThan(60_000)
    expect(await boundDateMatches(client, new Date('2026-10-16T18:54:49.691Z'))).toBe(true)
  })
})
