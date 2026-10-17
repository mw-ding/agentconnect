// A local OIDC issuer for Kanban route tests: configuration routes accept only an interactive OIDC session.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { PrismaClient } from '../../src/generated/prisma/client.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_EMAIL, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

export interface KanbanOidc {
  issuer: string
  audience: string
  mintBearer(subject: string, email: string): Promise<string>
  close(): Promise<void>
}

export async function startKanbanOidc(audience = 'kanban-test'): Promise<KanbanOidc> {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'kanban-test', use: 'sig' }
  let issuer = ''
  const server: Server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/.well-known/openid-configuration') {
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }))
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
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    issuer,
    audience,
    mintBearer: (subject, email) =>
      new SignJWT({ email })
        .setProtectedHeader({ alg: 'RS256', kid: 'kanban-test' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(privateKey),
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

export async function ownerBearer(prisma: PrismaClient, oidc: KanbanOidc, subject = 'kanban-owner') {
  await prisma.user.update({ where: { id: DEFAULT_OWNER_ID }, data: { oidcSubject: subject } })
  return bearer(await oidc.mintBearer(subject, DEFAULT_OWNER_EMAIL))
}

/** A member of the default org with an interactive session; returns the user id and its bearer headers. */
export async function memberBearer(
  prisma: PrismaClient,
  oidc: KanbanOidc,
  role: 'collaborator' | 'viewer' | 'owner',
  name: string
): Promise<{ userId: string; headers: Record<string, string> }> {
  const email = `${name}@acme.dev`
  const user = await new PgUserRepo(prisma).provisionOidcUser({ oidcSubject: name, email, emailVerified: true })
  await prisma.membership.create({ data: { orgId: DEFAULT_ORG_ID, userId: user.userId, role } })
  return { userId: user.userId, headers: bearer(await oidc.mintBearer(name, email)) }
}
