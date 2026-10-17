// The v58 → v59 → v60 kanban comment outbox migrations on the real pool store.
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PostgresAsyncDatabase } from '../src/store/postgres-async-database.js'
import { LocalStore, SCHEMA_VERSION, type StoreDatabase } from '../src/store/local-store.js'

const databaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL
const LEGACY_TABLE = `DROP TABLE IF EXISTS kanban_terminals;
  CREATE TABLE kanban_terminals (leaseId TEXT PRIMARY KEY, entry TEXT NOT NULL, state TEXT NOT NULL, recordedAt BIGINT NOT NULL)`
const RETRY_COLUMNS = ['attempts', 'attempted', 'attemptedat', 'lookupmisses', 'nextat']
/** A real epoch in milliseconds: it overflows a 32-bit column. */
const EPOCH_MS = 1_792_000_000_000

/** Opens a store on its own schema, rolls it back to `version`, and hands the raw handle to `shape` before the upgrade. */
async function upgradeFrom(
  version: number,
  shape: (raw: StoreDatabase) => Promise<void>,
  after: (raw: StoreDatabase, upgraded: LocalStore) => Promise<void>
): Promise<void> {
  const schema = `mig_${randomUUID().replace(/-/g, '')}`
  const config = { version: 1 as const, databaseUrl: databaseUrl!, maxConnections: 2 }
  const bootstrap = await PostgresAsyncDatabase.open(config, () => undefined, schema)
  await bootstrap.finishSchemaInitialization()
  await (await LocalStore.open({ database: bootstrap, shared: true, ownerId: 'm1', orgForAgent: () => 'org' })).close()
  const raw = await PostgresAsyncDatabase.open(config, () => undefined, schema)
  await raw.finishSchemaInitialization()
  try {
    await shape(raw)
    await raw.exec(`UPDATE _local_store_schema_version SET version = ${version} WHERE singleton = true`)
    const upgraded = await LocalStore.open({ database: raw, shared: true, ownerId: 'm2', orgForAgent: () => 'org' })
    await after(raw, upgraded)
    await upgraded.close()
  } finally {
    await raw.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined)
    await raw.close()
  }
}

const columns = async (raw: StoreDatabase): Promise<string[]> =>
  (
    (
      await raw.query(
        "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'kanban_terminals'",
        []
      )
    ).rows as { name: string }[]
  ).map((c) => c.name)
const schemaVersion = async (raw: StoreDatabase): Promise<number> =>
  Number(
    ((await raw.query('SELECT version FROM _local_store_schema_version', [])).rows[0] as { version: number }).version
  )
const select = async (raw: StoreDatabase, sql: string): Promise<Record<string, unknown>[]> =>
  ((await raw.query(sql, [])).rows as Record<string, unknown>[]).map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key.toLowerCase(), typeof value === 'bigint' ? Number(value) : value])
    )
  )

describe.skipIf(!databaseUrl)('the kanban outbox migrations on PostgreSQL', () => {
  it('walks a legacy v58 table through v59 and v60 in one open and keeps its rows', async () => {
    await upgradeFrom(
      58,
      async (raw) => {
        await raw.exec(LEGACY_TABLE)
        await raw.exec("INSERT INTO kanban_terminals VALUES ('l1', '{}', 'comment', 5)")
        expect(await columns(raw)).not.toContain('attemptedat')
      },
      async (raw) => {
        expect(await columns(raw)).toEqual(expect.arrayContaining(RETRY_COLUMNS))
        expect(
          await select(
            raw,
            'SELECT leaseid, attempts, attempted, attemptedat, lookupmisses, nextat FROM kanban_terminals'
          )
        ).toEqual([{ leaseid: 'l1', attempts: 0, attempted: 0, attemptedat: null, lookupmisses: 0, nextat: 0 }])
        expect(await schemaVersion(raw)).toBe(SCHEMA_VERSION)
      }
    )
  })

  it('completes a table that already has some retry columns without touching their values', async () => {
    await upgradeFrom(
      58,
      async (raw) => {
        await raw.exec(`DROP TABLE IF EXISTS kanban_terminals;
          CREATE TABLE kanban_terminals (leaseId TEXT PRIMARY KEY, entry TEXT NOT NULL, state TEXT NOT NULL,
            attempts BIGINT NOT NULL DEFAULT 0, attempted BIGINT NOT NULL DEFAULT 0, nextAt BIGINT NOT NULL DEFAULT 0, recordedAt BIGINT NOT NULL)`)
        await raw.exec("INSERT INTO kanban_terminals VALUES ('p', '{}', 'comment', 3, 1, 77, 5)")
      },
      async (raw) => {
        expect(
          await select(raw, 'SELECT attempts, attempted, attemptedat, lookupmisses, nextat FROM kanban_terminals')
        ).toEqual([{ attempts: 3, attempted: 1, attemptedat: null, lookupmisses: 0, nextat: 77 }])
      }
    )
  })

  it('clears only attemptedAt on a v59 store', async () => {
    await upgradeFrom(
      59,
      async (raw) => {
        await raw.exec(`INSERT INTO kanban_terminals (leaseId, entry, state, attempts, attempted, attemptedAt, lookupMisses, nextAt, recordedAt)
          VALUES ('a', '{}', 'comment', 3, 1, ${EPOCH_MS}, 2, 99, 5), ('b', '{}', 'held', 0, 0, NULL, 0, 0, 6)`)
      },
      async (raw) => {
        expect(
          await select(
            raw,
            'SELECT leaseid, state, attempts, attempted, attemptedat, lookupmisses, nextat FROM kanban_terminals ORDER BY leaseid'
          )
        ).toEqual([
          { leaseid: 'a', state: 'comment', attempts: 3, attempted: 1, attemptedat: null, lookupmisses: 2, nextat: 99 },
          { leaseid: 'b', state: 'held', attempts: 0, attempted: 0, attemptedat: null, lookupmisses: 0, nextat: 0 }
        ])
      }
    )
  })

  it('opens a stale-version store whose table already has every column, and clears attemptedAt', async () => {
    await upgradeFrom(
      58,
      async (raw) => {
        await raw.exec(
          `INSERT INTO kanban_terminals (leaseId, entry, state, attempted, attemptedAt, recordedAt) VALUES ('h', '{}', 'comment', 1, ${EPOCH_MS}, 5)`
        )
      },
      async (raw) => {
        expect(await select(raw, "SELECT attemptedat FROM kanban_terminals WHERE leaseid = 'h'")).toEqual([
          { attemptedat: null }
        ])
      }
    )
  })

  it('creates the table when a v58 store has none', async () => {
    await upgradeFrom(
      58,
      async (raw) => {
        await raw.exec('DROP TABLE IF EXISTS kanban_terminals')
      },
      async (raw) => {
        expect(await columns(raw)).toEqual(expect.arrayContaining(RETRY_COLUMNS))
      }
    )
  })

  it('does not clear a GitHub-clock attemptedAt when an already-migrated store reopens', async () => {
    await upgradeFrom(
      SCHEMA_VERSION,
      async (raw) => {
        await raw.exec(
          `INSERT INTO kanban_terminals (leaseId, entry, state, attempted, attemptedAt, recordedAt) VALUES ('l3', '{}', 'comment', 1, ${EPOCH_MS}, 5)`
        )
      },
      async (raw) => {
        expect(await select(raw, "SELECT attemptedat FROM kanban_terminals WHERE leaseid = 'l3'")).toEqual([
          { attemptedat: EPOCH_MS }
        ])
        expect(await schemaVersion(raw)).toBe(SCHEMA_VERSION)
      }
    )
  })
})
