// Provision one disposable database per store worker, using local Postgres when TEST_DATABASE_URL is supplied.
import pg from 'pg'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { ProvidedContext } from 'vitest'
import { storePostgresWorkerCount } from './workers.js'

let container: StartedPostgreSqlContainer | undefined
let localAdmin: pg.Client | undefined
const localDatabases: string[] = []

// Vitest supplies the project context.
interface GlobalSetupContext {
  provide<K extends keyof ProvidedContext & string>(key: K, value: ProvidedContext[K]): void
}

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  const local = process.env.TEST_DATABASE_URL
  if (local) {
    localAdmin = new pg.Client({ connectionString: databaseUrl(local, 'postgres') })
    await localAdmin.connect()
  } else {
    container = await new PostgreSqlContainer('postgres:16-alpine').start()
  }
  const base = local ?? container!.getConnectionUri()
  const urls: string[] = []
  for (let poolId = 1; poolId <= storePostgresWorkerCount(); poolId += 1) {
    const database = local ? `store_test_${process.pid}_${poolId}` : `store_worker_${poolId}`
    if (localAdmin) {
      await localAdmin.query(`CREATE DATABASE "${database}"`)
      localDatabases.push(database)
      urls.push(databaseUrl(base, database))
      continue
    }
    const result = await container!.exec([
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      container!.getUsername(),
      '-d',
      'postgres',
      '-c',
      `CREATE DATABASE "${database}" OWNER "${container!.getUsername()}"`
    ])
    if (result.exitCode !== 0) throw new Error(`failed to create ${database}: ${result.output}`)
    urls.push(databaseUrl(base, database))
  }
  provide('storeDatabaseUrls', urls)
}

export async function teardown(): Promise<void> {
  try {
    for (const database of localDatabases.splice(0))
      await localAdmin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
  } finally {
    await localAdmin?.end()
    localAdmin = undefined
    await container?.stop()
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    storeDatabaseUrls: string[]
  }
}
