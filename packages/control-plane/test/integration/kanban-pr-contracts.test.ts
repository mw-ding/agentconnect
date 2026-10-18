// PR completion contracts end to end: signed pull_request/check_suite -> real relay -> rc/github-graph -> CP -> Postgres + GitHub.
import { afterEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { buildApp, type App } from '../../src/app.js'
import { AppConfigSchema } from '../../src/config/env.js'
import { systemClock } from '../../src/domain/clock.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { postGithubWebhook, startRelayCpLink, type RelayCpLink } from '../fixtures/relay-link.js'
import { GithubCardStore } from '../../src/kanban/card-store.js'
import { KanbanPrContracts } from '../../src/kanban/pr-contracts.js'
import { GithubPrReader } from '../../src/kanban/pr-reader.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/index.js'
import { seedAgent } from '../fixtures/seed.js'

const RELAY_TOKEN = 'relay-shared-secret-0123456789abcdef'
const WEBHOOK_SECRET = 'kanban-webhook-secret-0123456789'
const INSTALLATION_ID = 79
const REPO_ID = 4444
const ISSUE = { id: 90009, number: 9 }
const PR = 21
const HEAD = 'c'.repeat(40)
const OLD = 'd'.repeat(40)
const VERIFIER = 'f1111111-1111-4111-8111-111111111111'

interface GithubCall {
  method: string
  path: string
  body?: unknown
}

interface PrState {
  state: 'open' | 'closed'
  merged: boolean
  headSha: string
  unbound?: boolean
  headRef?: string
  workflows?: Array<{ check_suite_id: number; path: string }>
  runs: Array<{
    status: string
    conclusion: string | null
    name?: string
    app?: { id: number; slug: string }
    check_suite?: { id: number }
  }>
}

function fakeGithub(pr: PrState) {
  const calls: GithubCall[] = []
  let labels = ['ac/status:review']
  let state: 'open' | 'closed' = 'open'
  let stateReason: string | null = null
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
    if (pathname === `/repositories/${REPO_ID}`) return json(200, { default_branch: 'main' })
    if (pathname === `/repositories/${REPO_ID}/actions/runs`)
      return json(200, {
        total_count: pr.workflows?.length ?? 0,
        workflow_runs: pr.workflows ?? []
      })
    if (pathname === `/repositories/${REPO_ID}/pulls/${PR}`) {
      return json(200, {
        number: PR,
        state: pr.state,
        merged: pr.merged,
        user: { login: pr.unbound ? 'unrelated' : 'agentconnect-test[bot]', type: pr.unbound ? 'User' : 'Bot' },
        head: { sha: pr.headSha, ref: pr.headRef ?? 'ac/card-9', repo: { id: REPO_ID } },
        base: { ref: 'main' },
        created_at: pr.unbound ? '2020-01-01T00:00:00Z' : '2026-10-16T00:00:00Z'
      })
    }
    if (pathname === `/repositories/${REPO_ID}/commits/${pr.headSha}/check-runs`) {
      // Give each check an identity unless the test explicitly supplies a workflow collision.
      return json(200, {
        total_count: pr.runs.length,
        check_runs: pr.runs.map((r, i) => ({ id: i + 1, name: `check-${i}`, ...r }))
      })
    }
    const base = `/repositories/${REPO_ID}/issues/${ISSUE.number}`
    if (pathname === base && method === 'GET') {
      return json(200, {
        id: ISSUE.id,
        node_id: 'I_9',
        number: ISSUE.number,
        state,
        state_reason: stateReason,
        labels: labels.map((name) => ({ name })),
        repository: { id: REPO_ID }
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
      labels = labels.filter((l) => l !== decodeURIComponent(pathname.slice(`${base}/labels/`.length)))
      return json(200, [])
    }
    if (pathname === `${base}/comments` && method === 'POST') return json(201, { id: 1 })
    return json(404, { message: 'Not Found' })
  }
  return { calls, fetch, labels: () => labels, issueState: () => ({ state, stateReason }) }
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
  pr: PrState,
  board: { completionContract: 'pr_merged' | 'pr_checks_green'; verifier?: boolean },
  card: { verifiedAt?: Date | null; linkedPrNumber?: number | null } = {}
) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const github = fakeGithub(pr)
  await prisma.githubInstallation.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      installationId: BigInt(INSTALLATION_ID),
      accountLogin: 'acme',
      accountType: 'Organization',
      repositorySelection: 'all'
    }
  })
  const verifier = board.verifier ? { id: await seedAgent(prisma, VERIFIER) } : null
  const row = await prisma.kanbanBoard.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      name: 'board',
      repoId: BigInt(REPO_ID),
      repoFullName: 'acme/board',
      completionContract: board.completionContract,
      ...(verifier ? { verifierAgentId: verifier.id } : {})
    }
  })
  const created = await prisma.kanbanCard.create({
    data: {
      boardId: row.id,
      issueId: BigInt(ISSUE.id),
      issueNumber: ISSUE.number,
      status: 'review',
      linkedPrNumber: card.linkedPrNumber === undefined ? PR : card.linkedPrNumber,
      verifiedAt: card.verifiedAt ?? null,
      linkedPrWorkStartedAt: new Date('2026-10-15T00:00:00Z')
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
  return { github, board: row, card: created, link }
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value) || Date.now() > deadline) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const repository = { id: REPO_ID, full_name: 'acme/board', url: 'https://api.github.com/repos/acme/board' }
const prClosed = (merged: boolean, headSha = HEAD) => ({
  action: 'closed',
  number: PR,
  pull_request: { number: PR, title: 'secret', body: 'secret', merged, head: { sha: headSha, ref: 'feature' } },
  repository,
  installation: { id: INSTALLATION_ID },
  sender: { login: 'alice', type: 'User' }
})
const suiteCompleted = (headSha: string) => ({
  action: 'completed',
  check_suite: { id: 1, head_sha: headSha, conclusion: 'success', pull_requests: [{ number: PR }] },
  repository,
  installation: { id: INSTALLATION_ID },
  sender: { login: 'github-actions[bot]', type: 'Bot' }
})
const cardOf = (id: string) => prisma.kanbanCard.findUniqueOrThrow({ where: { id } })
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 400))
}
const comments = (calls: GithubCall[]) => calls.filter((c) => c.method === 'POST' && c.path.endsWith('/comments'))

describe('Kanban PR completion contracts through the real relay (real ports, real Postgres)', () => {
  it('vera-415: P2 an old unrelated merged PR leaves the card in review', async () => {
    const { github, card, link } = await boot(
      { state: 'closed', merged: true, headSha: HEAD, runs: [], unbound: true },
      { completionContract: 'pr_merged' }
    )
    await postGithubWebhook(link.webhookUrl, { secret: WEBHOOK_SECRET, event: 'pull_request', payload: prClosed(true) })
    await settle()
    expect((await cardOf(card.id)).status).toBe('review')
    expect(github.issueState().state).toBe('open')
    expect(comments(github.calls)).toEqual([])
  })

  it('vera-415: P1 two workflows named test retain a failure; rerunning that workflow replaces it', async () => {
    const pr: PrState = {
      state: 'open',
      merged: false,
      headSha: HEAD,
      runs: [
        {
          name: 'test',
          app: { id: 15368, slug: 'github-actions' },
          check_suite: { id: 1 },
          status: 'completed',
          conclusion: 'failure'
        },
        {
          name: 'test',
          app: { id: 15368, slug: 'github-actions' },
          check_suite: { id: 2 },
          status: 'completed',
          conclusion: 'success'
        }
      ],
      workflows: [
        { check_suite_id: 1, path: 'ci.yml' },
        { check_suite_id: 2, path: 'e2e.yml' }
      ]
    }
    const { card, link } = await boot(pr, { completionContract: 'pr_checks_green' })
    const ring = () =>
      postGithubWebhook(link.webhookUrl, {
        secret: WEBHOOK_SECRET,
        event: 'check_suite',
        payload: suiteCompleted(HEAD)
      })
    await ring()
    await settle()
    expect((await cardOf(card.id)).status).toBe('review')
    pr.workflows![1]!.path = 'ci.yml'
    await ring()
    expect(
      (
        await until(
          () => cardOf(card.id),
          (c) => c.status === 'done'
        )
      ).status
    ).toBe('done')
  })

  it('vera-415: skipped-only checks leave a pr_checks_green card in review', async () => {
    const { card, link } = await boot(
      { state: 'open', merged: false, headSha: HEAD, runs: [{ status: 'completed', conclusion: 'skipped' }] },
      { completionContract: 'pr_checks_green' }
    )
    await postGithubWebhook(link.webhookUrl, {
      secret: WEBHOOK_SECRET,
      event: 'check_suite',
      payload: suiteCompleted(HEAD)
    })
    await settle()
    expect((await cardOf(card.id)).status).toBe('review')
  })

  it('pr_merged: a merged linked PR moves review → done, closes the issue as completed, and audits the contract', async () => {
    const pr: PrState = { state: 'closed', merged: true, headSha: HEAD, runs: [] }
    const { github, card, link } = await boot(pr, { completionContract: 'pr_merged' })
    const sent = await postGithubWebhook(link.webhookUrl, {
      secret: WEBHOOK_SECRET,
      event: 'pull_request',
      payload: prClosed(true)
    })
    expect(sent.status).toBe(202)
    expect(link.graphPokes).toEqual([
      expect.objectContaining({ event: 'pull_request', pullRequest: { number: PR, merged: true, headSha: HEAD } })
    ])
    expect(JSON.stringify(link.graphPokes)).not.toContain('secret')
    const done = await until(
      () => cardOf(card.id),
      (c) => c.status === 'done'
    )
    expect(done.status).toBe('done')
    await until(
      async () => github.issueState().state,
      (s) => s === 'closed'
    )
    expect(github.issueState()).toEqual({ state: 'closed', stateReason: 'completed' })
    expect(github.labels()).toEqual(['ac/status:done'])
    // The PR read used the CP-only contract token.
    const mint = github.calls.find(
      (c) => c.path.endsWith('/access_tokens') && JSON.stringify(c.body).includes('checks')
    )
    expect(mint?.body).toEqual({
      repository_ids: [REPO_ID],
      permissions: { metadata: 'read', checks: 'read', pull_requests: 'read', actions: 'read' }
    })
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { kind: 'kanban_card_change' } })
    expect(audit.details).toMatchObject({
      from: 'review',
      to: 'done',
      reason: 'pr_merged',
      prNumber: PR,
      source: 'pr_contract'
    })
  })

  it('a linked PR closed unmerged moves the card to triage with the attention flag and exactly one comment', async () => {
    const pr: PrState = { state: 'closed', merged: false, headSha: HEAD, runs: [] }
    const { github, card, link } = await boot(pr, { completionContract: 'pr_merged' })
    const request = { secret: WEBHOOK_SECRET, event: 'pull_request', payload: prClosed(false) }
    await postGithubWebhook(link.webhookUrl, request)
    await until(
      () => cardOf(card.id),
      (c) => c.status === 'triage'
    )
    // A second delivery finds the card no longer in review and does nothing.
    await postGithubWebhook(link.webhookUrl, request)
    await settle()
    expect(await cardOf(card.id)).toMatchObject({
      status: 'triage',
      needsAttention: true,
      attentionReason: 'pr_closed_unmerged'
    })
    expect(comments(github.calls)).toHaveLength(1)
    expect((comments(github.calls)[0]!.body as { body: string }).body).toContain('pr_closed_unmerged')
    expect(github.labels()).toEqual(['ac/status:triage'])
  })

  it('pr_merged waits for the verifier; a verified card completes on the doorbell', async () => {
    const pr: PrState = { state: 'closed', merged: true, headSha: HEAD, runs: [] }
    const waiting = await boot(pr, { completionContract: 'pr_merged', verifier: true })
    await postGithubWebhook(waiting.link.webhookUrl, {
      secret: WEBHOOK_SECRET,
      event: 'pull_request',
      payload: prClosed(true)
    })
    await settle()
    expect((await cardOf(waiting.card.id)).status).toBe('review')
    await prisma.kanbanCard.update({ where: { id: waiting.card.id }, data: { verifiedAt: new Date() } })
    await postGithubWebhook(waiting.link.webhookUrl, {
      secret: WEBHOOK_SECRET,
      event: 'pull_request',
      payload: prClosed(true)
    })
    expect(
      (
        await until(
          () => cardOf(waiting.card.id),
          (c) => c.status === 'done'
        )
      ).status
    ).toBe('done')
  })

  it('pr_checks_green: a green suite on the current head completes; a stale head or a failing run does not', async () => {
    const pr: PrState = {
      state: 'open',
      merged: false,
      headSha: HEAD,
      runs: [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'failure' }
      ]
    }
    const { card, link } = await boot(pr, { completionContract: 'pr_checks_green' })
    const ring = (sha: string) =>
      postGithubWebhook(link.webhookUrl, { secret: WEBHOOK_SECRET, event: 'check_suite', payload: suiteCompleted(sha) })
    await ring(HEAD)
    await settle()
    expect((await cardOf(card.id)).status).toBe('review')
    pr.runs = [
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'skipped' }
    ]
    await ring(OLD)
    await settle()
    expect((await cardOf(card.id)).status).toBe('review')
    expect(link.graphPokes.at(-1)).toMatchObject({
      event: 'check_suite',
      checkSuite: { headSha: OLD, prNumbers: [PR] }
    })
    await ring(HEAD)
    expect(
      (
        await until(
          () => cardOf(card.id),
          (c) => c.status === 'done'
        )
      ).status
    ).toBe('done')
  })

  it('the sweep completes a card whose doorbell was missed, and the verifier re-check completes a verified card', async () => {
    const pr: PrState = { state: 'closed', merged: true, headSha: HEAD, runs: [] }
    const { github, board, card } = await boot(pr, { completionContract: 'pr_merged', verifier: true })
    const tokens = { mintKanbanCard: async () => ({ token: 't' }), mintKanbanPr: async () => ({ token: 't' }) }
    const contracts = new KanbanPrContracts({
      appSlug: 'agentconnect-test',
      repo: new PgKanbanDispatchRepo(prisma),
      prs: new GithubPrReader({ tokens: tokens as never, fetchImpl: github.fetch }),
      store: new GithubCardStore({ tokens: tokens as never, fetchImpl: github.fetch }),
      repoRef: async () => ({
        installationId: BigInt(INSTALLATION_ID),
        repoId: BigInt(REPO_ID),
        repoFullName: 'acme/board'
      }),
      log: { info: () => {}, warn: () => {} }
    })
    // Unverified: neither path moves it.
    await contracts.sweep(board.id)
    expect(await contracts.onVerified(card.id)).toBe('wait')
    expect((await cardOf(card.id)).status).toBe('review')
    // The verifier approved after the merge: the approval path completes it without another event.
    await prisma.kanbanCard.update({ where: { id: card.id }, data: { verifiedAt: new Date() } })
    expect(await contracts.onVerified(card.id)).toBe('done')
    expect(await cardOf(card.id)).toMatchObject({ status: 'done', verifiedAt: null })
    expect(github.issueState()).toEqual({ state: 'closed', stateReason: 'completed' })

    // A second card with no doorbell at all is found by the bounded sweep.
    const other = await prisma.kanbanCard.create({
      data: {
        boardId: board.id,
        issueId: 90010n,
        issueNumber: 10,
        status: 'review',
        linkedPrNumber: PR,
        linkedPrWorkStartedAt: new Date('2026-10-15T00:00:00Z'),
        verifiedAt: new Date()
      }
    })
    pr.headRef = 'ac/card-10'
    await contracts.sweep(board.id)
    expect((await cardOf(other.id)).status).toBe('done')
    // Leased and non-review cards are never listed.
    expect(await new PgKanbanDispatchRepo(prisma).listContractCards(board.id, {})).toEqual([])
  })
})
