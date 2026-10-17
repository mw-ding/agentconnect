// The one-time Kanban migration-rename upgrade script is correct and idempotent.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'

const prismaDir = fileURLToPath(new URL('../../prisma/', import.meta.url))
const script = readFileSync(`${prismaDir}upgrade/2026-10-16-kanban-migration-rename.sql`, 'utf8')
// The DO block is the whole effect; psql's BEGIN/COMMIT wrap it in a transaction.
const doBlock = script.slice(script.indexOf('DO $$'), script.lastIndexOf('$$;') + 2)
const pairs = [...script.matchAll(/\('(\d{14}_kanban_\w+)', '(\d{14}_kanban_\w+)'\)/g)].map((m) => [m[1]!, m[2]!])
const SCHEMA = 'kanban_rename_test'

/** Run the script twice against a scratch `_prisma_migrations`, then roll everything back. */
async function namesAfterScript(rows: { name: string; finished: boolean }[]): Promise<string[]> {
  return prisma
    .$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA ${SCHEMA}`)
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO ${SCHEMA}`)
        await tx.$executeRawUnsafe(
          `CREATE TABLE _prisma_migrations (id text PRIMARY KEY, migration_name text NOT NULL, finished_at timestamptz)`
        )
        for (const [i, r] of rows.entries()) {
          await tx.$executeRawUnsafe(
            `INSERT INTO _prisma_migrations VALUES ($1, $2, ${r.finished ? 'now()' : 'NULL'})`,
            String(i),
            r.name
          )
        }
        await tx.$executeRawUnsafe(doBlock)
        await tx.$executeRawUnsafe(doBlock)
        const names = await tx.$queryRawUnsafe<{ migration_name: string }[]>(
          `SELECT migration_name FROM _prisma_migrations ORDER BY migration_name`
        )
        throw Object.assign(new Error('rollback'), { names: names.map((n) => n.migration_name) })
      },
      { timeout: 20_000 }
    )
    .catch((e: { names?: string[] }) => {
      if (!e.names) throw e
      return e.names
    })
}

describe('2026-10-16 Kanban migration rename', () => {
  it('maps every old fork migration to a shipped migration with the same suffix', () => {
    const shipped = new Set(readdirSync(`${prismaDir}migrations`))
    expect(pairs).toHaveLength(11)
    for (const [oldName, newName] of pairs) {
      expect(shipped.has(newName)).toBe(true)
      expect(shipped.has(oldName)).toBe(false)
      expect(oldName.slice(15)).toBe(newName.slice(15))
    }
  })

  it('renames old rows, clears failed new attempts, and is idempotent', async () => {
    const rows = [
      { name: '20261120000000_telegram_discord_session_audience', finished: true },
      ...pairs.map(([o]) => ({ name: o, finished: true })),
      { name: pairs[0]![1], finished: false }
    ]
    const names = await namesAfterScript(rows)
    expect(names).toEqual(['20261120000000_telegram_discord_session_audience', ...pairs.map(([, n]) => n)].sort())
  })

  it('is a no-op on a database that already has the new names', async () => {
    const fresh = pairs.map(([, n]) => ({ name: n, finished: true }))
    expect(await namesAfterScript(fresh)).toEqual(fresh.map((r) => r.name).sort())
  })
})
