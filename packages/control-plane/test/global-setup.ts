// Migrate and seed TEST_DATABASE_URL (local Postgres) or one Testcontainer, then clone a database per worker.
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { execa } from 'execa'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../src/generated/prisma/client.js'
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

// TEST_DATABASE_URL path: no Docker; clone through Prisma's pg adapter on the maintenance database (the template must have no other sessions).
async function cloneWorkerDatabasesLocal(baseUrl: string, workers: number): Promise<string[]> {
  const templateDb = decodeURIComponent(new URL(baseUrl).pathname.slice(1))
  const admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl(baseUrl, 'postgres') }) })
  const urls: string[] = []
  try {
    for (let poolId = 1; poolId <= workers; poolId += 1) {
      const database = workerDatabaseName(poolId)
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
      await admin.$executeRawUnsafe(`CREATE DATABASE "${database}" WITH TEMPLATE "${templateDb.replaceAll('"', '""')}"`)
      localWorkerDatabases.push(database)
      urls.push(databaseUrl(baseUrl, database))
    }
  } finally {
    await admin.$disconnect()
  }
  return urls
}

async function cloneWorkerDatabases(baseUrl: string, workers: number): Promise<string[]> {
  if (!container) throw new Error('Postgres container is not running')

  const urls: string[] = []
  for (let poolId = 1; poolId <= workers; poolId += 1) {
    const database = workerDatabaseName(poolId)
    const template = decodeURIComponent(new URL(baseUrl).pathname.slice(1))
    const sql = `CREATE DATABASE "${database}" WITH TEMPLATE "${template.replaceAll('"', '""')}" OWNER "${container.getUsername().replaceAll('"', '""')}"`
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
    urls.push(databaseUrl(baseUrl, database))
  }
  return urls
}

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  localBaseUrl = process.env.TEST_DATABASE_URL
  let url: string
  if (localBaseUrl) {
    url = localBaseUrl
  } else {
    container = await new PostgreSqlContainer('postgres:16-alpine').start()
    url = container.getConnectionUri()
  }

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
  const workers = integrationTestWorkerCount()
  const databaseUrls = localBaseUrl
    ? await cloneWorkerDatabasesLocal(url, workers)
    : await cloneWorkerDatabases(url, workers)
  provide('databaseUrls', databaseUrls)
}

export async function teardown(): Promise<void> {
  if (localBaseUrl) {
    const admin = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl(localBaseUrl, 'postgres') })
    })
    try {
      for (const database of localWorkerDatabases) {
        await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
      }
    } finally {
      await admin.$disconnect()
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
