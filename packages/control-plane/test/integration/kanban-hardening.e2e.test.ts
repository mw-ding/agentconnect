// Live GitHub hardening checks; PAT minting, installation routing and failure injection are explicit seams.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import Fastify from 'fastify'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../../src/generated/prisma/client.js'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ORG_ID, openSeedClient, seed } from '../../prisma/seed.js'
import { OrgId } from '../../src/domain/ids.js'
import { GithubCardStore } from '../../src/kanban/card-store.js'
import { GithubRepoPermission } from '../../src/github/repo-permission.js'
import { KanbanDispatcher } from '../../src/kanban/dispatcher.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import { systemClock } from '../../src/domain/clock.js'
import { KanbanGraphDoorbell } from '../../src/kanban/graph-doorbell.js'
import { KanbanGraphReconciler } from '../../src/kanban/graph-reconciler.js'
import { PgKanbanBoardRepo, PgKanbanCardRepo } from '../../src/persistence/index.js'
import { createPrisma, disconnectPrisma } from '../../src/persistence/prisma.js'
import type { GithubInstallationRecord } from '../../src/persistence/ports.js'
import { runtimeHomeEnvironment } from '../../../daemon/src/runtimes/runtime-home.js'
import { LocalStore } from '../../../daemon/src/store/local-store.js'
import { KanbanCommentPublisher, kanbanLeaseMarker } from '../../../daemon/src/kanban/kanban-comments.js'
import { registerGithubIngress } from '../../../relay/src/hooks/github-ingress.js'
import { HookTable } from '../../../relay/src/hooks/hook-table.js'
import { HookRateLimiter } from '../../../relay/src/hooks/rate-limit.js'
import { postGithubWebhook } from '../fixtures/relay-link.js'
import { prisma } from '../setup.db.js'

const TOKEN = process.env.GITHUB_TOKEN
const FULL = 'mw-ding/agentconnect'
const REPO_ID = 1332342098n
const SECRET = 'hardening-e2e-webhook-secret'
const log = { debug: () => {}, info: console.log, warn: console.warn, error: console.error }
const clock = systemClock
const installation: GithubInstallationRecord = {
  id: 'hardening-e2e',
  orgId: OrgId(DEFAULT_ORG_ID),
  installationId: 1n,
  accountLogin: 'mw-ding',
  accountType: 'User',
  permissions: { issues: 'write' },
  repositorySelection: 'selected',
  suspendedAt: null,
  revokedAt: null,
  createdAt: new Date(0)
}
type Issue = { id: number; number: number; labels: Array<{ name: string }> }
async function gh<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28'
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status} ${text}`)
  return (text ? JSON.parse(text) : undefined) as T
}

describe.skipIf(!(process.env.KANBAN_E2E === '1' && process.env.GITHUB_TOKEN) || !!process.env.CI)(
  'kanban hardening e2e (live GitHub)',
  () => {
    const issues: number[] = []
    const boards: string[] = []
    const roots: string[] = []
    async function scratch(scenario: string, status = 'ready') {
      const issue = await gh<Issue>('POST', `/repos/${FULL}/issues`, {
        title: `[kanban-e2e] hardening ${scenario} ${Date.now()}`,
        labels: [`ac/status:${status}`]
      })
      issues.push(issue.number)
      console.log(`HARDENING issue ${scenario} #${issue.number}`)
      return issue
    }
    async function board(issue: Issue, db = prisma, status: 'triage' | 'running' = 'triage') {
      const b = await db.kanbanBoard.create({
        data: {
          orgId: DEFAULT_ORG_ID,
          name: `hardening ${Date.now()}`,
          repoId: REPO_ID,
          repoFullName: FULL
        }
      })
      boards.push(b.id)
      const card = await db.kanbanCard.create({
        data: { boardId: b.id, issueId: BigInt(issue.id), issueNumber: issue.number, status }
      })
      return { b, card }
    }
    function bell(db = prisma) {
      const store = new GithubCardStore({
        tokens: { mintKanbanCard: async () => ({ token: TOKEN! }) } as never,
        permissions: new GithubRepoPermission({
          tokens: { mintKanbanCard: async () => ({ token: TOKEN! }) } as never,
          ttlMs: 0
        })
      })
      const dispatcher = new KanbanDispatcher({
        repo: new PgKanbanDispatchRepo(db),
        store,
        installations: { liveByOrgAndAccount: async () => installation },
        send: async () => {
          throw new Error('no daemon in recovery test')
        },
        isDaemonLive: () => false,
        clock: systemClock,
        log
      })
      const reconciler = new KanbanGraphReconciler({
        agentSlug: async (orgId, id) =>
          (await db.agent.findFirst({ where: { orgId, id }, select: { name: true } }))?.name ?? null,
        cards: new PgKanbanCardRepo(db),
        store,
        log
      })
      return new KanbanGraphDoorbell({
        boards: new PgKanbanBoardRepo(db),
        installations: { getByInstallationId: async () => installation },
        store,
        onGraph: (b, repo, n, graph) => reconciler.apply(b, repo, n, graph),
        onCard: async (b, _repo, n) => {
          await dispatcher.onCardChanged(b.id, n, 'human')
        },
        log
      })
    }
    afterAll(async () => {
      const failures: unknown[] = []
      for (const n of issues) {
        try {
          await gh('PATCH', `/repos/${FULL}/issues/${n}`, { state: 'closed', state_reason: 'not_planned' })
        } catch (error) {
          failures.push(error)
        }
      }
      for (const id of boards)
        await prisma.kanbanBoard.deleteMany({ where: { id } }).catch((error) => failures.push(error))
      await disconnectPrisma()
      for (const root of roots) await rm(root, { recursive: true, force: true })
      console.log(`HARDENING cleanup issues=${issues.join(',')}`)
      if (failures.length) throw new AggregateError(failures, 'hardening cleanup failed')
    }, 120_000)

    it('1 env: real child receives no daemon secrets or agent token on a scratch card', async () => {
      const start = Date.now()
      const issue = await scratch('env')
      const { card } = await board(issue)
      const names = [
        'DATABASE_URL',
        'PGPASSWORD',
        'FOO_PASSWORD',
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'GITHUB_APP_PRIVATE_KEY_B64',
        'GITHUB_APP_WEBHOOK_SECRET',
        'RELAY_TOKEN',
        'GH_TOKEN',
        'GITHUB_TOKEN'
      ]
      const saved = { ...process.env }
      try {
        for (const name of names) process.env[name] = `planted-${name}`
        const env = runtimeHomeEnvironment('x', tmpdir(), { AC_AGENT_ID: card.id })
        const { stdout } = await promisify(execFile)(
          process.execPath,
          ['-e', 'console.log(JSON.stringify(process.env))'],
          { env, timeout: 15_000 }
        )
        const child = JSON.parse(stdout) as Record<string, string>
        for (const name of names) expect(child).not.toHaveProperty(name)
        expect(child.AC_AGENT_ID).toBe(card.id)
      } finally {
        for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
        Object.assign(process.env, saved)
      }
      console.log(`HARDENING result env issues=${issue.number} elapsed=${Date.now() - start}ms`)
    }, 60_000)

    it.each(['dropped-forward', 'pre-admission'] as const)(
      '2/3 relay: same GUID recovers %s',
      async (scenario) => {
        const start = Date.now()
        const issue = await scratch(scenario)
        const { b, card } = await board(issue)
        await prisma.kanbanRun.create({
          data: {
            cardId: card.id,
            attempt: 1,
            agentId: randomUUID(),
            daemonId: randomUUID(),
            leaseId: randomUUID(),
            dispatchRevision: 1n,
            dispatchedAt: new Date(),
            endedAt: new Date(),
            outcome: 'transient',
            reasonCode: 'github_state_mismatch'
          }
        })
        const graph = bell()
        const table = new HookTable()
        const hookId = randomUUID()
        if (scenario === 'pre-admission')
          table.upsert({
            hookId,
            kind: 'github',
            agentId: randomUUID(),
            daemonId: randomUUID(),
            configRevision: '1',
            dispatchRevision: '1',
            sessionMode: 'perThread',
            github: {
              repoId: String(REPO_ID),
              repoFullName: FULL,
              sessionKeyPrefix: FULL,
              events: ['issues:*'],
              labelFilter: [],
              mentionOnly: false,
              installationIds: ['1']
            }
          })
        let connected = false
        const reports: Array<{ status: string; reason?: string }> = []
        const forwarded: string[] = []
        const relay = Fastify()
        registerGithubIngress(relay, {
          table,
          daemons: () =>
            ({
              get: () => ({
                supports: () => true,
                sendMsg: async () => ({
                  msgId: 'e2e',
                  accepted: connected,
                  ...(connected ? {} : { reason: 'draining' })
                })
              })
            }) as never,
          report: (r) => reports.push(r),
          doorbell: () => connected,
          graphDoorbell: (p) => {
            if (!connected) return false
            forwarded.push(p.deliveryKey)
            graph.poke(p)
            return true
          },
          authorizeComment: async () => true,
          authorizeRerequest: async () => ({ allowed: false }),
          authzLimiter: new HookRateLimiter(clock),
          limiter: new HookRateLimiter(clock),
          clock,
          log,
          webhookSecret: () => SECRET
        })
        try {
          const url = `${await relay.listen({ port: 0, host: '127.0.0.1' })}/webhooks/github`
          const real = await gh<Issue>('GET', `/repos/${FULL}/issues/${issue.number}`)
          const store = new GithubCardStore({
            tokens: { mintKanbanCard: async () => ({ token: TOKEN! }) } as never,
            permissions: new GithubRepoPermission({
              tokens: { mintKanbanCard: async () => ({ token: TOKEN! }) } as never,
              ttlMs: 0
            })
          })
          await vi.waitFor(
            async () =>
              expect(
                await store.statusSetByHuman(
                  { installationId: 1n, repoId: REPO_ID, repoFullName: FULL },
                  issue.number,
                  'ready'
                )
              ).toBe(true),
            { timeout: 30_000, interval: 1_000 }
          )
          const request = {
            secret: SECRET,
            event: 'issues',
            deliveryId: randomUUID(),
            payload: {
              action: 'labeled',
              label: { name: 'ac/status:ready' },
              issue: real,
              repository: { id: Number(REPO_ID), full_name: FULL, owner: { login: 'mw-ding', type: 'User' } },
              installation: { id: 1 },
              sender: { login: 'mw-ding', type: 'User' }
            }
          }
          expect((await postGithubWebhook(url, request)).status).toBe(202)
          if (scenario === 'pre-admission')
            await vi.waitFor(() =>
              expect(reports).toContainEqual(expect.objectContaining({ status: 'failed', reason: 'rejected:draining' }))
            )
          expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe('triage')
          connected = true
          expect((await postGithubWebhook(url, request)).status).toBe(202)
          await graph.settle()
          expect(forwarded).toEqual([request.deliveryId])
          if (scenario === 'pre-admission')
            await vi.waitFor(() => expect(reports).toContainEqual(expect.objectContaining({ status: 'accepted' })))
          expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe('ready')
          console.log(
            `HARDENING result ${scenario} issues=${issue.number} board=${b.id} elapsed=${Date.now() - start}ms`
          )
        } finally {
          await relay.close()
          await graph.settle()
        }
      },
      90_000
    )

    it.each([
      ['migration', 0],
      ['clock-plus', 3_600_000],
      ['clock-minus', -3_600_000]
    ] as const)(
      '4/5 outbox: %s posts exactly one live marker',
      async (scenario, skew) => {
        const start = Date.now()
        const issue = await scratch(scenario)
        const root = await mkdtemp(join(tmpdir(), 'hardening-'))
        roots.push(root)
        const path = join(root, 'store.sqlite')
        await (await LocalStore.open(path)).close()
        if (scenario === 'migration') {
          const raw = new DatabaseSync(path)
          try {
            raw.exec(`DROP TABLE kanban_terminals;
            CREATE TABLE kanban_terminals (leaseId TEXT PRIMARY KEY, entry TEXT NOT NULL, state TEXT NOT NULL, recordedAt INTEGER NOT NULL);
            PRAGMA user_version = 58`)
          } finally {
            raw.close()
          }
        }
        const store = await LocalStore.open(path)
        const leaseId = randomUUID()
        let now = Date.now() + skew
        let lost = false
        let posts = 0
        const fetchImpl: typeof fetch = async (input, init) => {
          const response = await fetch(input, init)
          if (init?.method === 'POST') {
            posts++
            expect(response.ok).toBe(true)
            if (skew && !lost) {
              lost = true
              await response.text()
              throw new Error('injected lost POST response after GitHub committed')
            }
          }
          return response
        }
        try {
          expect(
            await store.recordKanbanTerminal(
              {
                report: {
                  boardId: randomUUID(),
                  cardId: randomUUID(),
                  agentId: randomUUID(),
                  leaseId,
                  attempt: 1,
                  dispatchRevision: '1',
                  outcome: 'completed'
                },
                repoFullName: FULL,
                issueNumber: issue.number,
                summary: `Hardening ${scenario}`
              },
              now
            )
          ).toBe(true)
          await store.settleKanbanTerminal(leaseId, true)
          const publisher = new KanbanCommentPublisher({
            store,
            clock: { now: () => now },
            log,
            token: async () => TOKEN!,
            fetchImpl
          })
          await publisher.drain()
          if (skew) expect(lost).toBe(true)
          now += 60_000
          await publisher.drain()
          await publisher.drain()
          const comments = await gh<Array<{ body: string }>>(
            'GET',
            `/repos/${FULL}/issues/${issue.number}/comments?per_page=100`
          )
          expect(comments.filter((c) => c.body.includes(kanbanLeaseMarker(leaseId)))).toHaveLength(1)
          expect(posts).toBe(1)
          expect(await store.dueKanbanComments(Number.MAX_SAFE_INTEGER, 10)).toEqual([])
          console.log(`HARDENING result ${scenario} issues=${issue.number} elapsed=${Date.now() - start}ms`)
        } finally {
          await store.close()
        }
      },
      90_000
    )

    it.each(['utc', 'seed'] as const)(
      '6/7 %s: empty-host UTC client promotes a live dependent',
      async (scenario) => {
        const start = Date.now()
        const blocker = await scratch(`${scenario}-blocker`, 'running')
        const dependent = await scratch(`${scenario}-dependent`, 'todo')
        await gh('POST', `/repos/${FULL}/issues/${dependent.number}/dependencies/blocked_by`, { issue_id: blocker.id })
        await disconnectPrisma()
        const unpinned = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) })
        try {
          const [rawTime] = await unpinned.$queryRaw<Array<{ tz: string }>>`SELECT current_setting('TimeZone') AS tz`
          expect(rawTime!.tz).toBe('America/Los_Angeles')
        } finally {
          await unpinned.$disconnect()
        }
        const url = new URL(process.env.DATABASE_URL!)
        const emptyHost = `${url.protocol}//${url.username}:${url.password}@${url.pathname}?host=${url.hostname}&port=${url.port || '5432'}`
        const db = scenario === 'seed' ? openSeedClient(emptyHost) : createPrisma(emptyHost)
        try {
          if (scenario === 'seed') await seed(db)
          const [time] = await db.$queryRaw<
            Array<{ tz: string; now: Date }>
          >`SELECT current_setting('TimeZone') AS tz, now() AS now`
          expect(time!.tz).toBe('UTC')
          expect(Math.abs(time!.now.getTime() - Date.now())).toBeLessThan(60_000)
          const { b } = await board(blocker, db, 'running')
          const card = await db.kanbanCard.create({
            data: { boardId: b.id, issueId: BigInt(dependent.id), issueNumber: dependent.number, status: 'todo' }
          })
          const dispatchRepo = new PgKanbanDispatchRepo(db)
          const deferredAt = new Date()
          await dispatchRepo.deferRecovery(card.id, deferredAt, 'hardening-timezone')
          const deferred = await db.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })
          expect(Math.abs(deferred.recoveryCheckAt!.getTime() - deferredAt.getTime() - 60_000)).toBeLessThan(1_000)
          expect(Math.abs(deferred.updatedAt.getTime() - Date.now())).toBeLessThan(60_000)
          await dispatchRepo.resetRecovery(b.id, dependent.number)
          const graph = bell(db)
          const poke = () =>
            graph.poke({
              deliveryKey: randomUUID(),
              installationId: '1',
              repoId: String(REPO_ID),
              event: 'issue_dependencies',
              action: 'blocked_by_added',
              ids: [],
              numbers: [dependent.number]
            })
          poke()
          await graph.settle()
          expect((await db.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe('todo')
          await gh('PATCH', `/repos/${FULL}/issues/${blocker.number}`, { state: 'closed', state_reason: 'completed' })
          await vi.waitFor(
            async () => {
              poke()
              await graph.settle()
              const row = await db.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })
              expect(row.status).toBe('ready')
              const [stamp] = await db.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`
              expect(Math.abs(stamp!.now.getTime() - Date.now())).toBeLessThan(60_000)
            },
            { timeout: 60_000, interval: 2_000 }
          )
          console.log(
            `HARDENING result ${scenario} issues=${blocker.number},${dependent.number} elapsed=${Date.now() - start}ms`
          )
        } finally {
          await disconnectPrisma()
        }
      },
      120_000
    )
  }
)
