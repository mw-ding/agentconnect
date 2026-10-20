// `/kanban` comment commands end to end: signed issue_comment -> real relay -> rc/github-graph -> CP -> Postgres + GitHub writes.
import { afterEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { buildApp, type App } from '../../src/app.js'
import { AppConfigSchema } from '../../src/config/env.js'
import { systemClock } from '../../src/domain/clock.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { postGithubWebhook, startRelayCpLink, type RelayCpLink } from '../fixtures/relay-link.js'
import { COMMAND_EFFECT_TTL_MS } from '../../src/kanban/comment-command.js'

const RELAY_TOKEN = 'relay-shared-secret-0123456789abcdef'
const WEBHOOK_SECRET = 'kanban-webhook-secret-0123456789'
const INSTALLATION_ID = 78
const REPO_ID = 4343
const ISSUE = { id: 80008, number: 8 }
const APP_SLUG = 'agentconnect-test'

interface GithubCall {
  method: string
  path: string
  body?: unknown
}

type Status = 'triage' | 'todo' | 'ready' | 'running' | 'blocked' | 'review' | 'done' | 'archived'

// One issue whose labels and state follow the CP's writes; the permission API answers per login.
function fakeGithub(start: {
  status: Status
  permissions: Record<string, string>
  // Called per comment POST; resolves to the HTTP status GitHub answers, so a test can hold or fail the write.
  onComment?: () => Promise<number>
}) {
  const calls: GithubCall[] = []
  let labels = [`ac/status:${start.status}`, 'bug']
  let state: 'open' | 'closed' = start.status === 'done' || start.status === 'archived' ? 'closed' : 'open'
  let stateReason: string | null = start.status === 'done' ? 'completed' : null
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const { pathname } = new URL(url)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    calls.push({ method, path: pathname, ...(body ? { body } : {}) })
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    if (method === 'POST' && pathname === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      return json(201, { token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() })
    }
    const permission = pathname.match(new RegExp(`^/repositories/${REPO_ID}/collaborators/([^/]+)/permission$`))
    if (permission) {
      const level = start.permissions[decodeURIComponent(permission[1]!)]
      return level ? json(200, { permission: level, role_name: level }) : json(404, { message: 'Not Found' })
    }
    const base = `/repositories/${REPO_ID}/issues/${ISSUE.number}`
    if (pathname === base && method === 'GET') {
      return json(200, {
        id: ISSUE.id,
        node_id: 'I_8',
        number: ISSUE.number,
        state,
        state_reason: stateReason,
        labels: labels.map((name) => ({ name })),
        repository: { id: REPO_ID },
        repository_url: 'https://api.github.com/repos/acme/board',
        user: { login: 'alice', type: 'User' }
      })
    }
    if (pathname === base && method === 'PATCH') {
      state = body!.state as 'open' | 'closed'
      stateReason = (body!.state_reason as string | undefined) ?? null
      return json(200, {})
    }
    if (pathname === `${base}/labels` && method === 'POST') {
      labels = [...new Set([...labels, ...(body!.labels as string[])])]
      return json(200, [])
    }
    if (pathname.startsWith(`${base}/labels/`) && method === 'DELETE') {
      const name = decodeURIComponent(pathname.slice(`${base}/labels/`.length))
      labels = labels.filter((l) => l !== name)
      return json(200, [])
    }
    if (pathname === `${base}/comments` && method === 'POST') {
      const status = (await start.onComment?.()) ?? 201
      return status === 201 ? json(201, { id: 1 }) : json(status, { message: 'Server Error' })
    }
    return json(404, { message: 'Not Found' })
  }
  return { calls, fetch, labels: () => labels, state: () => state }
}

function commentCreated(body: string, sender: { login: string; type: string; id?: number }, commentId = 5001) {
  return {
    action: 'created',
    issue: { ...ISSUE, title: 'secret title', body: 'secret body', state: 'open', labels: [] },
    comment: { id: commentId, body, user: { login: sender.login } },
    repository: { id: REPO_ID, full_name: 'acme/board', url: 'https://api.github.com/repos/acme/board' },
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

async function boot(
  status: Status,
  permissions: Record<string, string> = { alice: 'admin' },
  onComment?: () => Promise<number>
) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const github = fakeGithub({ status, permissions, ...(onComment ? { onComment } : {}) })
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
    data: {
      boardId: board.id,
      issueId: BigInt(ISSUE.id),
      issueNumber: ISSUE.number,
      status,
      ...(status === 'blocked' ? { blockKind: 'needs_input' as const } : {}),
      ...(status === 'done'
        ? {
            linkedPrNumber: 12,
            workEpisodeStartedAt: new Date('2026-10-15T00:00:00Z'),
            contractFlags: ['pr_unbound#11']
          }
        : {})
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
      GITHUB_APP_SLUG: APP_SLUG
    }),
    clock: systemClock,
    secretsProvider: new MemorySecretsProvider(),
    githubFetch: github.fetch
  })
  const cpUrl = await app.http.listen({ port: 0, host: '127.0.0.1' })
  app.mountWs()
  link = await startRelayCpLink({ cpUrl, relayCredential: RELAY_TOKEN, webhookSecret: WEBHOOK_SECRET })
  return { github, board, card, link }
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value) || Date.now() > deadline) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const settled = (boardId: string) =>
  until(
    () => prisma.kanbanCommand.findMany({ where: { boardId } }),
    (rows) => rows.length > 0 && rows.every((r) => r.settledAt !== null)
  )
const writes = (calls: GithubCall[]) => calls.filter((c) => c.method !== 'GET' && !c.path.endsWith('/access_tokens'))

describe('Kanban comment commands through the real relay (real ports, real Postgres)', () => {
  it('/kanban unblock by an admin moves blocked → ready, writes the labels, audits the actor, and records one ledger row', async () => {
    const { github, board, card, link } = await boot('blocked')
    const sent = await postGithubWebhook(link.webhookUrl, {
      secret: WEBHOOK_SECRET,
      event: 'issue_comment',
      payload: commentCreated('/kanban unblock\nplease pick this back up', { login: 'alice', type: 'User', id: 31 })
    })
    expect(sent.status).toBe(202)
    // The relay forwarded the parsed command only: no comment text, issue title, or body crossed into the CP.
    expect(link.graphPokes).toEqual([
      {
        deliveryKey: sent.deliveryId,
        installationId: String(INSTALLATION_ID),
        repoId: String(REPO_ID),
        event: 'issue_comment',
        action: 'created',
        ids: [String(ISSUE.id)],
        numbers: [ISSUE.number],
        command: { name: 'unblock', commentId: '5001', sender: { login: 'alice', id: '31', type: 'User' } }
      }
    ])
    expect(JSON.stringify(link.graphPokes)).not.toMatch(/please pick|secret title|secret body/)

    const [row] = await settled(board.id)
    expect(row).toMatchObject({ commentId: 5001n, command: 'unblock', outcome: 'applied', actorLogin: 'alice' })
    const moved = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })
    expect(moved).toMatchObject({ status: 'ready', blockKind: null, stateRevision: 2n })
    expect(github.labels()).toEqual(['bug', 'ac/status:ready'])
    expect(writes(github.calls).some((c) => c.path.endsWith('/comments'))).toBe(false)
    // The live permission check ran for the sender (uncached), and the audit row names the attested human.
    expect(github.calls.filter((c) => c.path.endsWith('/collaborators/alice/permission'))).toHaveLength(1)
    const audit = await prisma.auditEvent.findMany({ where: { kind: 'kanban_card_change' } })
    expect(audit).toHaveLength(1)
    expect(audit[0]!.details).toMatchObject({
      cardId: card.id,
      change: 'status',
      from: 'blocked',
      to: 'ready',
      command: 'unblock',
      commentId: '5001',
      humanAuthority: { login: 'alice', permission: 'admin' },
      source: 'comment_command'
    })
  })

  it('vera-415b3: /kanban reopen reopens a done issue, moves the card to ready, and ends the work episode', async () => {
    const { github, board, card, link } = await boot('done')
    await postGithubWebhook(link.webhookUrl, {
      secret: WEBHOOK_SECRET,
      event: 'issue_comment',
      payload: commentCreated('/kanban reopen', { login: 'alice', type: 'User' })
    })
    await settled(board.id)
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).toMatchObject({
      status: 'ready',
      linkedPrNumber: null,
      workEpisodeStartedAt: null,
      contractFlags: []
    })
    expect(github.state()).toBe('open')
    expect(writes(github.calls)).toContainEqual(
      expect.objectContaining({ method: 'PATCH', body: { state: 'open', state_reason: 'reopened' } })
    )
  })

  it('vera-415: a non-writer is silently recorded once even when the delivery repeats', async () => {
    const { github, board, card, link } = await boot('blocked', { alice: 'admin', octocat: 'read' })
    const deliveryId = randomUUID()
    const request = {
      secret: WEBHOOK_SECRET,
      event: 'issue_comment',
      payload: commentCreated('/kanban unblock', { login: 'octocat', type: 'User' }),
      deliveryId
    }
    expect((await postGithubWebhook(link.webhookUrl, request)).status).toBe(202)
    const [row] = await settled(board.id)
    expect(row).toMatchObject({ outcome: 'no_write', toStatus: null })
    // A GitHub redelivery of the same GUID, and a different GUID naming the same comment, change nothing.
    await postGithubWebhook(link.webhookUrl, request)
    await postGithubWebhook(link.webhookUrl, { ...request, deliveryId: randomUUID() })
    await until(
      async () => link.graphPokes.length,
      (n) => n === 3
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe('blocked')
    const comments = writes(github.calls).filter((c) => c.path.endsWith('/comments'))
    expect(comments).toHaveLength(0)
    expect(writes(github.calls).filter((c) => !c.path.endsWith('/comments'))).toEqual([])
    expect(await prisma.kanbanCommand.count()).toBe(1)
    expect(await prisma.auditEvent.count({ where: { kind: 'kanban_card_change' } })).toBe(0)
  })

  it('a command that does not apply to the card explains itself once', async () => {
    const { github, board, card, link } = await boot('ready')
    await postGithubWebhook(link.webhookUrl, {
      secret: WEBHOOK_SECRET,
      event: 'issue_comment',
      payload: commentCreated('/kanban reopen', { login: 'alice', type: 'User' })
    })
    const [row] = await settled(board.id)
    expect(row!.outcome).toBe('wrong_status')
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe('ready')
    const comments = writes(github.calls).filter((c) => c.path.endsWith('/comments'))
    expect(comments.map((c) => (c.body as { body: string }).body)).toEqual([expect.stringContaining('(wrong_status)')])
  })

  it('vera-415r2: B6 a redelivery overlapping an in-flight refusal posts no second comment', async () => {
    let release!: () => void
    const held = new Promise<number>((resolve) => (release = () => resolve(201)))
    const { github, board, link } = await boot('ready', { alice: 'admin' }, () => held)
    const request = {
      secret: WEBHOOK_SECRET,
      event: 'issue_comment',
      payload: commentCreated('/kanban reopen', { login: 'alice', type: 'User' }),
      deliveryId: randomUUID()
    }
    await postGithubWebhook(link.webhookUrl, request)
    const posts = () => writes(github.calls).filter((c) => c.path.endsWith('/comments'))
    await until(
      async () => posts().length,
      (n) => n === 1
    )
    // The first POST is still in flight when GitHub redelivers the same GUID.
    expect((await postGithubWebhook(link.webhookUrl, request)).status).toBe(202)
    await until(
      async () => link.graphPokes.length,
      (n) => n === 2
    )
    await new Promise((resolve) => setTimeout(resolve, 400))
    release()
    const [row] = await settled(board.id)
    expect(row!.outcome).toBe('wrong_status')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(posts()).toHaveLength(1)
    expect(await prisma.kanbanCommand.count()).toBe(1)
  })

  it('vera-415r2: B6 a failed refusal POST releases its claim, so the next delivery posts it once', async () => {
    const answers = [502, 201]
    const { github, board, link } = await boot('ready', { alice: 'admin' }, async () => answers.shift() ?? 201)
    const request = {
      secret: WEBHOOK_SECRET,
      event: 'issue_comment',
      payload: commentCreated('/kanban reopen', { login: 'alice', type: 'User' }),
      deliveryId: randomUUID()
    }
    const posts = () => writes(github.calls).filter((c) => c.path.endsWith('/comments'))
    await postGithubWebhook(link.webhookUrl, request)
    await until(
      async () => posts().length,
      (n) => n === 1
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await prisma.kanbanCommand.findFirstOrThrow()).settledAt).toBeNull()
    await postGithubWebhook(link.webhookUrl, request)
    await settled(board.id)
    expect(posts()).toHaveLength(2)
    expect(answers).toEqual([])
    expect(await prisma.kanbanCommand.count()).toBe(1)
  })

  it('vera-415r2: B6 an effect claim whose holder died is retried only after the TTL, exactly once', async () => {
    const { github, board, link } = await boot('ready')
    const request = {
      secret: WEBHOOK_SECRET,
      event: 'issue_comment',
      payload: commentCreated('/kanban reopen', { login: 'alice', type: 'User' }),
      deliveryId: randomUUID()
    }
    const posts = () => writes(github.calls).filter((c) => c.path.endsWith('/comments'))
    // A holder that claimed the effect and then died: the ledger row is recorded, claimed just now, never settled.
    const card = await prisma.kanbanCard.findFirstOrThrow({ where: { boardId: board.id } })
    await prisma.kanbanCommand.create({
      data: {
        id: randomUUID(),
        boardId: board.id,
        cardId: card.id,
        commentId: 5001n,
        command: 'reopen',
        actorLogin: 'alice',
        outcome: 'wrong_status',
        fromStatus: 'ready',
        effectClaimedAt: new Date()
      }
    })
    await postGithubWebhook(link.webhookUrl, request)
    await until(
      async () => link.graphPokes.length,
      (n) => n === 1
    )
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(posts()).toHaveLength(0)
    expect((await prisma.kanbanCommand.findFirstOrThrow()).settledAt).toBeNull()
    // Past the TTL the claim is stale: the redelivery takes it over and posts the one refusal.
    await prisma.kanbanCommand.updateMany({
      data: { effectClaimedAt: new Date(Date.now() - COMMAND_EFFECT_TTL_MS - 1_000) }
    })
    await postGithubWebhook(link.webhookUrl, request)
    await settled(board.id)
    expect(posts()).toHaveLength(1)
    expect((posts()[0]!.body as { body: string }).body).toContain('(wrong_status)')
  })

  it('a duplicate delivery of an applied command has exactly one effect', async () => {
    const { github, board, card, link } = await boot('triage')
    const request = {
      secret: WEBHOOK_SECRET,
      event: 'issue_comment',
      payload: commentCreated('/kanban ready', { login: 'alice', type: 'User' }),
      deliveryId: randomUUID()
    }
    await postGithubWebhook(link.webhookUrl, request)
    await settled(board.id)
    await postGithubWebhook(link.webhookUrl, { ...request, deliveryId: randomUUID() })
    await until(
      async () => link.graphPokes.length,
      (n) => n === 2
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).stateRevision).toBe(2n)
    expect(writes(github.calls).filter((c) => c.path.endsWith('/labels'))).toHaveLength(1)
    expect(writes(github.calls).some((c) => c.path.endsWith('/comments'))).toBe(false)
    expect(await prisma.auditEvent.count({ where: { kind: 'kanban_card_change' } })).toBe(1)
  })

  it('a bot or App sender never reaches the CP as a command: the relay forwards a seen-only marker', async () => {
    const { github, board, card, link } = await boot('blocked')
    await postGithubWebhook(link.webhookUrl, {
      secret: WEBHOOK_SECRET,
      event: 'issue_comment',
      payload: commentCreated('/kanban unblock', { login: `${APP_SLUG}[bot]`, type: 'Bot' })
    })
    expect(link.graphPokes).toEqual([expect.objectContaining({ ids: [], numbers: [] })])
    expect(link.graphPokes[0]!.command).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(github.calls).toEqual([])
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe('blocked')
    expect(await prisma.kanbanCommand.count({ where: { boardId: board.id } })).toBe(0)
  })
})

it('vera-415: an App-on-behalf-of-writer comment reaches the CP with viaApp and is refused', async () => {
  const { github, board, card, link } = await boot('blocked')
  const payload = {
    ...commentCreated('/kanban unblock', { login: 'alice', type: 'User' }),
    comment: { id: 5001, body: '/kanban unblock', performed_via_github_app: { id: 42, name: 'private app name' } }
  }
  await postGithubWebhook(link.webhookUrl, { secret: WEBHOOK_SECRET, event: 'issue_comment', payload })
  await new Promise((resolve) => setTimeout(resolve, 400))
  expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe('blocked')
  expect(link.graphPokes[0]?.command).toMatchObject({ viaApp: true })
  expect(JSON.stringify(link.graphPokes)).not.toContain('private app name')
  expect(await prisma.kanbanCommand.count({ where: { boardId: board.id } })).toBe(0)
  expect(writes(github.calls)).toEqual([])
})
