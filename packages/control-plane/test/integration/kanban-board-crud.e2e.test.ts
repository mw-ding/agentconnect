import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { githubKanbanRepoResolver } from '../../src/kanban/repo-resolver.js'
import { PgGithubInstallationRepo } from '../../src/persistence/index.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { prisma } from '../setup.db.js'
import { startKanbanOidc, ownerBearer, memberBearer, type KanbanOidc } from '../fixtures/kanban-oidc.js'
import { enabled, FULL, REPO_ID, gh, createIssue, closeIssues, record } from '../fixtures/kanban-live.js'

// Only installation coverage is injected; the resolver verifies the real repository identity via GitHub.
describe.skipIf(!enabled)('Kanban board CRUD E2E (live GitHub)', () => {
  let oidc: KanbanOidc
  const issues: number[] = []
  const boards: string[] = []
  beforeAll(async () => {
    oidc = await startKanbanOidc('board-live')
  })
  afterAll(async () => {
    await closeIssues(issues)
    await prisma.kanbanBoard.deleteMany({ where: { id: { in: boards } } })
    await oidc.close()
  }, 120_000)
  it('creates, lists, reads, updates and deletes an authorized live-repository board', async () => {
    const started = Date.now()
    const issue = await createIssue(issues, 'board CRUD', [])
    await prisma.githubInstallation.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        installationId: 1n,
        accountLogin: 'mw-ding',
        accountType: 'User',
        repositorySelection: 'selected'
      }
    })
    const { app, close } = buildHttpApp(
      prisma,
      { OIDC_ISSUER: oidc.issuer, OIDC_AUDIENCE: oidc.audience },
      undefined,
      undefined,
      {
        kanbanRepoResolver: githubKanbanRepoResolver({
          installations: new PgGithubInstallationRepo(prisma),
          github: {
            repoRefFor: async (_ins, owner, name) => {
              const repo = await gh<{ id: number; full_name: string; private: boolean; default_branch: string }>(
                'GET',
                `/repos/${owner}/${name}`
              )
              expect(BigInt(repo.id)).toBe(REPO_ID)
              return {
                repoId: BigInt(repo.id),
                fullName: repo.full_name,
                private: repo.private,
                defaultBranch: repo.default_branch
              }
            }
          }
        })
      }
    )
    try {
      const headers = await ownerBearer(prisma, oidc)
      const viewer = await memberBearer(prisma, oidc, 'viewer', 'board-live-viewer')
      const base = `/api/v1/orgs/${DEFAULT_ORG_ID}/kanban/boards`
      const created = await app.inject({
        method: 'POST',
        url: base,
        headers,
        payload: { name: 'live', repoFullName: FULL }
      })
      expect(created.statusCode).toBe(201)
      const id = created.json().id as string
      boards.push(id)
      const url = `${base}/${id}`
      expect((await app.inject({ method: 'GET', url, headers: viewer.headers })).statusCode).toBe(200)
      expect((await app.inject({ method: 'GET', url: base, headers })).json().boards).toHaveLength(1)
      const updated = await app.inject({
        method: 'PATCH',
        url,
        headers,
        payload: { name: 'private live', visibility: 'restricted', sharedWith: [DEFAULT_ORG_ID] }
      })
      expect(updated.statusCode).toBe(400)
      expect(
        (await app.inject({ method: 'PATCH', url, headers, payload: { name: 'updated live', maxInProgress: 2 } }))
          .statusCode
      ).toBe(200)
      expect((await app.inject({ method: 'DELETE', url, headers: viewer.headers })).statusCode).toBe(403)
      expect((await app.inject({ method: 'DELETE', url, headers })).statusCode).toBe(204)
      record('board CRUD and live repository validation', [issue.number], started)
    } finally {
      await close()
    }
  }, 120_000)
})
