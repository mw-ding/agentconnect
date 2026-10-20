// Kanban board view routes (issue #2 Lane 4b): card metadata from the CP, titles live from GitHub and never persisted.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { memberBearer, ownerBearer, startKanbanOidc, type KanbanOidc } from '../fixtures/kanban-oidc.js'
import { githubKanbanTitleSource } from '../../src/kanban/card-titles.js'
import { OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import type { GithubInstallationRecord } from '../../src/persistence/ports.js'

const BOARDS = `/api/v1/orgs/${DEFAULT_ORG_ID}/kanban/boards`
const OTHER_ORG = 'org-kanban-view-other'
const DAEMON = 'd6666666-6666-4666-8666-666666666666'
const AGENT = 'a6666666-6666-4666-8666-666666666666'
const REPO_ID = 4242n
const SECRET_TITLE = 'Rotate the prod DB password <script>alert(1)</script> **now**'

let oidc: KanbanOidc
beforeAll(async () => {
  oidc = await startKanbanOidc('kanban-view-test')
})
afterAll(() => oidc.close())

const installation: GithubInstallationRecord = {
  id: 'view-inst',
  orgId: OrgId(DEFAULT_ORG_ID),
  installationId: 11n,
  accountLogin: 'acme',
  accountType: 'Organization',
  permissions: { issues: 'read' },
  repositorySelection: 'selected',
  revokedAt: null,
  suspendedAt: null,
  createdAt: new Date(0)
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> }

/** A GitHub stand-in keyed by issue number; records every URL it was asked for. */
function githubStub(replies: Record<number, Reply>) {
  const urls: string[] = []
  const fetchImpl = vi.fn(async (url: string) => {
    urls.push(url)
    const n = Number(/\/issues\/(\d+)$/.exec(url)?.[1])
    const reply = replies[n] ?? { status: 404, body: { message: 'Not Found' } }
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: reply.headers })
  })
  return { fetchImpl, urls }
}

const issue = (number: number, title = `title ${number}`, extra: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: {
    number,
    title,
    state: 'open',
    html_url: `https://github.com/acme/web/issues/${number}`,
    repository_url: 'https://api.github.com/repos/acme/web',
    ...extra
  }
})

function buildApp(fetchImpl?: (url: string) => Promise<Response>, withTitles = true) {
  const mint = vi.fn(async () => ({ token: 'ghs_read_token' }))
  const kanbanTitles =
    withTitles && fetchImpl
      ? githubKanbanTitleSource({
          installations: { liveByOrgAndAccount: async () => installation },
          tokens: { mintKanbanCard: mint } as never,
          fetchImpl: fetchImpl as never
        })
      : undefined
  const http = buildHttpApp(prisma, { OIDC_ISSUER: oidc.issuer, OIDC_AUDIENCE: oidc.audience }, undefined, undefined, {
    ...(kanbanTitles ? { kanbanTitles } : {})
  })
  return { ...http, mint }
}

async function seedBoard(
  data: { repoId?: bigint; orgId?: string; visibility?: 'org' | 'restricted'; sharedWith?: string[] } = {}
) {
  return prisma.kanbanBoard.create({
    data: {
      orgId: data.orgId ?? DEFAULT_ORG_ID,
      name: 'web',
      repoId: data.repoId ?? REPO_ID,
      repoFullName: 'acme/web',
      visibility: data.visibility ?? 'org',
      sharedWith: data.sharedWith ?? []
    }
  })
}

async function seedCard(boardId: string, n: number, data: Record<string, unknown> = {}) {
  return prisma.kanbanCard.create({ data: { boardId, issueId: BigInt(7000 + n), issueNumber: n, ...data } })
}

/** Every kanban_* and audit row as text, so a leaked title anywhere in the database is found. */
async function databaseText(): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<{ t: string }>>(`
    SELECT row_to_json(x)::text AS t FROM kanban_board x
    UNION ALL SELECT row_to_json(x)::text FROM kanban_card x
    UNION ALL SELECT row_to_json(x)::text FROM kanban_run x
    UNION ALL SELECT row_to_json(x)::text FROM audit_event x`)
  return rows.map((r) => r.t).join('\n')
}

describe('Kanban cards route', () => {
  it('lists metadata with effective mode, assignee names, counters and the open run — and no titles', async () => {
    await seedDaemon(prisma, DAEMON, { sessionEpoch: 1n })
    await seedAgent(prisma, AGENT, { daemonId: DAEMON, name: 'builder' })
    await prisma.agent.update({ where: { id: AGENT }, data: { displayName: 'Builder Bot' } })
    const board = await seedBoard()
    await prisma.kanbanBoard.update({ where: { id: board.id }, data: { defaultMode: 'write' } })
    const running = await seedCard(board.id, 1, { status: 'running', assigneeAgentId: AGENT, priority: 5 })
    await prisma.kanbanRun.create({
      data: {
        cardId: running.id,
        attempt: 1,
        agentId: AGENT,
        daemonId: DAEMON,
        leaseId: '11111111-1111-4111-8111-111111111111',
        dispatchRevision: 1n,
        dispatchedAt: new Date('2026-10-15T12:00:00Z'),
        heartbeatAt: new Date('2026-10-15T12:05:00Z')
      }
    })
    await seedCard(board.id, 2, {
      status: 'blocked',
      mode: 'read',
      needsAttention: true,
      attentionReason: 'promotion_unresolved',
      blockKind: 'needs_input',
      consecutiveFailures: 2,
      protocolViolations: 1,
      blockRecurrence: 3,
      cooldownUntil: new Date('2030-01-01T00:00:00Z')
    })
    const { app, close } = buildApp()
    try {
      const res = await app.inject({
        method: 'GET',
        url: `${BOARDS}/${board.id}/cards`,
        headers: await ownerBearer(prisma, oidc)
      })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body).toMatchObject({ boardId: board.id, total: 2, truncated: false })
      expect(body.cards[0]).toMatchObject({
        issueNumber: 1,
        status: 'running',
        assigneeAgentId: AGENT,
        assignee: { name: 'builder', displayName: 'Builder Bot' },
        mode: 'write',
        modeOverride: null,
        priority: 5,
        openRun: { attempt: 1, agentId: AGENT, heartbeatAt: '2026-10-15T12:05:00.000Z', ackedAt: null }
      })
      expect(body.cards[1]).toMatchObject({
        issueNumber: 2,
        assignee: null,
        mode: 'read',
        modeOverride: 'read',
        needsAttention: true,
        attentionReason: 'promotion_unresolved',
        blockKind: 'needs_input',
        consecutiveFailures: 2,
        protocolViolations: 1,
        blockRecurrence: 3,
        cooldownUntil: '2030-01-01T00:00:00.000Z',
        openRun: null
      })
      expect(JSON.stringify(body)).not.toContain('title')
    } finally {
      await close()
    }
  })

  it('vera-528: ?numbers= looks cards up by number without the 500-cap ambiguity', async () => {
    const board = await seedBoard()
    await seedCard(board.id, 1)
    await seedCard(board.id, 2)
    await seedCard(board.id, 3)
    const { app, close } = buildApp()
    try {
      const headers = await ownerBearer(prisma, oidc)
      const res = await app.inject({ method: 'GET', url: `${BOARDS}/${board.id}/cards?numbers=2,3`, headers })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ boardId: board.id, total: 2, truncated: false })
      expect(
        res
          .json()
          .cards.map((c: { issueNumber: number }) => c.issueNumber)
          .sort()
      ).toEqual([2, 3])
      const none = await app.inject({ method: 'GET', url: `${BOARDS}/${board.id}/cards?numbers=404`, headers })
      expect(none.json()).toMatchObject({ cards: [], total: 0, truncated: false })
      const bad = await app.inject({ method: 'GET', url: `${BOARDS}/${board.id}/cards?numbers=abc`, headers })
      expect(bad.statusCode).toBe(400)
      expect(bad.json()).toMatchObject({ code: 'invalid_numbers' })
    } finally {
      await close()
    }
  })

  it('vera-528 r2: ?numbers= caps at 500 distinct numbers, so a by-number lookup is never silently truncated', async () => {
    const board = await seedBoard()
    await prisma.kanbanCard.createMany({
      data: Array.from({ length: 501 }, (_, i) => ({
        boardId: board.id,
        issueId: BigInt(7000 + i + 1),
        issueNumber: i + 1
      }))
    })
    const { app, close } = buildApp()
    try {
      const headers = await ownerBearer(prisma, oidc)
      const list = (n: number) => Array.from({ length: n }, (_, i) => i + 1).join(',')
      const tooMany = await app.inject({
        method: 'GET',
        url: `${BOARDS}/${board.id}/cards?numbers=${list(501)}`,
        headers
      })
      expect(tooMany.statusCode).toBe(400)
      expect(tooMany.json()).toMatchObject({ code: 'too_many_numbers' })
      const full = await app.inject({ method: 'GET', url: `${BOARDS}/${board.id}/cards?numbers=${list(500)}`, headers })
      expect(full.statusCode).toBe(200)
      expect(full.json()).toMatchObject({ total: 500, truncated: false })
      expect(full.json().cards).toHaveLength(500)
      // Repeats count once: 500 distinct numbers spelled with duplicates still pass.
      const repeated = await app.inject({
        method: 'GET',
        url: `${BOARDS}/${board.id}/cards?numbers=${list(499)},1,1,500`,
        headers
      })
      expect(repeated.statusCode).toBe(200)
      expect(repeated.json()).toMatchObject({ total: 500, truncated: false })
    } finally {
      await close()
    }
  })

  it('works with GitHub unreachable: it never calls it', async () => {
    const board = await seedBoard()
    await seedCard(board.id, 1)
    const stub = githubStub({})
    const { app, close } = buildApp(stub.fetchImpl)
    try {
      const res = await app.inject({
        method: 'GET',
        url: `${BOARDS}/${board.id}/cards`,
        headers: await ownerBearer(prisma, oidc)
      })
      expect(res.statusCode).toBe(200)
      expect(stub.fetchImpl).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('applies the same visibility rules as the board: restricted, other org, missing → 404', async () => {
    const inside = await memberBearer(prisma, oidc, 'viewer', 'view-inside')
    const outside = await memberBearer(prisma, oidc, 'viewer', 'view-outside')
    const restricted = await seedBoard({ visibility: 'restricted', sharedWith: [inside.userId] })
    await prisma.org.create({ data: { id: OTHER_ORG, name: 'Other', slug: 'other-kanban-view' } })
    const foreign = await seedBoard({ repoId: 9n, orgId: OTHER_ORG })
    const { app, close } = buildApp()
    const get = async (id: string, headers: Record<string, string>) =>
      (await app.inject({ method: 'GET', url: `${BOARDS}/${id}/cards`, headers })).statusCode
    try {
      expect(await get(restricted.id, inside.headers)).toBe(200)
      expect(await get(restricted.id, outside.headers)).toBe(404)
      expect(await get(foreign.id, await ownerBearer(prisma, oidc))).toBe(404)
      expect(await get('00000000-0000-4000-8000-000000000000', outside.headers)).toBe(404)
      expect((await app.inject({ method: 'GET', url: `${BOARDS}/${restricted.id}/cards` })).statusCode).toBe(401)
    } finally {
      await close()
    }
  })
})

describe('Kanban titles route', () => {
  const titlesUrl = (boardId: string, numbers: string) => `${BOARDS}/${boardId}/cards/titles?numbers=${numbers}`

  it('reads titles live with a read-scoped repo token, sets no-store, and persists nothing', async () => {
    const board = await seedBoard()
    await seedCard(board.id, 1)
    await seedCard(board.id, 2)
    const stub = githubStub({ 1: issue(1, SECRET_TITLE), 2: issue(2, 'plain', { state: 'closed' }) })
    const { app, close, mint } = buildApp(stub.fetchImpl)
    const logged: unknown[] = []
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
      vi.spyOn(app.log, level).mockImplementation(((...args: unknown[]) => void logged.push(args)) as never)
    }
    const out = vi.spyOn(process.stdout, 'write')
    const err = vi.spyOn(process.stderr, 'write')
    try {
      const before = await databaseText()
      const res = await app.inject({
        method: 'GET',
        url: titlesUrl(board.id, '1,2'),
        headers: await ownerBearer(prisma, oidc)
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.json()).toEqual({
        titles: {
          '1': { title: SECRET_TITLE, state: 'open', htmlUrl: 'https://github.com/acme/web/issues/1' },
          '2': { title: 'plain', state: 'closed', htmlUrl: 'https://github.com/acme/web/issues/2' }
        },
        missing: []
      })
      expect(mint).toHaveBeenCalledTimes(1)
      expect(mint).toHaveBeenCalledWith(11n, 'acme/web', REPO_ID, 'read')
      expect(stub.urls.sort()).toEqual([
        expect.stringContaining(`/repositories/${REPO_ID}/issues/1`),
        expect.stringContaining(`/repositories/${REPO_ID}/issues/2`)
      ])
      // No title in the database, the logger, or the process output; nothing was written at all.
      expect(await databaseText()).toBe(before)
      expect(await databaseText()).not.toContain('Rotate the prod')
      expect(JSON.stringify(logged)).not.toContain('Rotate')
      const written = [...out.mock.calls, ...err.mock.calls].map((c) => String(c[0])).join('')
      expect(written).not.toContain('Rotate')
    } finally {
      vi.restoreAllMocks()
      await close()
    }
  })

  it('vera-528: a repeated titles view within TTL makes no second GitHub call', async () => {
    const board = await seedBoard()
    await seedCard(board.id, 1)
    await seedCard(board.id, 2)
    const stub = githubStub({ 1: issue(1), 2: issue(2) })
    const { app, close } = buildApp(stub.fetchImpl)
    try {
      const headers = await ownerBearer(prisma, oidc)
      const first = await app.inject({ method: 'GET', url: titlesUrl(board.id, '1,2'), headers })
      expect(first.statusCode).toBe(200)
      expect(stub.fetchImpl).toHaveBeenCalledTimes(2)
      const second = await app.inject({ method: 'GET', url: titlesUrl(board.id, '2,1'), headers })
      expect(second.statusCode).toBe(200)
      expect(second.json()).toEqual(first.json())
      expect(stub.fetchImpl).toHaveBeenCalledTimes(2)
    } finally {
      await close()
    }
  })

  it('returns numbers that are not cards of this board in missing, without asking GitHub', async () => {
    const board = await seedBoard()
    await seedCard(board.id, 1)
    const other = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'api', repoId: 4343n, repoFullName: 'acme/api' }
    })
    await seedCard(other.id, 77)
    const stub = githubStub({ 1: issue(1), 77: issue(77, 'secret of another board') })
    const { app, close } = buildApp(stub.fetchImpl)
    try {
      const res = await app.inject({
        method: 'GET',
        url: titlesUrl(board.id, '77,1,999,1'),
        headers: await ownerBearer(prisma, oidc)
      })
      expect(res.json()).toEqual({
        titles: { '1': { title: 'title 1', state: 'open', htmlUrl: 'https://github.com/acme/web/issues/1' } },
        missing: [77, 999]
      })
      expect(stub.urls).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('reports an issue GitHub no longer serves, a pull request, and a redirected number as missing', async () => {
    const board = await seedBoard()
    for (const n of [1, 2, 3, 4, 5]) await seedCard(board.id, n)
    const stub = githubStub({
      1: { status: 404 },
      2: { status: 410 },
      3: issue(3, 'a pr', { pull_request: {} }),
      4: issue(6, 'a body for another issue'),
      5: {
        status: 301,
        body: { message: 'Moved Permanently', url: 'https://api.github.com/repositories/9999/issues/1' },
        headers: { location: 'https://api.github.com/repositories/9999/issues/1' }
      }
    })
    const { app, close } = buildApp(stub.fetchImpl)
    try {
      const res = await app.inject({
        method: 'GET',
        url: titlesUrl(board.id, '1,2,3,4,5'),
        headers: await ownerBearer(prisma, oidc)
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ titles: {}, missing: [1, 2, 3, 4, 5] })
      // The 301 was not followed: one read per number, none at the redirect target.
      expect(stub.urls).toHaveLength(5)
      expect(stub.urls.some((u) => u.includes('/repositories/9999/'))).toBe(false)
    } finally {
      await close()
    }
  })

  it.each([
    ['', 'a'],
    ['0', '0'],
    ['1,,2', '1,,2'],
    ['-1', '-1'],
    ['1.5', '1.5'],
    ['99999999999', '99999999999']
  ])('rejects malformed numbers %j with 400 invalid_numbers', async (_label, numbers) => {
    const board = await seedBoard()
    const { app, close } = buildApp(githubStub({}).fetchImpl)
    try {
      const res = await app.inject({
        method: 'GET',
        url: titlesUrl(board.id, numbers),
        headers: await ownerBearer(prisma, oidc)
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await close()
    }
  })

  it('rejects more than 100 numbers with 400 too_many_numbers and accepts exactly 100', async () => {
    const board = await seedBoard()
    const stub = githubStub({})
    const { app, close } = buildApp(stub.fetchImpl)
    const headers = await ownerBearer(prisma, oidc)
    try {
      const list = (n: number) => Array.from({ length: n }, (_, i) => i + 1).join(',')
      const tooMany = await app.inject({ method: 'GET', url: titlesUrl(board.id, list(101)), headers })
      expect(tooMany.statusCode).toBe(400)
      expect(tooMany.json()).toMatchObject({ code: 'too_many_numbers' })
      expect((await app.inject({ method: 'GET', url: titlesUrl(board.id, list(100)), headers })).statusCode).toBe(200)
      expect(stub.fetchImpl).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it.each([
    [
      'rate limited',
      { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999' } },
      429,
      'github_rate_limited'
    ],
    ['429', { status: 429 }, 429, 'github_rate_limited'],
    ['5xx', { status: 503 }, 502, 'github_unavailable'],
    ['bad credentials', { status: 401, body: { message: 'Bad credentials ghs_secret' } }, 502, 'github_unavailable']
  ] as Array<[string, Reply, number, string]>)(
    'maps GitHub %s to %s %s without leaking its text',
    async (_n, reply, status, code) => {
      const board = await seedBoard()
      await seedCard(board.id, 1)
      const { app, close } = buildApp(githubStub({ 1: reply }).fetchImpl)
      try {
        const res = await app.inject({
          method: 'GET',
          url: titlesUrl(board.id, '1'),
          headers: await ownerBearer(prisma, oidc)
        })
        expect(res.statusCode).toBe(status)
        expect(res.json()).toMatchObject({ code })
        expect(res.headers['cache-control']).toBe('no-store')
        expect(res.body).not.toContain('ghs_secret')
      } finally {
        await close()
      }
    }
  )

  it('answers 409 github_app_not_configured with no GitHub source, and the cards route still works', async () => {
    const board = await seedBoard()
    await seedCard(board.id, 1)
    const { app, close } = buildApp(undefined, false)
    const headers = await ownerBearer(prisma, oidc)
    try {
      const res = await app.inject({ method: 'GET', url: titlesUrl(board.id, '1'), headers })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'github_app_not_configured' })
      expect((await app.inject({ method: 'GET', url: `${BOARDS}/${board.id}/cards`, headers })).statusCode).toBe(200)
    } finally {
      await close()
    }
  })

  it('gates on board visibility: member 200, outside restricted 404, other org 404, anonymous 401', async () => {
    const inside = await memberBearer(prisma, oidc, 'viewer', 'titles-inside')
    const outside = await memberBearer(prisma, oidc, 'viewer', 'titles-outside')
    const board = await seedBoard({ visibility: 'restricted', sharedWith: [inside.userId] })
    await seedCard(board.id, 1)
    await prisma.org.create({ data: { id: OTHER_ORG, name: 'Other', slug: 'other-kanban-view' } })
    const foreign = await seedBoard({ repoId: 9n, orgId: OTHER_ORG })
    const stub = githubStub({ 1: issue(1) })
    const { app, close } = buildApp(stub.fetchImpl)
    const get = async (id: string, headers?: Record<string, string>) =>
      (await app.inject({ method: 'GET', url: titlesUrl(id, '1'), ...(headers ? { headers } : {}) })).statusCode
    try {
      expect(await get(board.id, inside.headers)).toBe(200)
      const callsAfterInside = stub.fetchImpl.mock.calls.length
      expect(await get(board.id, outside.headers)).toBe(404)
      expect(await get(foreign.id, await ownerBearer(prisma, oidc))).toBe(404)
      expect(await get(board.id)).toBe(401)
      expect(stub.fetchImpl.mock.calls.length).toBe(callsAfterInside)
    } finally {
      await close()
    }
  })
})
