// Kanban board CRUD routes (issue #2 M1): members read what visibility allows; only an interactive owner configures.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, TEST_API_KEY_PEPPER } from '../fakes/build-http.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { bearer, memberBearer, ownerBearer, startKanbanOidc, type KanbanOidc } from '../fixtures/kanban-oidc.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { PgKanbanOrchestratorRepo } from '../../src/persistence/repositories/kanban-orchestrator.repo.js'
import type { KanbanRepoResolution, KanbanRepoResolver } from '../../src/kanban/repo-resolver.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const BOARDS = `${ORG}/kanban/boards`
const OTHER_ORG = 'org-kanban-board-other'
const DAEMON = 'd6666666-6666-4666-8666-666666666666'
const AGENT = 'a6666666-6666-4666-8666-666666666666'
const FOREIGN_AGENT = 'a7777777-7777-4777-8777-777777777777'

let oidc: KanbanOidc
beforeAll(async () => {
  oidc = await startKanbanOidc('kanban-board-test')
})
afterAll(() => oidc.close())

/** Repos the fake installation covers: full name → GitHub id. */
const COVERED: Record<string, bigint> = { 'acme/web': 4242n, 'acme/api': 4343n, 'Acme/Docs': 4444n }

function fakeResolver(overrides: Record<string, KanbanRepoResolution> = {}) {
  const resolve = vi.fn(async (_orgId: string, repoFullName: string): Promise<KanbanRepoResolution> => {
    if (overrides[repoFullName]) return overrides[repoFullName]
    const hit = Object.entries(COVERED).find(([name]) => name.toLowerCase() === repoFullName.toLowerCase())
    return hit
      ? { ok: true, repoId: hit[1], repoFullName: hit[0], installationId: 77n }
      : { ok: false, status: 400, message: 'repository is not covered' }
  })
  return { resolve } satisfies KanbanRepoResolver
}

function buildApp(resolver = fakeResolver()) {
  const http = buildHttpApp(prisma, { OIDC_ISSUER: oidc.issuer, OIDC_AUDIENCE: oidc.audience }, undefined, undefined, {
    kanbanRepoResolver: resolver
  })
  return { ...http, resolver }
}

async function mintUserKey(userId: string) {
  const minted = new ApiKeyCodec({ API_KEY_PEPPER: TEST_API_KEY_PEPPER }).mint()
  await prisma.apiKey.create({
    data: { principalType: 'user', userId, orgId: DEFAULT_ORG_ID, hash: minted.hash, displayTail: minted.displayTail }
  })
  return bearer(minted.token)
}

async function seedBoardRow(data: {
  name: string
  repoId: bigint
  visibility?: 'org' | 'restricted'
  sharedWith?: string[]
  orgId?: string
}) {
  return prisma.kanbanBoard.create({
    data: {
      orgId: data.orgId ?? DEFAULT_ORG_ID,
      name: data.name,
      repoId: data.repoId,
      repoFullName: `acme/${data.name}`,
      visibility: data.visibility ?? 'org',
      sharedWith: data.sharedWith ?? []
    }
  })
}

async function seedOtherOrg() {
  await prisma.org.create({ data: { id: OTHER_ORG, name: 'Other', slug: 'other-kanban-board' } })
}

const boardAudit = () => prisma.auditEvent.findMany({ where: { kind: 'kanban_board_change' }, orderBy: { id: 'asc' } })

describe('Kanban board routes — an interactive owner', () => {
  it('creates a board whose repo id comes from the live resolver, never the request, and audits it', async () => {
    const { app, close, resolver } = buildApp()
    const headers = await ownerBearer(prisma, oidc)
    try {
      const res = await app.inject({
        method: 'POST',
        url: BOARDS,
        headers,
        payload: { name: 'web', repoFullName: 'acme/web', maxInProgress: 3 }
      })
      expect(res.statusCode).toBe(201)
      expect(resolver.resolve).toHaveBeenCalledWith(DEFAULT_ORG_ID, 'acme/web')
      const body = res.json()
      expect(body).toMatchObject({
        name: 'web',
        repoId: '4242',
        repoFullName: 'acme/web',
        maxInProgress: 3,
        defaultMode: 'read',
        enabled: true,
        visibility: 'org',
        configRevision: '1',
        createdBy: DEFAULT_OWNER_ID,
        canEdit: true
      })
      const audit = await boardAudit()
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({
        orgId: DEFAULT_ORG_ID,
        actorUserId: DEFAULT_OWNER_ID,
        details: { boardId: body.id, change: 'created', repoId: '4242' }
      })
    } finally {
      await close()
    }
  })

  it('takes the canonical repo name GitHub returns', async () => {
    const { app, close } = buildApp()
    const headers = await ownerBearer(prisma, oidc)
    try {
      const res = await app.inject({
        method: 'POST',
        url: BOARDS,
        headers,
        payload: { name: 'docs', repoFullName: 'acme/docs' }
      })
      expect(res.json()).toMatchObject({ repoFullName: 'Acme/Docs', repoId: '4444' })
    } finally {
      await close()
    }
  })

  it.each([
    [{ ok: false, status: 400, message: 'repository is not covered' }, 400, 'repo_not_covered'],
    [{ ok: false, status: 409, message: 'GitHub App is not configured' }, 409, 'github_app_not_configured'],
    [{ ok: false, status: 429, message: 'github: rate limited' }, 429, 'github_rate_limited'],
    [{ ok: false, status: 502, message: 'github: down' }, 502, 'github_unavailable']
  ] as Array<[KanbanRepoResolution, number, string]>)(
    'maps a resolver refusal %j to %s with a stable code and writes nothing',
    async (refusal, status, code) => {
      const { app, close } = buildApp(fakeResolver({ 'acme/web': refusal }))
      const headers = await ownerBearer(prisma, oidc)
      try {
        const res = await app.inject({
          method: 'POST',
          url: BOARDS,
          headers,
          payload: { name: 'web', repoFullName: 'acme/web' }
        })
        expect(res.statusCode).toBe(status)
        expect(res.json()).toMatchObject({ statusCode: status, code })
        expect(await prisma.kanbanBoard.count()).toBe(0)
        expect(await boardAudit()).toHaveLength(0)
      } finally {
        await close()
      }
    }
  )

  it('416c: validates synthesizer agents on create and update and accepts an org agent or null', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedOtherOrg()
    await seedAgent(prisma, FOREIGN_AGENT, { daemonId: DAEMON, orgId: OTHER_ORG })
    const { app, close } = buildApp()
    const headers = await ownerBearer(prisma, oidc)
    try {
      for (const synthesizerAgentId of [FOREIGN_AGENT, '00000000-0000-4000-8000-000000000000']) {
        const res = await app.inject({
          method: 'POST',
          url: BOARDS,
          headers,
          payload: { name: 'web', repoFullName: 'acme/web', synthesizerAgentId }
        })
        expect(res.statusCode).toBe(400)
        expect(res.json()).toMatchObject({ code: 'agent_not_in_org' })
      }
      const created = await app.inject({
        method: 'POST',
        url: BOARDS,
        headers,
        payload: { name: 'web', repoFullName: 'acme/web', synthesizerAgentId: AGENT }
      })
      expect(created.statusCode).toBe(201)
      expect(created.json()).toMatchObject({ synthesizerAgentId: AGENT })
      const url = `${BOARDS}/${created.json().id}`
      const refused = await app.inject({
        method: 'PATCH',
        url,
        headers,
        payload: { synthesizerAgentId: FOREIGN_AGENT }
      })
      expect(refused.statusCode).toBe(400)
      expect(refused.json()).toMatchObject({ code: 'agent_not_in_org' })
      expect(
        (await prisma.kanbanBoard.findUniqueOrThrow({ where: { id: created.json().id } })).synthesizerAgentId
      ).toBe(AGENT)
      const cleared = await app.inject({ method: 'PATCH', url, headers, payload: { synthesizerAgentId: null } })
      expect(cleared.statusCode).toBe(200)
      expect(cleared.json()).toMatchObject({ synthesizerAgentId: null })
    } finally {
      await close()
    }
  })

  it('refuses a second board for the same repository, a foreign agent, and an empty restricted audience', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedOtherOrg()
    await seedAgent(prisma, FOREIGN_AGENT, { daemonId: DAEMON, orgId: OTHER_ORG })
    const { app, close } = buildApp()
    const headers = await ownerBearer(prisma, oidc)
    try {
      const post = (payload: object) => app.inject({ method: 'POST', url: BOARDS, headers, payload })
      const refusal = async (payload: object) => {
        const res = await post(payload)
        return [res.statusCode, (res.json() as { code?: string }).code]
      }
      expect((await post({ name: 'web', repoFullName: 'acme/web' })).statusCode).toBe(201)
      expect(await refusal({ name: 'web2', repoFullName: 'acme/web' })).toEqual([409, 'repo_taken'])
      expect(await refusal({ name: 'api', repoFullName: 'acme/api', orchestratorAgentId: FOREIGN_AGENT })).toEqual([
        400,
        'agent_not_in_org'
      ])
      expect(await refusal({ name: 'api', repoFullName: 'acme/api', visibility: 'restricted' })).toEqual([
        400,
        'empty_audience'
      ])
      // A non-member id is dropped from the audience, which leaves it empty.
      expect(
        (await post({ name: 'api', repoFullName: 'acme/api', visibility: 'restricted', sharedWith: ['not-a-member'] }))
          .statusCode
      ).toBe(400)
      expect((await post({ name: 'api', repoFullName: 'not a repo' })).statusCode).toBe(400)
      expect((await post({ name: 'api', repoFullName: 'acme/api', defaultMode: 'write' })).statusCode).toBe(400)
      expect(await prisma.kanbanBoard.count()).toBe(1)
    } finally {
      await close()
    }
  })

  it('serializes concurrent creates for one repository to a single board', async () => {
    const { app, close } = buildApp()
    const headers = await ownerBearer(prisma, oidc)
    try {
      const results = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          app.inject({ method: 'POST', url: BOARDS, headers, payload: { name: `web-${i}`, repoFullName: 'acme/web' } })
        )
      )
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409, 409])
      expect(await prisma.kanbanBoard.count()).toBe(1)
    } finally {
      await close()
    }
  })

  it('updates configuration, bumps the revision, audits only changed fields, and skips a no-op', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const board = await seedBoardRow({ name: 'web', repoId: 4242n })
    const { app, close, resolver } = buildApp()
    const headers = await ownerBearer(prisma, oidc)
    const url = `${BOARDS}/${board.id}`
    try {
      const res = await app.inject({
        method: 'PATCH',
        url,
        headers,
        payload: { maxInProgress: 4, verifierAgentId: AGENT, name: 'web board' }
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        maxInProgress: 4,
        verifierAgentId: AGENT,
        name: 'web board',
        configRevision: '2'
      })
      expect(resolver.resolve).toHaveBeenCalledWith(DEFAULT_ORG_ID, 'acme/web')
      const noop = await app.inject({ method: 'PATCH', url, headers, payload: { maxInProgress: 4 } })
      expect(noop.json()).toMatchObject({ configRevision: '2' })
      const audit = await boardAudit()
      expect(audit).toHaveLength(1)
      expect(audit[0]!.details).toMatchObject({
        change: 'updated',
        fields: ['maxInProgress', 'name', 'verifierAgentId']
      })
      expect((await app.inject({ method: 'PATCH', url, headers, payload: {} })).statusCode).toBe(400)
      expect((await app.inject({ method: 'PATCH', url, headers, payload: { defaultMode: 'write' } })).statusCode).toBe(
        400
      )
    } finally {
      await close()
    }
  })

  it('sets, reads back, and bounds the B2 epic budgets; lowering below a count blocks only new creates', async () => {
    const { app, close } = buildApp()
    const headers = await ownerBearer(prisma, oidc)
    try {
      const plain = await app.inject({
        method: 'POST',
        url: BOARDS,
        headers,
        payload: { name: 'web', repoFullName: 'acme/web' }
      })
      expect(plain.json()).toMatchObject({ epicMaxCards: 100, epicMaxActive: 16 })
      const res = await app.inject({
        method: 'POST',
        url: BOARDS,
        headers,
        payload: { name: 'api', repoFullName: 'acme/api', epicMaxCards: 3, epicMaxActive: 2 }
      })
      expect(res.statusCode).toBe(201)
      const id = res.json().id as string
      const read = await app.inject({ method: 'GET', url: `${BOARDS}/${id}`, headers })
      expect(read.json()).toMatchObject({ epicMaxCards: 3, epicMaxActive: 2 })
      expect((await app.inject({ method: 'GET', url: BOARDS, headers })).json().boards).toEqual(
        expect.arrayContaining([expect.objectContaining({ id, epicMaxCards: 3, epicMaxActive: 2 })])
      )
      for (const bad of [
        { epicMaxCards: 0 },
        { epicMaxCards: -1 },
        { epicMaxCards: 1001 },
        { epicMaxCards: 2.5 },
        { epicMaxActive: 0 },
        { epicMaxActive: 101 }
      ]) {
        const create = await app.inject({
          method: 'POST',
          url: BOARDS,
          headers,
          payload: { name: 'docs', repoFullName: 'Acme/Docs', ...bad }
        })
        expect(create.statusCode, JSON.stringify(bad)).toBe(400)
        const patch = await app.inject({ method: 'PATCH', url: `${BOARDS}/${id}`, headers, payload: bad })
        expect(patch.statusCode, JSON.stringify(bad)).toBe(400)
      }
      // An epic that already filed two children; lowering maxCards to 1 is allowed and only blocks the next create.
      const epic = await prisma.kanbanCard.create({
        data: { boardId: id, issueId: 7_001n, issueNumber: 1, status: 'todo', epicCardsCreated: 2 }
      })
      const lowered = await app.inject({
        method: 'PATCH',
        url: `${BOARDS}/${id}`,
        headers,
        payload: { epicMaxCards: 1 }
      })
      expect(lowered.statusCode).toBe(200)
      expect(lowered.json()).toMatchObject({ epicMaxCards: 1, configRevision: '2' })
      const orchestrator = new PgKanbanOrchestratorRepo(prisma)
      const child = await orchestrator.createEpicChild({
        boardId: id,
        epicIssueNumber: 1,
        upsert: {
          boardId: id,
          expectedRepoId: 4343n,
          issueId: 7_002n,
          issueNumber: 2,
          idempotencyKey: 'lowered',
          status: 'todo',
          source: 'orchestrator'
        }
      })
      expect(child).toEqual({ ok: false, reason: 'epic_budget_exhausted' })
      expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: epic.id } })).epicCardsCreated).toBe(2)
      const audit = (await boardAudit()).at(-1)!
      expect(audit.details).toMatchObject({ change: 'updated', fields: ['epicMaxCards'] })
    } finally {
      await close()
    }
  })

  it('re-resolves a new repository and a re-enable, and refuses a re-enable whose repository changed', async () => {
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'web', repoId: 4242n, repoFullName: 'acme/web', enabled: false }
    })
    const { app, close, resolver } = buildApp()
    const headers = await ownerBearer(prisma, oidc)
    const url = `${BOARDS}/${board.id}`
    try {
      const moved = await app.inject({ method: 'PATCH', url, headers, payload: { repoFullName: 'acme/api' } })
      expect(moved.json()).toMatchObject({ repoId: '4343', repoFullName: 'acme/api', enabled: false })
      const uncovered = await app.inject({ method: 'PATCH', url, headers, payload: { repoFullName: 'acme/nope' } })
      expect(uncovered.statusCode).toBe(400)
      resolver.resolve.mockClear()
      const enabled = await app.inject({ method: 'PATCH', url, headers, payload: { enabled: true } })
      expect(enabled.statusCode).toBe(200)
      expect(resolver.resolve).toHaveBeenCalledWith(DEFAULT_ORG_ID, 'acme/api')
      await prisma.kanbanBoard.update({ where: { id: board.id }, data: { enabled: false } })
      resolver.resolve.mockResolvedValueOnce({ ok: true, repoId: 9999n, repoFullName: 'acme/api', installationId: 77n })
      const changed = await app.inject({ method: 'PATCH', url, headers, payload: { enabled: true } })
      expect(changed.statusCode).toBe(409)
      expect(changed.json()).toMatchObject({ code: 'repo_changed' })
      expect((await prisma.kanbanBoard.findUniqueOrThrow({ where: { id: board.id } })).enabled).toBe(false)
    } finally {
      await close()
    }
  })

  it('refuses to retarget existing cards to another repository but permits a repository rename', async () => {
    const board = await seedBoardRow({ name: 'web', repoId: 4242n })
    await prisma.kanbanCard.create({ data: { boardId: board.id, issueId: 1n, issueNumber: 1 } })
    const { app, close, resolver } = buildApp()
    const headers = await ownerBearer(prisma, oidc)
    try {
      const url = `${BOARDS}/${board.id}`
      const retarget = await app.inject({ method: 'PATCH', url, headers, payload: { repoFullName: 'acme/api' } })
      expect(retarget.statusCode).toBe(409)
      expect(retarget.json()).toMatchObject({ code: 'repo_has_cards' })
      resolver.resolve.mockResolvedValueOnce({
        ok: true,
        repoId: 4242n,
        repoFullName: 'acme/renamed',
        installationId: 77n
      })
      expect(
        (await app.inject({ method: 'PATCH', url, headers, payload: { repoFullName: 'acme/renamed' } })).statusCode
      ).toBe(200)
      expect((await prisma.kanbanBoard.findUniqueOrThrow({ where: { id: board.id } })).repoId).toBe(4242n)
    } finally {
      await close()
    }
  })

  it('deletes a board and its cards, refusing while a card holds an open lease', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const board = await seedBoardRow({ name: 'web', repoId: 4242n })
    const card = await prisma.kanbanCard.create({
      data: { boardId: board.id, issueId: 1n, issueNumber: 1, status: 'running' }
    })
    const run = await prisma.kanbanRun.create({
      data: {
        cardId: card.id,
        attempt: 1,
        agentId: AGENT,
        daemonId: DAEMON,
        leaseId: 'e1111111-1111-4111-8111-111111111111',
        dispatchRevision: 1n,
        dispatchedAt: new Date()
      }
    })
    const { app, close } = buildApp()
    const headers = await ownerBearer(prisma, oidc)
    const url = `${BOARDS}/${board.id}`
    try {
      const busy = await app.inject({ method: 'DELETE', url, headers })
      expect(busy.statusCode).toBe(409)
      expect(busy.json()).toMatchObject({ code: 'active_runs' })
      await prisma.kanbanRun.update({ where: { id: run.id }, data: { endedAt: new Date(), outcome: 'reclaimed' } })
      expect((await app.inject({ method: 'DELETE', url, headers })).statusCode).toBe(204)
      expect(await prisma.kanbanBoard.count()).toBe(0)
      expect(await prisma.kanbanCard.count()).toBe(0)
      expect((await boardAudit()).map((e) => (e.details as { change: string }).change)).toEqual(['deleted'])
      const gone = await app.inject({ method: 'DELETE', url, headers })
      expect(gone.statusCode).toBe(404)
      expect(gone.json()).toMatchObject({ code: 'not_found' })
      const missing = await app.inject({ method: 'PATCH', url, headers, payload: { maxInProgress: 2 } })
      expect(missing.json()).toMatchObject({ statusCode: 404, code: 'not_found' })
      const unseen = await app.inject({ method: 'GET', url, headers })
      expect(unseen.json()).toMatchObject({ statusCode: 404, code: 'not_found' })
    } finally {
      await close()
    }
  })
})

describe('Kanban board routes — visibility', () => {
  it('lists and reads boards by visibility and audience, and 404s what the caller cannot see', async () => {
    const { app, close } = buildApp()
    try {
      const owner = await ownerBearer(prisma, oidc)
      const collab = await memberBearer(prisma, oidc, 'collaborator', 'kanban-collab')
      const viewer = await memberBearer(prisma, oidc, 'viewer', 'kanban-viewer')
      const open = await seedBoardRow({ name: 'open', repoId: 1n })
      const shared = await seedBoardRow({
        name: 'shared',
        repoId: 2n,
        visibility: 'restricted',
        sharedWith: [collab.userId]
      })
      const hidden = await seedBoardRow({
        name: 'hidden',
        repoId: 3n,
        visibility: 'restricted',
        sharedWith: [DEFAULT_OWNER_ID]
      })
      await seedOtherOrg()
      const foreign = await seedBoardRow({ name: 'foreign', repoId: 4n, orgId: OTHER_ORG })

      const names = async (headers: Record<string, string>) =>
        (
          (await app.inject({ method: 'GET', url: BOARDS, headers })).json() as { boards: Array<{ name: string }> }
        ).boards.map((b) => b.name)
      expect(await names(owner)).toEqual(['open', 'shared', 'hidden'])
      expect(await names(collab.headers)).toEqual(['open', 'shared'])
      expect(await names(viewer.headers)).toEqual(['open'])

      const get = async (headers: Record<string, string>, id: string) =>
        (await app.inject({ method: 'GET', url: `${BOARDS}/${id}`, headers })).statusCode
      expect(await get(owner, hidden.id)).toBe(200)
      expect(await get(collab.headers, shared.id)).toBe(200)
      expect(await get(collab.headers, hidden.id)).toBe(404)
      expect(await get(viewer.headers, shared.id)).toBe(404)
      expect(await get(viewer.headers, open.id)).toBe(200)
      expect(await get(owner, foreign.id)).toBe(404)
      const read = await app.inject({ method: 'GET', url: `${BOARDS}/${open.id}`, headers: collab.headers })
      expect(read.json()).toMatchObject({ canEdit: false })
      // Reads are body-free metadata, so a personal API key may list boards too.
      expect(
        (await app.inject({ method: 'GET', url: BOARDS, headers: await mintUserKey(DEFAULT_OWNER_ID) })).statusCode
      ).toBe(200)
    } finally {
      await close()
    }
  })

  it('repairs a restricted board audience when its last explicit member leaves', async () => {
    const { userId } = await memberBearer(prisma, oidc, 'collaborator', 'kanban-departing')
    const board = await seedBoardRow({ name: 'web', repoId: 4242n, visibility: 'restricted', sharedWith: [userId] })
    await new PgUserRepo(prisma).removeMember(DEFAULT_ORG_ID, userId, DEFAULT_OWNER_ID)
    expect((await prisma.kanbanBoard.findUniqueOrThrow({ where: { id: board.id } })).sharedWith).toEqual([
      DEFAULT_OWNER_ID
    ])
  })

  it('restricting a board keeps the audience it already had', async () => {
    const { app, close } = buildApp()
    try {
      const owner = await ownerBearer(prisma, oidc)
      const collab = await memberBearer(prisma, oidc, 'collaborator', 'kanban-collab2')
      const board = await seedBoardRow({ name: 'web', repoId: 4242n, sharedWith: [collab.userId] })
      const res = await app.inject({
        method: 'PATCH',
        url: `${BOARDS}/${board.id}`,
        headers: owner,
        payload: { visibility: 'restricted' }
      })
      expect(res.json()).toMatchObject({ visibility: 'restricted', sharedWith: [collab.userId] })
      const empty = await app.inject({
        method: 'PATCH',
        url: `${BOARDS}/${board.id}`,
        headers: owner,
        payload: { sharedWith: [] }
      })
      expect(empty.statusCode).toBe(400)
    } finally {
      await close()
    }
  })
})

describe('Kanban board routes — every non-interactive or non-owner writer is refused', () => {
  async function expectWritesRefused(status: number, headers: Record<string, string>) {
    const board = await seedBoardRow({ name: 'web', repoId: 4242n })
    const { app, close, resolver } = buildApp()
    try {
      const res = [
        await app.inject({ method: 'POST', url: BOARDS, headers, payload: { name: 'api', repoFullName: 'acme/api' } }),
        // An invalid body still gets the auth refusal: the gate runs before validation.
        await app.inject({ method: 'POST', url: BOARDS, headers, payload: { bogus: true } }),
        await app.inject({ method: 'PATCH', url: `${BOARDS}/${board.id}`, headers, payload: { maxInProgress: 9 } }),
        await app.inject({ method: 'DELETE', url: `${BOARDS}/${board.id}`, headers })
      ]
      expect(res.map((r) => r.statusCode)).toEqual([status, status, status, status])
      expect(resolver.resolve).not.toHaveBeenCalled()
      expect(await prisma.kanbanBoard.findMany({ select: { id: true, maxInProgress: true } })).toEqual([
        { id: board.id, maxInProgress: 1 }
      ])
      expect(await boardAudit()).toHaveLength(0)
    } finally {
      await close()
    }
  }

  it('no credentials → 401', async () => {
    await expectWritesRefused(401, {})
  })

  it("the owner's personal API key → 403", async () => {
    await expectWritesRefused(403, await mintUserKey(DEFAULT_OWNER_ID))
  })

  it('an interactive collaborator → 403', async () => {
    const { headers } = await memberBearer(prisma, oidc, 'collaborator', 'kanban-collab3')
    await expectWritesRefused(403, headers)
  })

  it('an interactive viewer → 403', async () => {
    const { headers } = await memberBearer(prisma, oidc, 'viewer', 'kanban-viewer3')
    await expectWritesRefused(403, headers)
  })

  it('a non-member → 404', async () => {
    await new PgUserRepo(prisma).provisionOidcUser({
      oidcSubject: 'kanban-stranger',
      email: 'stranger@other.dev',
      emailVerified: true
    })
    await expectWritesRefused(404, bearer(await oidc.mintBearer('kanban-stranger', 'stranger@other.dev')))
  })

  it('an owner cannot reach another org’s board through their own org path', async () => {
    await seedOtherOrg()
    const foreign = await seedBoardRow({ name: 'foreign', repoId: 9n, orgId: OTHER_ORG })
    const { app, close } = buildApp()
    const headers = await ownerBearer(prisma, oidc)
    try {
      const url = `${BOARDS}/${foreign.id}`
      expect((await app.inject({ method: 'PATCH', url, headers, payload: { maxInProgress: 9 } })).statusCode).toBe(404)
      expect((await app.inject({ method: 'DELETE', url, headers })).statusCode).toBe(404)
      expect(await prisma.kanbanBoard.count({ where: { orgId: OTHER_ORG } })).toBe(1)
    } finally {
      await close()
    }
  })
})
