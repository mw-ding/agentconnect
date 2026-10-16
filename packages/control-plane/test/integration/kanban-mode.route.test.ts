// Kanban run-mode routes (issue #2): only an interactive OIDC owner session may set board or card write mode.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, TEST_API_KEY_PEPPER } from '../fakes/build-http.js'
import { seedDaemon } from '../fixtures/seed.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { INTERNAL_INVOCATION_AUTH_HEADER } from '../../src/http/mcp/internal-invocation-auth.js'
import { DaemonId, OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_EMAIL, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const OWNER_SUBJECT = 'kanban-owner'
const OIDC_AUDIENCE = 'kanban-mode-test'
const DAEMON = 'd5555555-5555-4555-8555-555555555555'

let oidcServer: Server
let oidcIssuer = ''
let mintBearer: (subject: string, email: string) => Promise<string>

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'kanban-test', use: 'sig' }
  oidcServer = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/.well-known/openid-configuration') {
      res.end(JSON.stringify({ issuer: oidcIssuer, jwks_uri: `${oidcIssuer}/jwks` }))
      return
    }
    if (req.url === '/jwks') {
      res.end(JSON.stringify({ keys: [jwk] }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((resolve, reject) => {
    oidcServer.once('error', reject)
    oidcServer.listen(0, '127.0.0.1', resolve)
  })
  oidcIssuer = `http://127.0.0.1:${(oidcServer.address() as AddressInfo).port}`
  mintBearer = (subject, email) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: 'kanban-test' })
      .setIssuer(oidcIssuer)
      .setAudience(OIDC_AUDIENCE)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey)
})

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      oidcServer.close((err) => (err ? reject(err) : resolve()))
    })
)

const buildOidcApp = () => buildHttpApp(prisma, { OIDC_ISSUER: oidcIssuer, OIDC_AUDIENCE })
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

async function ownerHeaders() {
  await prisma.user.update({ where: { id: DEFAULT_OWNER_ID }, data: { oidcSubject: OWNER_SUBJECT } })
  return bearer(await mintBearer(OWNER_SUBJECT, DEFAULT_OWNER_EMAIL))
}

async function seedBoard(orgId: string = DEFAULT_ORG_ID) {
  const board = await prisma.kanbanBoard.create({
    data: { orgId, name: 'eng', repoId: 4242n, repoFullName: 'acme/web' }
  })
  const card = await prisma.kanbanCard.create({
    data: { boardId: board.id, issueId: 1n, issueNumber: 1, status: 'ready' }
  })
  return { board, card }
}

// An api_key row minted the way the CP mints it, so the human-auth plane resolves it exactly as in production.
async function mintKey(data: { principalType: 'user' | 'oauth' | 'daemon'; userId?: string; daemonId?: string }) {
  const minted = new ApiKeyCodec({ API_KEY_PEPPER: TEST_API_KEY_PEPPER }).mint()
  await prisma.apiKey.create({
    data: {
      ...data,
      orgId: DEFAULT_ORG_ID,
      hash: minted.hash,
      displayTail: minted.displayTail,
      ...(data.principalType === 'oauth' ? { scopes: ['mcp:read', 'mcp:write'], oauthGrantId: 'grant-1' } : {})
    }
  })
  return minted.token
}

const boardUrl = (boardId: string) => `${ORG}/kanban/boards/${boardId}/mode`
const cardUrl = (boardId: string, cardId: string) => `${ORG}/kanban/boards/${boardId}/cards/${cardId}/mode`
const modes = async (boardId: string, cardId: string) => ({
  board: (await prisma.kanbanBoard.findUniqueOrThrow({ where: { id: boardId } })).defaultMode,
  card: (await prisma.kanbanCard.findUniqueOrThrow({ where: { id: cardId } })).mode
})

describe('Kanban run-mode routes — an interactive owner', () => {
  it('sets the board default and sets then clears a card override', async () => {
    const { board, card } = await seedBoard()
    const { app, close } = buildOidcApp()
    const headers = await ownerHeaders()
    try {
      const setBoard = await app.inject({ method: 'PUT', url: boardUrl(board.id), headers, payload: { mode: 'write' } })
      expect(setBoard.statusCode).toBe(200)
      expect(setBoard.json()).toEqual({ boardId: board.id, defaultMode: 'write' })
      const after = await prisma.kanbanBoard.findUniqueOrThrow({ where: { id: board.id } })
      expect(after).toMatchObject({ defaultMode: 'write', lastModifiedByUserId: DEFAULT_OWNER_ID })
      expect(after.configRevision).toBe(board.configRevision + 1n)

      const setCard = await app.inject({
        method: 'PUT',
        url: cardUrl(board.id, card.id),
        headers,
        payload: { mode: 'read' }
      })
      expect(setCard.statusCode).toBe(200)
      expect(setCard.json()).toEqual({ boardId: board.id, cardId: card.id, mode: 'read' })
      expect(await modes(board.id, card.id)).toEqual({ board: 'write', card: 'read' })

      const clear = await app.inject({
        method: 'PUT',
        url: cardUrl(board.id, card.id),
        headers,
        payload: { mode: null }
      })
      expect(clear.statusCode).toBe(200)
      expect(await modes(board.id, card.id)).toEqual({ board: 'write', card: null })
    } finally {
      await close()
    }
  })

  it('validates the body and 404s an unknown or foreign board and card', async () => {
    const { board, card } = await seedBoard()
    const foreignOrg = await prisma.org.create({ data: { name: 'Foreign', slug: 'foreign-kanban' } })
    const foreign = await seedBoard(foreignOrg.id)
    const { app, close } = buildOidcApp()
    const headers = await ownerHeaders()
    try {
      const put = (url: string, payload: unknown) =>
        app.inject({ method: 'PUT', url, headers, payload: payload as never })
      expect((await put(boardUrl(board.id), { mode: 'admin' })).statusCode).toBe(400)
      expect((await put(boardUrl(board.id), { mode: 'write', extra: true })).statusCode).toBe(400)
      expect((await put(boardUrl(foreign.board.id), { mode: 'write' })).statusCode).toBe(404)
      expect((await put(cardUrl(board.id, foreign.card.id), { mode: 'write' })).statusCode).toBe(404)
      expect((await put(cardUrl(foreign.board.id, foreign.card.id), { mode: 'write' })).statusCode).toBe(404)
      expect((await put(boardUrl('00000000-0000-4000-8000-000000000000'), { mode: 'write' })).statusCode).toBe(404)
      expect(await modes(foreign.board.id, foreign.card.id)).toEqual({ board: 'read', card: null })
      expect(await modes(board.id, card.id)).toEqual({ board: 'read', card: null })
    } finally {
      await close()
    }
  })
})

describe('Kanban run-mode routes — every non-interactive or non-owner caller is refused', () => {
  // Each case attempts both routes; the board and card must stay read-only.
  async function expectRefused(
    status: number,
    headersFor: () => Promise<Record<string, string>>,
    app = buildOidcApp()
  ): Promise<void> {
    const { board, card } = await seedBoard()
    try {
      const headers = await headersFor()
      const res = [
        await app.app.inject({ method: 'PUT', url: boardUrl(board.id), headers, payload: { mode: 'write' } }),
        await app.app.inject({ method: 'PUT', url: cardUrl(board.id, card.id), headers, payload: { mode: 'write' } })
      ]
      expect(res.map((r) => r.statusCode)).toEqual([status, status])
      expect(await modes(board.id, card.id)).toEqual({ board: 'read', card: null })
    } finally {
      await app.close()
    }
  }

  it('no credentials → 401', async () => {
    await expectRefused(401, async () => ({}))
  })

  it('a daemon API key → 401 (never a human principal)', async () => {
    await seedDaemon(prisma, DAEMON)
    await expectRefused(401, async () => bearer(await mintKey({ principalType: 'daemon', daemonId: DAEMON })))
  })

  it('a daemon key minted through the CP key service → 401', async () => {
    await seedDaemon(prisma, DAEMON)
    const http = buildOidcApp()
    const minted = await http.deps.apiKeys.mintForDaemon(OrgId(DEFAULT_ORG_ID), DaemonId(DAEMON))
    await expectRefused(401, async () => bearer(minted.token), http)
  })

  it("an agent's OAuth access token for the owner (mcp:write) → 403", async () => {
    await expectRefused(403, async () => bearer(await mintKey({ principalType: 'oauth', userId: DEFAULT_OWNER_ID })))
  })

  it("the owner's personal API key, which an agent may hold → 403", async () => {
    await expectRefused(403, async () => bearer(await mintKey({ principalType: 'user', userId: DEFAULT_OWNER_ID })))
  })

  it('a delegated agent invocation acting as the owner → 403', async () => {
    const { board } = await seedBoard()
    const http = buildOidcApp()
    const auth = http.deps.internalInvocationAuth
    try {
      const res = await auth.run(
        {
          invocationId: 'inv-1',
          conversationId: 'conv-1',
          grantId: 'grant-1',
          authorityGeneration: 1,
          agentId: 'agent-1',
          daemonId: DAEMON,
          orgId: DEFAULT_ORG_ID,
          userId: DEFAULT_OWNER_ID,
          startedAt: new Date(),
          requestHash: 'hash',
          method: 'tools/call'
        },
        async () => {
          const url = boardUrl(board.id)
          const nonce = auth.issue('PUT', url)!
          return http.app.inject({
            method: 'PUT',
            url,
            headers: { [INTERNAL_INVOCATION_AUTH_HEADER]: nonce },
            payload: { mode: 'write' }
          })
        }
      )
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ code: 'INTERACTIVE_AUTH_REQUIRED' })
      expect((await prisma.kanbanBoard.findUniqueOrThrow({ where: { id: board.id } })).defaultMode).toBe('read')
    } finally {
      await http.close()
    }
  })

  it('the devAuth stub (no OIDC configured, no credentials) → 403', async () => {
    await expectRefused(403, async () => ({}), buildHttpApp(prisma))
  })

  it('an interactive collaborator in the org → 403', async () => {
    const collaborator = await new PgUserRepo(prisma).provisionOidcUser({
      oidcSubject: 'kanban-collab',
      email: 'collab@acme.dev',
      emailVerified: true
    })
    await prisma.membership.create({
      data: { orgId: DEFAULT_ORG_ID, userId: collaborator.userId, role: 'collaborator' }
    })
    await expectRefused(403, async () => bearer(await mintBearer('kanban-collab', 'collab@acme.dev')))
  })

  it('an interactive viewer in the org → 403', async () => {
    const viewer = await new PgUserRepo(prisma).provisionOidcUser({
      oidcSubject: 'kanban-viewer',
      email: 'viewer@acme.dev',
      emailVerified: true
    })
    await prisma.membership.create({ data: { orgId: DEFAULT_ORG_ID, userId: viewer.userId, role: 'viewer' } })
    await expectRefused(403, async () => bearer(await mintBearer('kanban-viewer', 'viewer@acme.dev')))
  })

  it('an interactive owner of a different org → 404', async () => {
    await new PgUserRepo(prisma).provisionOidcUser({
      oidcSubject: 'kanban-stranger',
      email: 'stranger@other.dev',
      emailVerified: true
    })
    await expectRefused(404, async () => bearer(await mintBearer('kanban-stranger', 'stranger@other.dev')))
  })
})
