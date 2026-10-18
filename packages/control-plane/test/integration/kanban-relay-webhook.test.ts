// Signed GitHub webhook -> real relay HTTP ingress -> rc/github-graph over a real WebSocket -> CP Kanban doorbell -> Postgres.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPublicKey, createVerify, generateKeyPairSync, randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { buildApp, type App } from '../../src/app.js'
import { AppConfigSchema } from '../../src/config/env.js'
import { systemClock } from '../../src/domain/clock.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { postGithubWebhook, startRelayCpLink, type RelayCpLink } from '../fixtures/relay-link.js'

const RELAY_TOKEN = 'relay-shared-secret-0123456789abcdef'
const WEBHOOK_SECRET = 'kanban-webhook-secret-0123456789'
const INSTALLATION_ID = 77
const REPO_ID = 4242
const ISSUE = { id: 70007, number: 7 }
const HUMAN = { type: 'User', login: 'alice', id: 1001 }

interface GithubCall {
  method: string
  path: string
  body?: unknown
  jwtValid?: boolean
}

// A ready-labelled issue whose latest status edit is a human's (the `labeler`); an explicit `level`
// overrides that login's repository permission, otherwise alice writes and mallory reads.
function fakeGithub(publicKeyPem: string, labeler: { type: string; login: string } = HUMAN, level?: string) {
  const calls: GithubCall[] = []
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const { pathname } = new URL(url)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    const call: GithubCall = { method, path: pathname, body }
    calls.push(call)
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    if (method === 'POST' && pathname === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      call.jwtValid = verifyRs256(auth.replace(/^Bearer /, ''), publicKeyPem)
      return json(201, { token: 'ghs_test_installation', expires_at: new Date(Date.now() + 3_600_000).toISOString() })
    }
    // The label's human adder must hold live write access to un-park the card; `mallory` only reads.
    const permission = pathname.match(new RegExp(`^/repositories/${REPO_ID}/collaborators/([^/]+)/permission$`))
    if (permission) {
      const login = permission[1]!
      const resolved =
        level && login === labeler.login
          ? level
          : ({ alice: 'write', mallory: 'read' } as Record<string, string>)[login]
      return resolved ? json(200, { permission: resolved, role_name: resolved }) : json(404, { message: 'Not Found' })
    }
    const base = `/repositories/${REPO_ID}/issues/${ISSUE.number}`
    if (pathname === base) {
      return json(200, {
        id: ISSUE.id,
        node_id: 'I_7',
        number: ISSUE.number,
        state: 'open',
        labels: [{ name: 'ac/status:ready' }],
        repository: { id: REPO_ID },
        repository_url: 'https://api.github.com/repos/acme/board',
        user: { login: 'alice', type: 'User' }
      })
    }
    if (pathname === `${base}/events`) {
      return json(200, [
        { id: 1, event: 'labeled', label: { name: 'ac/status:triage' }, actor: HUMAN },
        { id: 2, event: 'labeled', label: { name: 'ac/status:ready' }, actor: labeler },
        { id: 3, event: 'unlabeled', label: { name: 'ac/status:triage' }, actor: labeler }
      ])
    }
    if (pathname.startsWith(`${base}/`)) return pathname.endsWith('/parent') ? json(404, {}) : json(200, [])
    return json(404, { message: 'Not Found' })
  }
  return { calls, fetch }
}

function verifyRs256(jwt: string, publicKeyPem: string): boolean {
  const [header, payload, signature] = jwt.split('.')
  if (!header || !payload || !signature) return false
  const verifier = createVerify('RSA-SHA256')
  verifier.update(`${header}.${payload}`)
  return verifier.verify(createPublicKey(publicKeyPem), Buffer.from(signature, 'base64url'))
}

function issuesLabeled(sender: { type: string; login: string }, label = 'ac/status:ready') {
  return {
    action: 'labeled',
    label: { name: label },
    issue: { ...ISSUE, state: 'open', labels: [{ name: label }], user: { login: 'alice', type: 'User' } },
    repository: { id: REPO_ID, full_name: 'acme/board', url: `https://api.github.com/repos/acme/board` },
    installation: { id: INSTALLATION_ID },
    sender
  }
}

let app: App | undefined
let link: RelayCpLink | undefined

afterEach(async () => {
  await link?.close()
  link = undefined
  await app?.shutdown()
  app = undefined
})

async function boot(labeler: { type: string; login: string } | string = HUMAN) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const github =
    typeof labeler === 'string'
      ? fakeGithub(publicKey.export({ type: 'spki', format: 'pem' }) as string, HUMAN, labeler)
      : fakeGithub(publicKey.export({ type: 'spki', format: 'pem' }) as string, labeler)
  await prisma.githubInstallation.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      installationId: BigInt(INSTALLATION_ID),
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'all'
    }
  })
  const board = await prisma.kanbanBoard.create({
    data: { orgId: DEFAULT_ORG_ID, name: 'board', repoId: BigInt(REPO_ID), repoFullName: 'acme/board' }
  })
  const card = await prisma.kanbanCard.create({
    data: { boardId: board.id, issueId: BigInt(ISSUE.id), issueNumber: ISSUE.number, status: 'triage' }
  })
  // Parked by a claim that found GitHub disagreeing, which is what makes a card eligible for doorbell ingest.
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
  app = buildApp({
    prisma,
    config: AppConfigSchema.parse({
      DATABASE_URL: 'postgresql://relay/ignored',
      API_KEY_PEPPER: 'kanban-relay-pepper-0123456789abcdefgh',
      RELAY_TOKEN,
      SECRETS_PROVIDER: 'memory',
      GITHUB_APP_ID: 1,
      GITHUB_APP_PRIVATE_KEY_B64: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).toString(
        'base64'
      ),
      GITHUB_APP_SLUG: 'agentconnect-test'
    }),
    clock: systemClock,
    secretsProvider: new MemorySecretsProvider(),
    githubFetch: github.fetch
  })
  const cpUrl = await app.http.listen({ port: 0, host: '127.0.0.1' })
  app.mountWs()
  link = await startRelayCpLink({ cpUrl, relayCredential: RELAY_TOKEN, webhookSecret: WEBHOOK_SECRET })
  return { github, card, link }
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value) || Date.now() > deadline) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('Kanban webhook delivery through the real relay (real ports, real Postgres)', () => {
  it('a signed human issues:labeled delivery rings the doorbell and un-parks the card', async () => {
    const { github, card, link } = await boot()
    const sent = await postGithubWebhook(link.webhookUrl, {
      secret: WEBHOOK_SECRET,
      event: 'issues',
      payload: issuesLabeled(HUMAN)
    })
    expect(sent.status).toBe(202)
    expect(link.graphPokes).toEqual([
      {
        deliveryKey: sent.deliveryId,
        installationId: String(INSTALLATION_ID),
        repoId: String(REPO_ID),
        event: 'issues',
        action: 'labeled',
        ids: [String(ISSUE.id)],
        numbers: [ISSUE.number],
        sender: { login: 'alice', id: '1001', type: 'User' },
        label: 'ac/status:ready'
      }
    ])

    const landed = await until(
      () => prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } }),
      (c) => c.status === 'ready'
    )
    expect(landed.status).toBe('ready')
    // The CP re-read the card with an App installation token scoped to the board repo and issues:read.
    const mint = github.calls.find((c) => c.path.endsWith('/access_tokens'))
    expect(mint?.jwtValid).toBe(true)
    expect(mint?.body).toEqual({ repository_ids: [REPO_ID], permissions: { metadata: 'read', issues: 'read' } })
    expect(github.calls.map((c) => c.path)).toContain(`/repositories/${REPO_ID}/issues/${ISSUE.number}/events`)
    // The edit was adopted only after a live lookup of the sender's repository role.
    expect(github.calls.map((c) => c.path)).toContain(`/repositories/${REPO_ID}/collaborators/alice/permission`)
  })

  it('a human without write access is refused: the card stays parked and the label reverts with a comment', async () => {
    const { github, card, link } = await boot('read')
    const sent = await postGithubWebhook(link.webhookUrl, {
      secret: WEBHOOK_SECRET,
      event: 'issues',
      payload: issuesLabeled(HUMAN)
    })
    expect(sent.status).toBe(202)
    const base = `/repositories/${REPO_ID}/issues/${ISSUE.number}`
    const calls = await until(
      async () => github.calls,
      (all) => all.some((c) => c.method === 'POST' && c.path === `${base}/comments`)
    )
    expect(calls.map((c) => c.path)).toContain(`/repositories/${REPO_ID}/collaborators/alice/permission`)
    expect(calls).toContainEqual(
      expect.objectContaining({ method: 'POST', path: `${base}/labels`, body: { labels: ['ac/status:triage'] } })
    )
    expect(calls).toContainEqual(
      expect.objectContaining({ method: 'DELETE', path: `${base}/labels/${encodeURIComponent('ac/status:ready')}` })
    )
    expect(calls.find((c) => c.path === `${base}/comments`)?.body).toEqual({
      body: expect.stringContaining('only collaborators with write access')
    })
    const saved = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })
    expect(saved).toMatchObject({ status: 'triage', syncEventCursor: 3n })
  })

  it('a human relabel by a non-writer leaves the parked card where it is (live write check, TRD 4.5)', async () => {
    const mallory = { type: 'User', login: 'mallory' }
    const { github, card, link } = await boot(mallory)
    await postGithubWebhook(link.webhookUrl, {
      secret: WEBHOOK_SECRET,
      event: 'issues',
      payload: issuesLabeled(mallory)
    })
    await until(
      async () => github.calls.map((c) => c.path),
      (paths) => paths.some((p) => p.endsWith('/collaborators/mallory/permission'))
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe('triage')
  })

  it('forwards the same GUID after a dropped CP emit and persists the redelivered doorbell', async () => {
    const { card, link } = await boot()
    const emit = vi.spyOn(link.client, 'emitGithubGraph').mockReturnValue(false)
    const deliveryId = randomUUID()
    const request = { secret: WEBHOOK_SECRET, event: 'issues', payload: issuesLabeled(HUMAN), deliveryId }
    try {
      expect((await postGithubWebhook(link.webhookUrl, request)).status).toBe(202)
      expect(emit).toHaveBeenCalledOnce()
      expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe('triage')
    } finally {
      emit.mockRestore()
    }
    expect((await postGithubWebhook(link.webhookUrl, request)).status).toBe(202)
    const landed = await until(
      () => prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } }),
      (row) => row.status === 'ready'
    )
    expect(landed.status).toBe('ready')
    expect(link.graphPokes.map((poke) => poke.deliveryKey)).toEqual([deliveryId, deliveryId])
  })

  it('a bad signature answers 401 and puts no frame on the wire', async () => {
    const { github, card, link } = await boot()
    const sent = await postGithubWebhook(link.webhookUrl, {
      secret: WEBHOOK_SECRET,
      event: 'issues',
      payload: issuesLabeled(HUMAN),
      signature: `sha256=${'0'.repeat(64)}`
    })
    expect(sent.status).toBe(401)
    const wrongKey = await postGithubWebhook(link.webhookUrl, {
      secret: 'not-the-webhook-secret',
      event: 'issues',
      payload: issuesLabeled(HUMAN)
    })
    expect(wrongKey.status).toBe(401)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(link.graphPokes).toEqual([])
    expect(github.calls).toEqual([])
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe('triage')
  })

  it('a bot relabel is a seen-only marker: forwarded without issue numbers, nothing re-read', async () => {
    const { github, card, link } = await boot()
    const sent = await postGithubWebhook(link.webhookUrl, {
      secret: WEBHOOK_SECRET,
      event: 'issues',
      payload: issuesLabeled({ type: 'Bot', login: 'agentconnect-test[bot]' })
    })
    expect(sent.status).toBe(202)
    expect(link.graphPokes).toHaveLength(1)
    expect(link.graphPokes[0]).toMatchObject({ deliveryKey: sent.deliveryId, ids: [], numbers: [] })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(github.calls).toEqual([])
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe('triage')
  })

  it('an issue_dependencies delivery reaches the graph doorbell, which re-reads the dependency graph', async () => {
    const { github, link } = await boot()
    const sent = await postGithubWebhook(link.webhookUrl, {
      secret: WEBHOOK_SECRET,
      event: 'issue_dependencies',
      payload: {
        action: 'blocked_by_added',
        blocked_issue_id: ISSUE.id,
        blocked_issue: { id: ISSUE.id, number: ISSUE.number },
        blocking_issue_id: 70008,
        blocking_issue: { id: 70008, number: 8 },
        repository: { id: REPO_ID, full_name: 'acme/board' },
        installation: { id: INSTALLATION_ID },
        sender: { type: 'Bot', login: 'someone[bot]' }
      }
    })
    expect(sent.status).toBe(202)
    expect(link.graphPokes[0]).toMatchObject({ event: 'issue_dependencies', numbers: [ISSUE.number, 8] })
    const calls = await until(
      async () => github.calls.map((c) => c.path),
      (paths) => paths.includes(`/repositories/${REPO_ID}/issues/${ISSUE.number}/dependencies/blocked_by`)
    )
    expect(calls).toContain(`/repositories/${REPO_ID}/issues/${ISSUE.number}/dependencies/blocked_by`)
  })
})
