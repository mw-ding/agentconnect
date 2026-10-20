// Kanban dry-run explain routes (issue #2 Lane 4b): viewer-readable, body-free, and free of side effects.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, TEST_API_KEY_PEPPER } from '../fakes/build-http.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { bearer, memberBearer, ownerBearer, startKanbanOidc, type KanbanOidc } from '../fixtures/kanban-oidc.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const BOARDS = `/api/v1/orgs/${DEFAULT_ORG_ID}/kanban/boards`
const OTHER_ORG = 'org-kanban-explain-other'
const DAEMON = 'd6666666-6666-4666-8666-666666666666'
const AGENT = 'a6666666-6666-4666-8666-666666666666'

let oidc: KanbanOidc
beforeAll(async () => {
  oidc = await startKanbanOidc('kanban-explain-test')
})
afterAll(() => oidc.close())

function buildApp(live = true, maxPerDaemon?: number) {
  const resolver = { resolve: vi.fn() }
  const http = buildHttpApp(
    prisma,
    { OIDC_ISSUER: oidc.issuer, OIDC_AUDIENCE: oidc.audience, KANBAN_MAX_IN_PROGRESS_PER_DAEMON: maxPerDaemon },
    { get: () => (live ? { state: 'READY' } : undefined) } as never,
    undefined,
    { kanbanRepoResolver: resolver as never }
  )
  return { ...http, resolver }
}

async function mintUserKey(userId: string) {
  const minted = new ApiKeyCodec({ API_KEY_PEPPER: TEST_API_KEY_PEPPER }).mint()
  await prisma.apiKey.create({
    data: { principalType: 'user', userId, orgId: DEFAULT_ORG_ID, hash: minted.hash, displayTail: minted.displayTail }
  })
  return bearer(minted.token)
}

async function seedBoard(data: {
  repoId: bigint
  orgId?: string
  visibility?: 'org' | 'restricted'
  sharedWith?: string[]
}) {
  return prisma.kanbanBoard.create({
    data: {
      orgId: data.orgId ?? DEFAULT_ORG_ID,
      name: `board-${data.repoId}`,
      repoId: data.repoId,
      repoFullName: `acme/r${data.repoId}`,
      visibility: data.visibility ?? 'org',
      sharedWith: data.sharedWith ?? [],
      maxInProgress: 2,
      maxInProgressPerAgent: 2
    }
  })
}

async function seedCard(boardId: string, n: number, data: Record<string, unknown> = {}) {
  return prisma.kanbanCard.create({
    data: { boardId, issueId: BigInt(5000 + n), issueNumber: n, status: 'ready', assigneeAgentId: AGENT, ...data }
  })
}

async function seedPlacedAgent() {
  await seedDaemon(prisma, DAEMON, { sessionEpoch: 1n })
  await seedAgent(prisma, AGENT, { daemonId: DAEMON })
}

const stateOf = async () => ({
  cards: await prisma.kanbanCard.findMany({ orderBy: { id: 'asc' } }),
  runs: await prisma.kanbanRun.count(),
  audit: await prisma.auditEvent.count()
})

describe('Kanban explain routes', () => {
  it('passes the configured daemon cap through to board and card explanations', async () => {
    await seedPlacedAgent()
    const board = await seedBoard({ repoId: 1n })
    const first = await seedCard(board.id, 1, { priority: 10 })
    const second = await seedCard(board.id, 2)
    const { app, close } = buildApp(true, 1)
    try {
      const headers = await ownerBearer(prisma, oidc)
      const boardRes = await app.inject({ method: 'GET', url: `${BOARDS}/${board.id}/explain`, headers })
      expect(boardRes.statusCode).toBe(200)
      expect(boardRes.json()).toMatchObject({ wouldClaimNext: [first.id] })
      expect(boardRes.json().cards.find((c: { cardId: string }) => c.cardId === second.id)).toMatchObject({
        capBound: 'daemon_cap',
        facts: { daemonCapacity: { openRunCount: 0, maxActive: 1 } }
      })
      const cardRes = await app.inject({
        method: 'GET',
        url: `${BOARDS}/${board.id}/cards/${second.id}/explain`,
        headers
      })
      expect(cardRes.statusCode).toBe(200)
      expect(cardRes.json()).toMatchObject({
        verdict: { eligible: true },
        capBound: 'daemon_cap',
        facts: { daemonCapacity: { openRunCount: 0, maxActive: 1 } }
      })
      // vera-528 r2: the single-card view replays the board's caps, so a cap-bound card is never "the next claim".
      expect(cardRes.json().claimOrder).toBeUndefined()
      expect(cardRes.json().hint).not.toContain('the next claim dispatches')
      expect(cardRes.json().hint).toContain('once the cards ahead of it are dispatched')
      const firstRes = await app.inject({
        method: 'GET',
        url: `${BOARDS}/${board.id}/cards/${first.id}/explain`,
        headers
      })
      expect(firstRes.json()).toMatchObject({
        claimOrder: 1,
        hint: `eligible: the next claim dispatches it to agent ${AGENT}`
      })
      expect(firstRes.json().capBound).toBeUndefined()
    } finally {
      await close()
    }
  })

  it('explains a board: gates, hints, facts, claim order, and nothing else changes', async () => {
    await seedPlacedAgent()
    const board = await seedBoard({ repoId: 1n })
    const free = await seedCard(board.id, 1)
    const cooling = await seedCard(board.id, 2, { cooldownUntil: new Date(Date.now() + 3_600_000) })
    const unassigned = await seedCard(board.id, 3, { assigneeAgentId: null })
    await seedCard(board.id, 4, { status: 'done' })
    const { app, close, resolver } = buildApp()
    const headers = await ownerBearer(prisma, oidc)
    try {
      const before = await stateOf()
      const res = await app.inject({ method: 'GET', url: `${BOARDS}/${board.id}/explain`, headers })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.wouldClaimNext).toEqual([free.id])
      expect(body.wouldClaimNextIssueNumbers).toEqual([1])
      expect(body.cards).toHaveLength(3)
      const byId = new Map<string, any>(body.cards.map((c: any) => [c.cardId, c]))
      expect(byId.get(free.id)).toMatchObject({
        issueNumber: 1,
        status: 'ready',
        verdict: { eligible: true, role: 'work', agentId: AGENT },
        claimOrder: 1
      })
      expect(byId.get(cooling.id)).toMatchObject({ verdict: { eligible: false, gate: 'cooldown' } })
      expect(byId.get(cooling.id).hint).toContain('cooling down until')
      expect(byId.get(unassigned.id)).toMatchObject({ verdict: { gate: 'no_assignee' } })
      expect(byId.get(free.id).facts).toMatchObject({ assigneeDaemonLive: true, openRunCount: 0, maxInProgress: 2 })
      expect(await stateOf()).toEqual(before)
      expect(resolver.resolve).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('reports daemon_offline when the connection registry has no live daemon', async () => {
    await seedPlacedAgent()
    const board = await seedBoard({ repoId: 1n })
    const c = await seedCard(board.id, 1)
    const { app, close } = buildApp(false)
    try {
      const res = await app.inject({
        method: 'GET',
        url: `${BOARDS}/${board.id}/cards/${c.id}/explain`,
        headers: await ownerBearer(prisma, oidc)
      })
      expect(res.json()).toMatchObject({ verdict: { eligible: false, gate: 'daemon_offline' }, cardId: c.id })
    } finally {
      await close()
    }
  })

  it('explains one card of any status and carries no title field', async () => {
    await seedPlacedAgent()
    const board = await seedBoard({ repoId: 1n })
    const done = await seedCard(board.id, 1, { status: 'done' })
    const { app, close } = buildApp()
    try {
      const res = await app.inject({
        method: 'GET',
        url: `${BOARDS}/${board.id}/cards/${done.id}/explain`,
        headers: await ownerBearer(prisma, oidc)
      })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body).toMatchObject({ status: 'done', verdict: { eligible: false, gate: 'status_not_claimable' } })
      expect(Object.keys(body)).not.toContain('title')
      expect(JSON.stringify(body)).not.toMatch(/title|body/i)
    } finally {
      await close()
    }
  })

  describe('authorization', () => {
    it('lets any org member read an org-visible board, including a viewer and the owner’s API key', async () => {
      await seedPlacedAgent()
      const board = await seedBoard({ repoId: 1n })
      const c = await seedCard(board.id, 1)
      const viewer = await memberBearer(prisma, oidc, 'viewer', 'explain-viewer')
      const { app, close } = buildApp()
      try {
        const urls = [`${BOARDS}/${board.id}/explain`, `${BOARDS}/${board.id}/cards/${c.id}/explain`]
        for (const headers of [viewer.headers, await mintUserKey(DEFAULT_OWNER_ID)]) {
          for (const url of urls) expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(200)
        }
      } finally {
        await close()
      }
    })

    it('hides a restricted board from a member outside its audience (404) and shows it inside', async () => {
      await seedPlacedAgent()
      const inside = await memberBearer(prisma, oidc, 'viewer', 'explain-inside')
      const outside = await memberBearer(prisma, oidc, 'viewer', 'explain-outside')
      const board = await seedBoard({ repoId: 1n, visibility: 'restricted', sharedWith: [inside.userId] })
      const c = await seedCard(board.id, 1)
      const { app, close } = buildApp()
      try {
        const urls = [`${BOARDS}/${board.id}/explain`, `${BOARDS}/${board.id}/cards/${c.id}/explain`]
        for (const url of urls) {
          expect((await app.inject({ method: 'GET', url, headers: inside.headers })).statusCode).toBe(200)
          expect((await app.inject({ method: 'GET', url, headers: outside.headers })).statusCode).toBe(404)
        }
      } finally {
        await close()
      }
    })

    it('answers 404 for another organization’s board, a missing board, and a card of another board', async () => {
      await seedPlacedAgent()
      await prisma.org.create({ data: { id: OTHER_ORG, name: 'Other', slug: 'other-kanban-explain' } })
      const foreign = await seedBoard({ repoId: 9n, orgId: OTHER_ORG })
      const foreignCard = await seedCard(foreign.id, 1, { assigneeAgentId: null })
      const mine = await seedBoard({ repoId: 1n })
      const { app, close } = buildApp()
      const headers = await ownerBearer(prisma, oidc)
      try {
        const get = async (url: string) => (await app.inject({ method: 'GET', url, headers })).statusCode
        expect(await get(`${BOARDS}/${foreign.id}/explain`)).toBe(404)
        expect(await get(`${BOARDS}/${foreign.id}/cards/${foreignCard.id}/explain`)).toBe(404)
        expect(await get(`${BOARDS}/00000000-0000-4000-8000-000000000000/explain`)).toBe(404)
        expect(await get(`${BOARDS}/${mine.id}/cards/${foreignCard.id}/explain`)).toBe(404)
        expect(await get(`${BOARDS}/${mine.id}/cards/00000000-0000-4000-8000-000000000000/explain`)).toBe(404)
      } finally {
        await close()
      }
    })

    it('answers 401 without credentials', async () => {
      const board = await seedBoard({ repoId: 1n })
      const { app, close } = buildApp()
      try {
        const res = await app.inject({ method: 'GET', url: `${BOARDS}/${board.id}/explain` })
        expect(res.statusCode).toBe(401)
      } finally {
        await close()
      }
    })

    it('vera-528: a daemon-principal key gets 401 on explain while a personal key gets 200', async () => {
      await seedPlacedAgent()
      const board = await seedBoard({ repoId: 1n })
      await seedCard(board.id, 1)
      // A daemon key in the exact stored shape: minted like the daemon plane mints, bound to the placed daemon.
      const codec = new ApiKeyCodec({ API_KEY_PEPPER: TEST_API_KEY_PEPPER })
      const daemonKey = codec.mint()
      await prisma.apiKey.create({
        data: {
          principalType: 'daemon',
          orgId: DEFAULT_ORG_ID,
          daemonId: DAEMON,
          hash: daemonKey.hash,
          displayTail: daemonKey.displayTail
        }
      })
      const { app, close } = buildApp()
      try {
        const url = `${BOARDS}/${board.id}/explain`
        expect((await app.inject({ method: 'GET', url, headers: bearer(daemonKey.token) })).statusCode).toBe(401)
        expect(
          (await app.inject({ method: 'GET', url, headers: await mintUserKey(DEFAULT_OWNER_ID) })).statusCode
        ).toBe(200)
      } finally {
        await close()
      }
    })

    it('rejects a malformed id before touching the database', async () => {
      const { app, close } = buildApp()
      try {
        const res = await app.inject({
          method: 'GET',
          url: `${BOARDS}/not-a-uuid/explain`,
          headers: await ownerBearer(prisma, oidc)
        })
        expect(res.statusCode).toBe(400)
      } finally {
        await close()
      }
    })
  })
})
