/**
 * PrismaClient singleton + `withTx` helper (design §2.4 / §3.13).
 *
 * This is the ONLY module outside `persistence/repositories/` that touches
 * `@prisma/client` construction. Services and edges never import Prisma — they
 * depend on the repository ports in `persistence/ports.ts`.
 *
 * `withTx` runs a callback inside a single interactive transaction so a fencing
 * counter bump (`sessionEpoch`/`routingEpoch`/per-agent `seq`) and the state
 * change it fences commit atomically (§3.13), closing the stale-double-serve
 * gap at the storage layer.
 */
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient, Prisma } from '../generated/prisma/client.js'

/** A client OR a transaction handle — repos accept either (so they compose under `withTx`). */
export type PrismaLike = PrismaClient | Prisma.TransactionClient

let singleton: PrismaClient | undefined

const TIMEZONE_OPTION = /(^|\s)(-c\s*|--)timezone=\S+/gi
const POSTGRES_URL = /^postgres(?:ql)?:\/\//i

/**
 * Pin the Postgres session timezone to UTC in a connection URL.
 *
 * `@prisma/adapter-pg` mis-reads `timestamptz` values under a non-UTC session:
 * it keeps the wall clock and labels it UTC, so `now()` and bound `Date`s drift by
 * the session's offset. A server or role default inherited from the host TZ would
 * silently shift lease, watch, and backoff clocks by hours. The pin goes in the
 * URL's `options` parameter because node-pg lets URL fields override pool config.
 * Other `options` flags are kept; any explicit timezone flag is replaced.
 *
 * The query string is edited as text, never through `new URL`, which rejects libpq-style
 * URLs with an empty host (`postgresql:///db?host=/var/run/postgresql`). Anything that is
 * not a postgres URL throws: an unpinned connection must never be a silent fallback.
 */
export function withUtcSession(databaseUrl: string | undefined): string | undefined {
  if (!databaseUrl) return databaseUrl
  if (!POSTGRES_URL.test(databaseUrl)) throw new Error('DATABASE_URL must be a postgres:// or postgresql:// URL')
  const hashAt = databaseUrl.indexOf('#')
  const fragment = hashAt === -1 ? '' : databaseUrl.slice(hashAt)
  const beforeFragment = hashAt === -1 ? databaseUrl : databaseUrl.slice(0, hashAt)
  const queryAt = beforeFragment.indexOf('?')
  const base = queryAt === -1 ? beforeFragment : beforeFragment.slice(0, queryAt)
  const kept: string[] = []
  const flags: string[] = []
  for (const pair of (queryAt === -1 ? '' : beforeFragment.slice(queryAt + 1)).split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const name = decodeQueryComponent(eq === -1 ? pair : pair.slice(0, eq))
    if (name !== 'options') {
      kept.push(pair)
      continue
    }
    const flag = decodeQueryComponent(eq === -1 ? '' : pair.slice(eq + 1))
      .replace(TIMEZONE_OPTION, ' ')
      .trim()
    if (flag) flags.push(flag)
  }
  flags.push('-c timezone=UTC')
  kept.push(`options=${encodeURIComponent(flags.join(' '))}`)
  return `${base}?${kept.join('&')}${fragment}`
}

function decodeQueryComponent(component: string): string {
  try {
    return decodeURIComponent(component.replace(/\+/g, ' '))
  } catch {
    throw new Error('DATABASE_URL has a malformed query string')
  }
}

/**
 * Build (or reuse) the process-wide PrismaClient for a given connection URL.
 *
 * v7 has no Rust query engine — queries run through the `@prisma/adapter-pg`
 * driver adapter, so the connection URL is handed to the adapter (not a
 * `datasources` override). `DATABASE_URL` falls back to the env when no explicit
 * URL is passed (the adapter reads `process.env.DATABASE_URL`).
 */
export function createPrisma(databaseUrl?: string, opts?: { poolMax?: number }): PrismaClient {
  if (singleton) return singleton
  const adapter = new PrismaPg({
    connectionString: withUtcSession(databaseUrl ?? process.env.DATABASE_URL),
    ...(opts?.poolMax ? { max: opts.poolMax } : {})
  })
  singleton = new PrismaClient({ adapter })
  return singleton
}

/** Run `fn` inside one interactive transaction (atomic fence + state change). */
export function withTx<T>(prisma: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn)
}

/**
 * Run `fn` atomically whether or not the caller already holds a transaction:
 * open one on a root client, COMPOSE under an ambient `TransactionClient`.
 *
 * Prisma has no nested transactions, so a helper that unconditionally called
 * `$transaction` would break every caller that already runs inside one. The
 * `'$transaction' in db` probe is the same discriminator the repositories use
 * (e.g. `PgAgentRepo.transaction`) — a `TransactionClient` deliberately omits
 * that method.
 *
 * Use this for multi-statement invariants that must be all-or-nothing even when
 * reached from a plain client (org creation writes the org, its membership, and
 * its preset agent + marker; a partial commit there is unrecoverable). Composing
 * means the OUTER transaction's boundary wins:
 * a rollback out there also undoes what `fn` wrote, which is the intent.
 */
export function withAmbientTx<T>(
  db: PrismaLike,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  /** Interactive-transaction budget, for a unit of work whose size is data-dependent and can
   *  outgrow Prisma's 5s default. Ignored when composing — the outer boundary owns the clock. */
  opts?: { timeout?: number; maxWait?: number }
): Promise<T> {
  if ('$transaction' in db) return (db as PrismaClient).$transaction(fn, opts)
  return fn(db as Prisma.TransactionClient)
}

/** Probe DB reachability with a trivial round-trip — backs the readiness probe
 *  (`/readyz`). Rejects when the connection is down. */
export async function pingDb(prisma: PrismaLike): Promise<void> {
  await prisma.$queryRaw`SELECT 1`
}

/** Disconnect the singleton (graceful shutdown / test teardown). */
export async function disconnectPrisma(): Promise<void> {
  await singleton?.$disconnect()
  singleton = undefined
}

export { PrismaClient, Prisma }
