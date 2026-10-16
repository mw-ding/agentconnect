// Migrate and seed TEST_DATABASE_URL (local Postgres) or one Testcontainer, then clone a database per worker.
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { execa } from 'execa'
import type { ProvidedContext } from 'vitest'
import { integrationTestWorkerCount } from './integration-workers.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const schemaPath = resolve(packageRoot, 'prisma/schema.prisma')
const seedEntry = resolve(packageRoot, 'prisma/seed.ts')

let container: StartedPostgreSqlContainer | undefined

// Vitest 4 supplies a TestProject; only its provide method is needed here.
interface GlobalSetupContext {
  provide<K extends keyof ProvidedContext & string>(key: K, value: ProvidedContext[K]): void
}

const localWorkerDatabases: string[] = []
let localBaseUrl: string | undefined

function workerDatabaseName(poolId: number): string {
  return localBaseUrl ? `kanban_test_${process.pid}_${poolId}` : `test_worker_${poolId}`
}

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

async function cloneWorkerDatabases(baseUrl: string, workers: number): Promise<string[]> {
  if (!container && !localBaseUrl) throw new Error('Postgres is not running')

  const urls: string[] = []
  for (let poolId = 1; poolId <= workers; poolId += 1) {
    const database = workerDatabaseName(poolId)
    const template = new URL(baseUrl).pathname.slice(1)
    const sql = `CREATE DATABASE "${database}" WITH TEMPLATE "${template.replaceAll('"', '""')}"`
    if (container) {
      const result = await container.exec([
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        container.getUsername(),
        '-d',
        'postgres',
        '-c',
        sql
      ])
      if (result.exitCode !== 0) throw new Error(`failed to create ${database}: ${result.output}`)
    } else {
      await execa('psql', [databaseUrl(baseUrl, 'postgres'), '-v', 'ON_ERROR_STOP=1', '-c', sql])
      localWorkerDatabases.push(database)
    }
    urls.push(databaseUrl(baseUrl, database))
  }
  return urls
}

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  localBaseUrl = process.env.TEST_DATABASE_URL
  if (!localBaseUrl) container = await new PostgreSqlContainer('postgres:16-alpine').start()
  const url = localBaseUrl ?? container!.getConnectionUri()

  // Apply committed migrations (the hand-edited SQL included) to real Postgres.
  await execa('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', schemaPath], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit'
  })

  // Seed FK anchors with source exports, matching Vitest's development conditions.
  await execa('pnpm', ['exec', 'tsx', '--conditions', 'development', seedEntry], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit'
  })

  // Each worker gets a private clone so concurrent truncation cannot corrupt another test.
  const databaseUrls = await cloneWorkerDatabases(url, integrationTestWorkerCount())
  provide('databaseUrls', databaseUrls)
}

export async function teardown(): Promise<void> {
  if (localBaseUrl) {
    for (const database of localWorkerDatabases) {
      await execa('psql', [
        databaseUrl(localBaseUrl, 'postgres'),
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `DROP DATABASE "${database}" WITH (FORCE)`
      ])
    }
    localWorkerDatabases.length = 0
  }
  await container?.stop()
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrls: string[]
  }
}
