// Kanban board Projects v2 projection config (issue #2 D1): org-only guard on create/PATCH, the pair CHECK, and the DTO round-trip.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { memberBearer, ownerBearer, startKanbanOidc, type KanbanOidc } from '../fixtures/kanban-oidc.js'
import type { KanbanRepoResolution, KanbanRepoResolver } from '../../src/kanban/repo-resolver.js'
import { githubKanbanProjectVerifier, type KanbanProjectVerifier } from '../../src/kanban/project-guard.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { kanbanProjectHook, KanbanProjectWriter, PROJECT_STATUS_OPTIONS } from '../../src/kanban/project-writer.js'
import type { KanbanStatus } from '../../src/kanban/card-state.js'
import { PgKanbanBoardRepo, PgKanbanCardRepo } from '../../src/persistence/repositories/kanban.repo.js'

const BOARDS = `/api/v1/orgs/${DEFAULT_ORG_ID}/kanban/boards`
const PROJECT = 'PVT_kwDOAbc'
const FIELD = 'PVTSSF_lADOAbc'

let oidc: KanbanOidc
beforeAll(async () => {
  oidc = await startKanbanOidc('kanban-projection-test')
})
afterAll(() => oidc.close())

const ORG_REPO: KanbanRepoResolution = {
  ok: true,
  repoId: 4242n,
  repoFullName: 'acme/web',
  installationId: 77n,
  ownerType: 'Organization'
}

function build(
  verify: KanbanProjectVerifier['verify'] = async () => ({ ok: true, options: [] }),
  resolution: KanbanRepoResolution = ORG_REPO,
  opts: { noVerifier?: boolean } = {}
) {
  const verifier = { verify: vi.fn(verify) } satisfies KanbanProjectVerifier
  const resolver = { resolve: vi.fn(async () => resolution) } satisfies KanbanRepoResolver
  const http = buildHttpApp(prisma, { OIDC_ISSUER: oidc.issuer, OIDC_AUDIENCE: oidc.audience }, undefined, undefined, {
    kanbanRepoResolver: resolver,
    ...(opts.noVerifier ? {} : { kanbanProjectVerifier: verifier })
  })
  return { ...http, verifier }
}

const withProject = { projectNodeId: PROJECT, statusFieldId: FIELD }

describe('board create with a Projects v2 projection', () => {
  it('stores and returns the pair after the guard accepts it', async () => {
    const { app, close, verifier } = build()
    const headers = await ownerBearer(prisma, oidc)
    try {
      const res = await app.inject({
        method: 'POST',
        url: BOARDS,
        headers,
        payload: { name: 'web', repoFullName: 'acme/web', ...withProject }
      })
      expect(res.statusCode).toBe(201)
      expect(res.json()).toMatchObject(withProject)
      expect(verifier.verify).toHaveBeenCalledWith({
        installationId: 77n,
        repoId: 4242n,
        repoFullName: 'acme/web',
        ownerType: 'Organization',
        ...withProject
      })
      expect(await prisma.kanbanBoard.findFirstOrThrow()).toMatchObject(withProject)
    } finally {
      await close()
    }
  })

  it('creates without project fields, returns nulls, and never calls the guard', async () => {
    const { app, close, verifier } = build()
    const headers = await ownerBearer(prisma, oidc)
    try {
      const res = await app.inject({
        method: 'POST',
        url: BOARDS,
        headers,
        payload: { name: 'web', repoFullName: 'acme/web' }
      })
      expect(res.statusCode).toBe(201)
      expect(res.json()).toMatchObject({ projectNodeId: null, statusFieldId: null })
      expect(verifier.verify).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it.each([
    ['project_requires_org_repo', 400],
    ['project_not_found', 400],
    ['project_not_org_owned', 400],
    ['project_owner_mismatch', 400],
    ['status_field_invalid', 400],
    ['github_rate_limited', 429],
    ['github_unavailable', 502],
    ['github_app_not_configured', 409]
  ] as const)('maps the guard verdict %s to HTTP %i and writes nothing', async (code, status) => {
    const { app, close } = build(async () => ({ ok: false, code }))
    const headers = await ownerBearer(prisma, oidc)
    try {
      const res = await app.inject({
        method: 'POST',
        url: BOARDS,
        headers,
        payload: { name: 'web', repoFullName: 'acme/web', ...withProject }
      })
      expect(res.statusCode).toBe(status)
      expect(res.json()).toMatchObject({ statusCode: status, code })
      expect(await prisma.kanbanBoard.count()).toBe(0)
    } finally {
      await close()
    }
  })

  it('refuses project fields with github_app_not_configured when no verifier is wired', async () => {
    const { app, close, verifier } = build(async () => ({ ok: true, options: [] }), ORG_REPO, { noVerifier: true })
    const headers = await ownerBearer(prisma, oidc)
    try {
      const res = await app.inject({
        method: 'POST',
        url: BOARDS,
        headers,
        payload: { name: 'web', repoFullName: 'acme/web', ...withProject }
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'github_app_not_configured' })
      expect(verifier.verify).not.toHaveBeenCalled()
      expect(await prisma.kanbanBoard.count()).toBe(0)
    } finally {
      await close()
    }
  })

  it('never leaks GitHub error text or the log reason into the refusal body', async () => {
    const secret = 'Resource not accessible by integration [SECRET-4a]'
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: { project: null, field: null }, errors: [{ type: 'FORBIDDEN', message: secret }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        )
    )
    const mintKanbanProject = vi.fn(async () => ({
      token: 'ghs_x',
      ttlSec: 3600,
      expiresAt: '',
      repoFullName: 'acme/web',
      access: 'read' as const
    }))
    const real = githubKanbanProjectVerifier({ tokens: { mintKanbanProject }, fetchImpl })
    const { app, close } = build((args) => real.verify(args))
    const headers = await ownerBearer(prisma, oidc)
    try {
      const res = await app.inject({
        method: 'POST',
        url: BOARDS,
        headers,
        payload: { name: 'web', repoFullName: 'acme/web', ...withProject }
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ code: 'project_not_found' })
      expect(res.body).not.toContain('SECRET-4a')
      expect(res.body).not.toContain('project_access_denied')
      expect(await prisma.kanbanBoard.count()).toBe(0)
    } finally {
      await close()
    }
  })

  it('refuses a user-owned repo with project_requires_org_repo and no GitHub call through the real verifier', async () => {
    const fetchImpl = vi.fn()
    const mintKanbanProject = vi.fn()
    const real = githubKanbanProjectVerifier({ tokens: { mintKanbanProject }, fetchImpl })
    const { app, close } = build((args) => real.verify(args), { ...ORG_REPO, ownerType: 'User' })
    const headers = await ownerBearer(prisma, oidc)
    try {
      const res = await app.inject({
        method: 'POST',
        url: BOARDS,
        headers,
        payload: { name: 'web', repoFullName: 'acme/web', ...withProject }
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ code: 'project_requires_org_repo' })
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(mintKanbanProject).not.toHaveBeenCalled()
      expect(await prisma.kanbanBoard.count()).toBe(0)
    } finally {
      await close()
    }
  })

  it('refuses a resolver result that does not name the owner type (fail closed)', async () => {
    const { ownerType: _drop, ...untyped } = ORG_REPO as Extract<KanbanRepoResolution, { ok: true }>
    const real = githubKanbanProjectVerifier({ tokens: { mintKanbanProject: vi.fn() }, fetchImpl: vi.fn() })
    const { app, close } = build((args) => real.verify(args), untyped)
    const headers = await ownerBearer(prisma, oidc)
    try {
      const res = await app.inject({
        method: 'POST',
        url: BOARDS,
        headers,
        payload: { name: 'web', repoFullName: 'acme/web', ...withProject }
      })
      expect(res.json()).toMatchObject({ code: 'project_requires_org_repo' })
    } finally {
      await close()
    }
  })

  it('rejects half a pair as a validation error', async () => {
    const { app, close, verifier } = build()
    const headers = await ownerBearer(prisma, oidc)
    try {
      for (const half of [{ projectNodeId: PROJECT }, { statusFieldId: FIELD }]) {
        const res = await app.inject({
          method: 'POST',
          url: BOARDS,
          headers,
          payload: { name: 'web', repoFullName: 'acme/web', ...half }
        })
        expect(res.statusCode).toBe(400)
      }
      expect(verifier.verify).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('a non-owner cannot configure a projection', async () => {
    const { app, close, verifier } = build()
    const { headers } = await memberBearer(prisma, oidc, 'collaborator', 'kanban-proj-collab')
    try {
      const res = await app.inject({
        method: 'POST',
        url: BOARDS,
        headers,
        payload: { name: 'web', repoFullName: 'acme/web', ...withProject }
      })
      expect(res.statusCode).toBe(403)
      expect(verifier.verify).not.toHaveBeenCalled()
      expect(await prisma.kanbanBoard.count()).toBe(0)
    } finally {
      await close()
    }
  })
})

describe('board PATCH with a Projects v2 projection', () => {
  async function seedBoard(project?: typeof withProject) {
    return prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'web', repoId: 4242n, repoFullName: 'acme/web', ...(project ?? {}) }
    })
  }

  it('sets a pair after the guard accepts it and bumps the config revision', async () => {
    const board = await seedBoard()
    const { app, close, verifier } = build()
    const headers = await ownerBearer(prisma, oidc)
    try {
      const res = await app.inject({ method: 'PATCH', url: `${BOARDS}/${board.id}`, headers, payload: withProject })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ ...withProject, configRevision: '2' })
      expect(verifier.verify).toHaveBeenCalledTimes(1)
    } finally {
      await close()
    }
  })

  it('refuses with the guard verdict and leaves the board unchanged', async () => {
    const board = await seedBoard()
    const { app, close } = build(async () => ({ ok: false, code: 'project_owner_mismatch' }))
    const headers = await ownerBearer(prisma, oidc)
    try {
      const res = await app.inject({ method: 'PATCH', url: `${BOARDS}/${board.id}`, headers, payload: withProject })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ code: 'project_owner_mismatch' })
      expect(await prisma.kanbanBoard.findUniqueOrThrow({ where: { id: board.id } })).toMatchObject({
        projectNodeId: null,
        statusFieldId: null
      })
    } finally {
      await close()
    }
  })

  it('clears both fields with null without consulting the guard', async () => {
    const board = await seedBoard(withProject)
    const { app, close, verifier } = build()
    const headers = await ownerBearer(prisma, oidc)
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `${BOARDS}/${board.id}`,
        headers,
        payload: { projectNodeId: null, statusFieldId: null }
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ projectNodeId: null, statusFieldId: null })
      expect(verifier.verify).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('rejects a half pair or a mixed null pair', async () => {
    const board = await seedBoard(withProject)
    const { app, close } = build()
    const headers = await ownerBearer(prisma, oidc)
    try {
      for (const payload of [
        { projectNodeId: null },
        { projectNodeId: PROJECT },
        { projectNodeId: PROJECT, statusFieldId: null }
      ]) {
        const res = await app.inject({ method: 'PATCH', url: `${BOARDS}/${board.id}`, headers, payload })
        expect(res.statusCode).toBe(400)
      }
    } finally {
      await close()
    }
  })

  it('an unrelated edit does not re-run the guard, but re-enabling a user-owned board is not blocked by it either', async () => {
    const board = await seedBoard(withProject)
    const { app, close, verifier } = build()
    const headers = await ownerBearer(prisma, oidc)
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `${BOARDS}/${board.id}`,
        headers,
        payload: { maxInProgress: 2 }
      })
      expect(res.statusCode).toBe(200)
      expect(verifier.verify).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('re-proves the existing pair when the repository changes', async () => {
    const board = await seedBoard(withProject)
    const { app, close, verifier } = build()
    const headers = await ownerBearer(prisma, oidc)
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `${BOARDS}/${board.id}`,
        headers,
        payload: { repoFullName: 'acme/web' }
      })
      expect(res.statusCode).toBe(200)
      expect(verifier.verify).toHaveBeenCalledWith(expect.objectContaining(withProject))
    } finally {
      await close()
    }
  })

  it('a non-owner cannot change the projection', async () => {
    const board = await seedBoard()
    const { app, close } = build()
    const { headers } = await memberBearer(prisma, oidc, 'viewer', 'kanban-proj-viewer')
    try {
      const res = await app.inject({ method: 'PATCH', url: `${BOARDS}/${board.id}`, headers, payload: withProject })
      expect(res.statusCode).toBe(403)
    } finally {
      await close()
    }
  })
})

describe('kanban_board projection pair CHECK', () => {
  it('rejects one id without the other and accepts both or neither', async () => {
    const mk = (n: string, data: object) =>
      prisma.kanbanBoard.create({
        data: {
          orgId: DEFAULT_ORG_ID,
          name: n,
          repoId: BigInt(Math.abs(n.length * 1000 + n.charCodeAt(0))),
          repoFullName: `acme/${n}`,
          ...data
        }
      })
    await expect(mk('half-a', { projectNodeId: PROJECT })).rejects.toThrow()
    await expect(mk('half-b', { statusFieldId: FIELD })).rejects.toThrow()
    await expect(mk('both', withProject)).resolves.toMatchObject(withProject)
    await expect(mk('none', {})).resolves.toMatchObject({ projectNodeId: null, statusFieldId: null })
  })

  it('stores a card projectItemId cache', async () => {
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'c', repoId: 9n, repoFullName: 'acme/c', ...withProject }
    })
    const card = await prisma.kanbanCard.create({
      data: { boardId: board.id, issueId: 1n, issueNumber: 1, projectItemId: 'PVTI_x' }
    })
    expect(card.projectItemId).toBe('PVTI_x')
  })

  it('remembers a projected item id on the card row', async () => {
    const { PgKanbanCardRepo } = await import('../../src/persistence/repositories/kanban.repo.js')
    const cards = new PgKanbanCardRepo(prisma)
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'item-cache', repoId: 10n, repoFullName: 'acme/item-cache', ...withProject }
    })
    const card = await prisma.kanbanCard.create({ data: { boardId: board.id, issueId: 2n, issueNumber: 2 } })
    expect(card.projectItemId).toBeNull()
    await cards.setProjectItemId(card.id, PROJECT, 'PVTI_new')
    await expect(cards.getCard(card.id)).resolves.toMatchObject({
      projectItemId: 'PVTI_new',
      projectItemProjectId: PROJECT
    })
  })
})

describe('vera-474 B1: the item cache across a project re-point (PG)', () => {
  const P1 = 'PVT_P1'
  const P2 = 'PVT_P2'
  const REPO = { installationId: 77n, repoId: 4242n, repoFullName: 'acme/web' }
  const mint = async () => ({
    token: 'ghs_p',
    ttlSec: 3600,
    expiresAt: '',
    repoFullName: 'acme/web',
    access: 'read' as const
  })

  // A tiny Projects v2 fake: an item belongs to one project; an update naming it elsewhere answers NOT_FOUND.
  function fakeProjects() {
    const itemProject = new Map<string, string>()
    const byContent = new Map<string, string>()
    let seq = 0
    const calls: Array<{ query: string; variables: Record<string, string> }> = []
    const reply = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const call = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> }
      calls.push(call)
      const v = call.variables
      if (call.query.includes('addProjectV2ItemById')) {
        const key = `${v.project}:${v.content}`
        let id = byContent.get(key)
        if (!id) {
          id = `PVTI_${v.project}_${++seq}`
          byContent.set(key, id)
          itemProject.set(id, v.project!)
        }
        return reply({ data: { addProjectV2ItemById: { item: { id } } } })
      }
      if (call.query.includes('updateProjectV2ItemFieldValue')) {
        if (itemProject.get(v.item!) !== v.project) {
          return reply({ data: { updateProjectV2ItemFieldValue: null }, errors: [{ type: 'NOT_FOUND', message: 'x' }] })
        }
        return reply({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: v.item } } } })
      }
      return reply({
        data: {
          project: { id: v.project, owner: { __typename: 'Organization', login: 'acme' } },
          field: {
            __typename: 'ProjectV2SingleSelectField',
            id: v.field,
            project: { id: v.project },
            options: Object.values(PROJECT_STATUS_OPTIONS).map((name) => ({ id: `opt-${name}`, name }))
          }
        }
      })
    })
    const removeItem = (id: string) => {
      itemProject.delete(id)
      for (const [key, item] of byContent) if (item === id) byContent.delete(key)
    }
    const of = (mutation: string, project?: string) =>
      calls.filter((c) => c.query.includes(mutation) && (!project || c.variables.project === project))
    return { fetchImpl, removeItem, of }
  }

  async function seed(project: string) {
    const board = await prisma.kanbanBoard.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        name: 'web',
        repoId: 4242n,
        repoFullName: 'acme/web',
        projectNodeId: project,
        statusFieldId: `F_${project}`
      }
    })
    const card = await prisma.kanbanCard.create({
      data: { boardId: board.id, issueId: 11n, issueNumber: 11, issueNodeId: 'I_11', status: 'todo' }
    })
    const gh = fakeProjects()
    const hook = kanbanProjectHook({
      boards: new PgKanbanBoardRepo(prisma),
      cards: new PgKanbanCardRepo(prisma),
      writer: new KanbanProjectWriter({ tokens: { mintKanbanProject: mint }, fetchImpl: gh.fetchImpl }),
      boardRepo: async () => ({ orgId: DEFAULT_ORG_ID, repo: REPO })
    })
    // A committed status change: the row moves first, then the post-commit seam projects whatever is committed.
    const transition = async (status: KanbanStatus) => {
      await prisma.kanbanCard.update({ where: { id: card.id }, data: { status } })
      hook.onStatusCommitted({ boardId: board.id, issueNumber: 11 })
      await hook.settle()
    }
    const stored = () => prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })
    return { board, card, gh, transition, stored }
  }

  it('vera-474: PATCH P1→P2 then three transitions add the card on P2 once and store the new id', async () => {
    const s = await seed(P1)
    await s.transition('ready')
    expect((await s.stored()).projectItemId).toMatch(/^PVTI_PVT_P1_/)
    const { app, close } = build()
    const headers = await ownerBearer(prisma, oidc)
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `${BOARDS}/${s.board.id}`,
        headers,
        payload: { projectNodeId: P2, statusFieldId: `F_${P2}` }
      })
      expect(res.statusCode).toBe(200)
    } finally {
      await close()
    }
    for (const status of ['running', 'review', 'done'] as const) await s.transition(status)
    expect(s.gh.of('addProjectV2ItemById', P2)).toHaveLength(1)
    const after = await s.stored()
    expect(after.projectItemId).toMatch(/^PVTI_PVT_P2_/)
    expect(after).toMatchObject({ projectItemProjectId: P2 })
    const writes = s.gh.of('updateProjectV2ItemFieldValue', P2)
    expect(writes.map((c) => c.variables.item)).toEqual([after.projectItemId, after.projectItemId, after.projectItemId])
  })

  it('vera-474: an item removed from the project by hand is re-added once and the stored id overwritten', async () => {
    const s = await seed(P1)
    await s.transition('ready')
    const first = (await s.stored()).projectItemId!
    s.gh.removeItem(first)
    await s.transition('running')
    expect(s.gh.of('addProjectV2ItemById')).toHaveLength(2)
    const second = (await s.stored()).projectItemId!
    expect(second).not.toBe(first)
    expect(second).toMatch(/^PVTI_PVT_P1_/)
    await s.transition('done')
    expect(s.gh.of('addProjectV2ItemById')).toHaveLength(2)
    expect(s.gh.of('updateProjectV2ItemFieldValue').at(-1)!.variables.item).toBe(second)
  })
})
