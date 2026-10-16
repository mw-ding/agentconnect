// GithubCardStore + KanbanLabelWriter over a scripted fetch: body-free reads, repo-id URLs, per-label add/remove writes.
import { describe, expect, it, vi } from 'vitest'
import type { FetchLike } from '../github/api.js'
import { GithubCardStore, type KanbanRepoRef } from './card-store.js'
import { planLabelReconcile, statusLabel } from './card-state.js'
import { cardIdempotencyKey } from './card-key.js'

const REPO: KanbanRepoRef = { installationId: 111n, repoId: 42n, repoFullName: 'acme/web' }

interface Call {
  url: string
  method: string
  auth: string | null
  body: unknown
}

function harness(routes: Record<string, () => Response>) {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url,
      method,
      auth: headers.authorization ?? null,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    })
    const path = url.replace('https://api.test', '')
    const route = routes[`${method} ${path}`]
    return route ? route() : json({ message: 'Not Found' }, 404)
  }
  const mintKanbanCard = vi.fn(async (_i: bigint, repoFullName: string, _r: bigint, access: 'read' | 'write') => ({
    token: `ghs_${access}`,
    ttlSec: 3600,
    expiresAt: '2026-10-15T01:00:00Z',
    repoFullName,
    access: 'read' as const
  }))
  const store = new GithubCardStore({ tokens: { mintKanbanCard }, fetchImpl, baseUrl: 'https://api.test' })
  return { store, calls, mintKanbanCard }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const issue = (over: Record<string, unknown> = {}) => ({
  id: 9001,
  node_id: 'I_kw9001',
  number: 7,
  title: 'Secret roadmap',
  body: 'SECRET-BODY',
  state: 'open',
  state_reason: null,
  labels: [{ name: statusLabel('ready') }, { name: 'bug' }],
  repository: { id: 42 },
  ...over
})

describe('GithubCardStore reads', () => {
  it('reads a card by repo id with a read-scoped card token and drops title and body', async () => {
    const h = harness({ 'GET /repositories/42/issues/7': () => json(issue()) })
    const card = await h.store.readCard(REPO, 7)
    expect(card).toEqual({
      issueId: 9001n,
      nodeId: 'I_kw9001',
      number: 7,
      state: 'open',
      stateReason: null,
      labels: ['ac/status:ready', 'bug']
    })
    expect(JSON.stringify(card, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toMatch(
      /SECRET|roadmap/
    )
    expect(h.mintKanbanCard).toHaveBeenCalledWith(111n, 'acme/web', 42n, 'read')
    expect(h.calls[0]!.auth).toBe('Bearer ghs_read')
  })

  it('answers null for a missing issue or a pull request', async () => {
    const h = harness({ 'GET /repositories/42/issues/8': () => json(issue({ number: 8, pull_request: {} })) })
    expect(await h.store.readCard(REPO, 7)).toBeNull()
    expect(await h.store.readCard(REPO, 8)).toBeNull()
  })

  it('reads the parent, sub-issues, and blocked_by graph', async () => {
    const h = harness({
      'GET /repositories/42/issues/7/parent': () => json(issue({ id: 1, number: 2 })),
      'GET /repositories/42/issues/7/sub_issues?per_page=100': () =>
        json([issue({ id: 3, number: 9, state: 'closed', state_reason: 'completed' })]),
      'GET /repositories/42/issues/7/dependencies/blocked_by?per_page=100': () =>
        json([issue({ id: 4, number: 5, repository: { id: 77 } })]),
      'GET /repositories/42/issues/7/dependencies/blocking?per_page=100': () => json([issue({ id: 6, number: 11 })])
    })
    expect(await h.store.readGraph(REPO, 7)).toEqual({
      parent: { issueId: 1n, number: 2, repoId: 42n, state: 'open', stateReason: null },
      subIssues: [{ issueId: 3n, number: 9, repoId: 42n, state: 'closed', stateReason: 'completed' }],
      blockedBy: [{ issueId: 4n, number: 5, repoId: 77n, state: 'open', stateReason: null }],
      blocking: [{ issueId: 6n, number: 11, repoId: 42n, state: 'open', stateReason: null }],
      truncated: false
    })
  })

  it('treats a missing parent as none and flags a full page as truncated', async () => {
    const page = Array.from({ length: 100 }, (_, i) => issue({ id: 100 + i, number: 100 + i }))
    const h = harness({
      'GET /repositories/42/issues/7/sub_issues?per_page=100': () => json(page),
      'GET /repositories/42/issues/7/dependencies/blocked_by?per_page=100': () => json([]),
      'GET /repositories/42/issues/7/dependencies/blocking?per_page=100': () => json([])
    })
    const graph = await h.store.readGraph(REPO, 7)
    expect(graph.parent).toBeNull()
    expect(graph.truncated).toBe(true)
  })

  it('flags a full blocking page as truncated', async () => {
    const page = Array.from({ length: 100 }, (_, i) => issue({ id: 100 + i, number: 100 + i }))
    const h = harness({
      'GET /repositories/42/issues/7/sub_issues?per_page=100': () => json([]),
      'GET /repositories/42/issues/7/dependencies/blocked_by?per_page=100': () => json([]),
      'GET /repositories/42/issues/7/dependencies/blocking?per_page=100': () => json(page)
    })
    expect((await h.store.readGraph(REPO, 7)).truncated).toBe(true)
  })
})

describe('KanbanLabelWriter via applyPlan', () => {
  it('makes no GitHub call, and mints no token, for a no-op plan', async () => {
    const h = harness({})
    const observed = { labels: [statusLabel('ready')], state: 'open' as const }
    await h.store.applyPlan(REPO, 7, observed, planLabelReconcile({ status: 'ready', leased: false }, observed))
    expect(h.calls).toEqual([])
    expect(h.mintKanbanCard).not.toHaveBeenCalled()
  })

  it('repairs drift with per-label add then remove, never PATCHing the label set, then comments', async () => {
    const h = harness({
      'POST /repositories/42/issues/7/labels': () => json([]),
      'DELETE /repositories/42/issues/7/labels/ac%2Fstatus%3Ablocked': () => json([]),
      'DELETE /repositories/42/issues/7/labels/ac%2Fstatus%3Atriage': () => json([]),
      'POST /repositories/42/issues/7/comments': () => json({ id: 1 }, 201)
    })
    const observed = { labels: ['bug', statusLabel('blocked'), statusLabel('triage')], state: 'open' as const }
    const plan = planLabelReconcile({ status: 'ready', leased: false }, observed)
    await h.store.applyPlan(REPO, 7, observed, plan)
    expect(h.mintKanbanCard).toHaveBeenCalledWith(111n, 'acme/web', 42n, 'write')
    expect(h.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://api.test/repositories/42/issues/7/labels',
      'DELETE https://api.test/repositories/42/issues/7/labels/ac%2Fstatus%3Ablocked',
      'DELETE https://api.test/repositories/42/issues/7/labels/ac%2Fstatus%3Atriage',
      'POST https://api.test/repositories/42/issues/7/comments'
    ])
    expect(h.calls[0]!.body).toEqual({ labels: ['ac/status:ready'] })
    expect(h.calls[0]!.auth).toBe('Bearer ghs_write')
    expect(h.calls[3]!.body).toEqual({ body: plan.comment })
  })

  it('tolerates a 404 on remove because the label is already gone', async () => {
    const h = harness({
      'POST /repositories/42/issues/7/labels': () => json([]),
      'POST /repositories/42/issues/7/comments': () => json({ id: 1 }, 201)
    })
    const observed = { labels: [statusLabel('ready'), statusLabel('triage')], state: 'open' as const }
    const plan = planLabelReconcile({ status: 'ready', leased: false }, observed)
    await h.store.applyPlan(REPO, 7, observed, plan)
    expect(h.calls.map((c) => c.method)).toEqual(['DELETE', 'POST'])
  })

  it('propagates a non-404 remove failure', async () => {
    const h = harness({
      'DELETE /repositories/42/issues/7/labels/ac%2Fstatus%3Atriage': () => json({ message: 'boom' }, 500)
    })
    const observed = { labels: [statusLabel('ready'), statusLabel('triage')], state: 'open' as const }
    const plan = planLabelReconcile({ status: 'ready', leased: false }, observed)
    await expect(h.store.applyPlan(REPO, 7, observed, plan)).rejects.toThrow()
  })

  it('closes as completed together with the done label', async () => {
    const h = harness({ 'PATCH /repositories/42/issues/7': () => json(issue()) })
    const observed = { labels: [statusLabel('done')], state: 'open' as const }
    await h.store.applyPlan(REPO, 7, observed, planLabelReconcile({ status: 'review', leased: false }, observed))
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.body).toEqual({ state: 'closed', state_reason: 'completed' })
  })

  it('reopens without touching labels when only the issue state drifted', async () => {
    const h = harness({ 'PATCH /repositories/42/issues/7': () => json(issue()) })
    const observed = { labels: [statusLabel('ready')], state: 'closed' as const, stateReason: 'completed' }
    await h.store.applyPlan(REPO, 7, observed, planLabelReconcile({ status: 'ready', leased: false }, observed))
    expect(h.calls[0]!.body).toEqual({ state: 'open', state_reason: 'reopened' })
  })
})

describe('cardIdempotencyKey', () => {
  it('is a stable sha256 over (epic, step, spec) with unambiguous framing', () => {
    const key = cardIdempotencyKey({ epic: '9001', step: 'split', spec: 'Add the board' })
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    expect(cardIdempotencyKey({ epic: '9001', step: 'split', spec: 'Add the board' })).toBe(key)
    expect(cardIdempotencyKey({ epic: '9001', step: 'split', spec: 'Add the board!' })).not.toBe(key)
    expect(cardIdempotencyKey({ epic: 'a', step: 'bc', spec: '' })).not.toBe(
      cardIdempotencyKey({ epic: 'ab', step: 'c', spec: '' })
    )
  })
})

describe('display-only mode labels', () => {
  it('ignores a User/PAT label grant and never consults issue events', async () => {
    const events = vi.fn(() =>
      json([
        {
          id: 1,
          event: 'labeled',
          label: { name: 'ac/mode:write' },
          actor: { type: 'User', login: 'maintainer' },
          performed_via_github_app: null
        }
      ])
    )
    const h = harness({
      'GET /repositories/42/issues/7': () => json(issue({ labels: ['ac/status:ready', 'ac/mode:write'] })),
      'GET /repositories/42/issues/7/events?per_page=100&page=1': events
    })
    expect(await h.store.readCard(REPO, 7)).toMatchObject({ labels: ['ac/status:ready', 'ac/mode:write'] })
    expect(h.calls).toHaveLength(1)
    expect(events).not.toHaveBeenCalled()
  })
})
