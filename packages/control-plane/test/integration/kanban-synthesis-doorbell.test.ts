// Synthesis through the real app wiring (issue #2 B3): a signed sub-issue close/reopen -> relay -> CP doorbell -> reconciler.
import { afterEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { buildApp, type App } from '../../src/app.js'
import { AppConfigSchema } from '../../src/config/env.js'
import { systemClock } from '../../src/domain/clock.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { postGithubWebhook, startRelayCpLink, type RelayCpLink } from '../fixtures/relay-link.js'
import { seedAgent } from '../fixtures/seed.js'

const RELAY_TOKEN = 'relay-shared-secret-0123456789abcdef'
const WEBHOOK_SECRET = 'kanban-webhook-secret-0123456789'
const INSTALLATION_ID = 81
const REPO_ID = 5151
const EPIC = { id: 70007, number: 7 }
const CHILD = { id: 90009, number: 9 }
const SYNTH = 'e1111111-1111-4111-8111-111111111111'
const HUMAN = { type: 'User', login: 'alice', id: 1001 }

interface Call {
  method: string
  path: string
  body?: unknown
}

// The epic #7 is todo with one sub-issue #9; `child` is #9's live state.
function fakeGithub(child: { state: 'open' | 'closed'; reason: string | null }) {
  const calls: Call[] = []
  let epicLabels = ['ac/status:todo']
  const issue = (n: { id: number; number: number }, state: string, reason: string | null, labels: string[]) => ({
    id: n.id,
    node_id: `I_${n.number}`,
    number: n.number,
    state,
    state_reason: reason,
    labels: labels.map((name) => ({ name })),
    repository: { id: REPO_ID },
    user: { login: 'alice', type: 'User' }
  })
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
    if (pathname.match(new RegExp(`^/repositories/${REPO_ID}/collaborators/[^/]+/permission$`))) {
      return json(200, { permission: 'write', role_name: 'write' })
    }
    const repo = `/repositories/${REPO_ID}/issues`
    const childIssue = issue(CHILD, child.state, child.reason, [])
    if (pathname === `${repo}/${CHILD.number}`) return json(200, childIssue)
    if (pathname === `${repo}/${CHILD.number}/parent`) return json(200, issue(EPIC, 'open', null, epicLabels))
    if (pathname === `${repo}/${EPIC.number}`) return json(200, issue(EPIC, 'open', null, epicLabels))
    if (pathname === `${repo}/${EPIC.number}/parent`) return json(404, { message: 'Not Found' })
    if (pathname === `${repo}/${EPIC.number}/sub_issues`) return json(200, [childIssue])
    if (pathname === `${repo}/${EPIC.number}/events`) {
      return json(200, [
        { id: 41, event: 'labeled', label: { name: 'ac/status:todo' }, actor: { login: 'alice', type: 'User' } }
      ])
    }
    if (pathname === `${repo}/${EPIC.number}/labels` && method === 'POST') {
      epicLabels = [...new Set([...epicLabels, ...(body!.labels as string[])])]
      return json(200, [])
    }
    if (pathname.startsWith(`${repo}/${EPIC.number}/labels/`) && method === 'DELETE') {
      const name = decodeURIComponent(pathname.slice(`${repo}/${EPIC.number}/labels/`.length))
      epicLabels = epicLabels.filter((l) => l !== name)
      return json(200, [])
    }
    if (pathname.startsWith(`${repo}/`)) return json(200, [])
    return json(404, { message: 'Not Found' })
  }
  return { calls, fetch, epicLabels: () => epicLabels }
}

let app: App | undefined
let link: RelayCpLink | undefined

afterEach(async () => {
  await link?.close()
  link = undefined
  await app?.shutdown()
  app = undefined
})

async function boot(child: { state: 'open' | 'closed'; reason: string | null }) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const github = fakeGithub(child)
  await prisma.githubInstallation.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      installationId: BigInt(INSTALLATION_ID),
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'all'
    }
  })
  await seedAgent(prisma, SYNTH, { name: 'synth' })
  const board = await prisma.kanbanBoard.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      name: 'board',
      paused: true,
      repoId: BigInt(REPO_ID),
      repoFullName: 'acme/board',
      synthesizerAgentId: SYNTH
    }
  })
  const epic = await prisma.kanbanCard.create({
    data: { boardId: board.id, issueId: BigInt(EPIC.id), issueNumber: EPIC.number, status: 'todo' }
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
  return { github, epic, link }
}

const issuesEvent = (action: 'closed' | 'reopened', state: 'open' | 'closed', reason: string | null) => ({
  action,
  issue: { ...CHILD, state, state_reason: reason, labels: [], user: { login: 'alice', type: 'User' } },
  repository: { id: REPO_ID, full_name: 'acme/board', url: 'https://api.github.com/repos/acme/board' },
  installation: { id: INSTALLATION_ID },
  sender: HUMAN
})

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value) || Date.now() > deadline) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('416c: synthesis through the real container doorbell wiring (real relay, real Postgres)', () => {
  it('416c: the last sub-issue closing completed promotes the epic to the synthesizer with its agent label', async () => {
    const { github, epic, link } = await boot({ state: 'closed', reason: 'completed' })
    const sent = await postGithubWebhook(link.webhookUrl, {
      secret: WEBHOOK_SECRET,
      event: 'issues',
      payload: issuesEvent('closed', 'closed', 'completed')
    })
    expect(sent.status).toBe(202)
    const landed = await until(
      () => prisma.kanbanCard.findUniqueOrThrow({ where: { id: epic.id } }),
      (c) => c.status === 'ready' && !c.promotionPending
    )
    expect(landed).toMatchObject({ status: 'ready', assigneeAgentId: SYNTH, promotionPending: false })
    expect(github.epicLabels().sort()).toEqual(['ac/agent:synth', 'ac/status:ready'])
  })

  it('416c: a sub-issue reopening re-reads the parent epic and leaves it todo', async () => {
    const { github, epic, link } = await boot({ state: 'open', reason: null })
    const sent = await postGithubWebhook(link.webhookUrl, {
      secret: WEBHOOK_SECRET,
      event: 'issues',
      payload: issuesEvent('reopened', 'open', null)
    })
    expect(sent.status).toBe(202)
    const subIssues = `/repositories/${REPO_ID}/issues/${EPIC.number}/sub_issues`
    await until(
      async () => github.calls.filter((c) => c.path === subIssues).length,
      (n) => n > 0
    )
    expect(github.calls.map((c) => c.path)).toContain(subIssues)
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: epic.id } })).toMatchObject({
      status: 'todo',
      promotionPending: false
    })
    expect(github.epicLabels()).toEqual(['ac/status:todo'])
  })
})
