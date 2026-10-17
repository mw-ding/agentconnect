// The Kanban plugin's owner gate is default-on: a route added later is owner-only unless it opts out as a viewer read.
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { OrgId } from '../../domain/ids.js'
import type { OrgMemberRole } from '../../persistence/ports.js'
import { ownerGateByDefault } from './kanban.js'

async function build() {
  const app = Fastify()
  // Stand-in for humanAuth + org scope: the test headers pick the caller's role and credential kind.
  app.addHook('onRequest', async (req) => {
    req.orgCtx = { orgId: OrgId('org'), userId: 'u', role: req.headers['x-role'] as OrgMemberRole }
    if (req.headers['x-api-key']) req.apiKeyId = 'key'
    req.oidcSubject = 'sub'
  })
  await app.register(async (scope) => {
    ownerGateByDefault(scope)
    // A route a later lane might add, with no gate of its own.
    scope.post('/kanban/new-thing', async () => ({ ok: true }))
    scope.get('/kanban/new-read', async () => ({ ok: true }))
    scope.get('/kanban/viewer-read', { config: { kanbanAccess: 'viewer' } }, async () => ({ ok: true }))
  })
  return app
}

describe('ownerGateByDefault', () => {
  it.each([
    ['POST', '/kanban/new-thing', 'viewer', 403],
    ['POST', '/kanban/new-thing', 'collaborator', 403],
    ['POST', '/kanban/new-thing', 'owner', 200],
    ['GET', '/kanban/new-read', 'viewer', 403],
    ['GET', '/kanban/new-read', 'owner', 200],
    ['GET', '/kanban/viewer-read', 'viewer', 200],
    ['GET', '/kanban/viewer-read', 'collaborator', 200]
  ] as const)('%s %s as %s → %s', async (method, url, role, status) => {
    const app = await build()
    const res = await app.inject({ method, url, headers: { 'x-role': role } })
    expect(res.statusCode).toBe(status)
    await app.close()
  })

  it('refuses an owner API key on a route without the opt-out', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/kanban/new-thing',
      headers: { 'x-role': 'owner', 'x-api-key': '1' }
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'INTERACTIVE_AUTH_REQUIRED' })
    await app.close()
  })
})
