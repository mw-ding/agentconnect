// GithubPrReader over a fake fetch: repo-id addressing, the PR-contract token, 404 handling, and bounded check-run paging.
import { describe, expect, it, vi } from 'vitest'
import { GithubApiError } from '../github/api.js'
import { checksVerdict } from './contracts.js'
import { GithubPrReader } from './pr-reader.js'

const REPO = { installationId: 9n, repoId: 42n, repoFullName: 'acme/web' }
const SHA = 'a'.repeat(40)
const PR_FIELDS = {
  user: { login: 'agentconnect[bot]', type: 'Bot' },
  head: { sha: SHA, ref: 'ac/card-7', repo: { id: 42 } },
  base: { ref: 'main' },
  created_at: '2026-10-16T00:00:00Z'
}

function harness(routes: Record<string, (url: URL) => { status: number; body: unknown }>) {
  const urls: URL[] = []
  const auths = new Map<string, string>()
  const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    urls.push(url)
    auths.set(url.pathname, new Headers(init?.headers).get('authorization') ?? '')
    const route =
      routes[url.pathname] ??
      (url.pathname === '/repositories/42' ? () => ({ status: 200, body: { default_branch: 'main' } }) : undefined)
    const { status, body } = route ? route(url) : { status: 404, body: { message: 'Not Found' } }
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  })
  const mintKanbanPr = vi.fn(async () => ({
    token: 'ghs_pr',
    ttlSec: 3600,
    expiresAt: '',
    repoFullName: 'acme/web',
    access: 'read' as const
  }))
  const mintKanbanActions = vi.fn(async () => ({
    token: 'ghs_actions',
    ttlSec: 3600,
    expiresAt: '',
    repoFullName: 'acme/web',
    access: 'read' as const
  }))
  const reader = new GithubPrReader({ tokens: { mintKanbanPr, mintKanbanActions }, fetchImpl: fetchImpl as never })
  return { reader, urls, auths, mintKanbanPr, mintKanbanActions }
}

describe('GithubPrReader', () => {
  it('reads a PR by repository id with the PR-contract token, keeping only state, merged, and head', async () => {
    const h = harness({
      '/repositories/42/pulls/12': () => ({
        status: 200,
        body: {
          number: 12,
          state: 'closed',
          merged: true,
          title: 'secret',
          body: 'secret',
          merged_by: { login: 'octocat', name: 'secret' },
          ...PR_FIELDS
        }
      })
    })
    expect(await h.reader.readPullRequest(REPO, 12)).toEqual({
      number: 12,
      state: 'closed',
      merged: true,
      headSha: SHA,
      authorLogin: 'agentconnect[bot]',
      authorType: 'Bot',
      headRef: 'ac/card-7',
      headRepoId: 42n,
      baseRef: 'main',
      defaultBranch: 'main',
      createdAt: new Date(PR_FIELDS.created_at),
      mergedByLogin: 'octocat'
    })
    expect(h.mintKanbanPr).toHaveBeenCalledWith(9n, 'acme/web', 42n)
    expect(h.mintKanbanActions).not.toHaveBeenCalled()
  })

  it('treats merged_at as merged (list-shaped payloads omit `merged`) and a missing PR as null', async () => {
    const h = harness({
      '/repositories/42/pulls/12': () => ({
        status: 200,
        body: { number: 12, state: 'closed', merged_at: '2026-10-17T00:00:00Z', ...PR_FIELDS }
      })
    })
    expect((await h.reader.readPullRequest(REPO, 12))?.merged).toBe(true)
    expect(await h.reader.readPullRequest(REPO, 13)).toBeNull()
  })

  it('rethrows a non-404 failure so the doorbell stays unlanded', async () => {
    const h = harness({ '/repositories/42/pulls/12': () => ({ status: 502, body: {} }) })
    await expect(h.reader.readPullRequest(REPO, 12)).rejects.toThrow()
  })

  it('reads the latest check runs of one sha, paging until total_count', async () => {
    // Distinct check identities stay independent across pages.
    const run = (i: number) => ({
      id: i + 1,
      name: `check-${i}`,
      status: 'completed',
      conclusion: i === 0 ? 'neutral' : 'success',
      output: { text: 'x' }
    })
    const h = harness({
      [`/repositories/42/commits/${SHA}/check-runs`]: (url) => {
        const page = Number(url.searchParams.get('page'))
        expect(url.searchParams.get('filter')).toBe('latest')
        return {
          status: 200,
          body: {
            total_count: 150,
            check_runs: Array.from({ length: page === 1 ? 100 : 50 }, (_, i) => run((page - 1) * 100 + i))
          }
        }
      }
    })
    const result = await h.reader.readCheckRuns(REPO, SHA)
    expect(result.complete).toBe(true)
    expect(result.runs).toHaveLength(150)
    expect(result.runs[0]).toEqual({ status: 'completed', conclusion: 'neutral' })
    expect(h.urls).toHaveLength(2)
  })

  it('reports an incomplete list past the page bound', async () => {
    const h = harness({
      [`/repositories/42/commits/${SHA}/check-runs`]: () => ({
        status: 200,
        body: {
          total_count: 1000,
          check_runs: Array.from({ length: 100 }, (_, i) => ({
            id: i,
            name: `c${i}`,
            status: 'completed',
            conclusion: 'success'
          }))
        }
      })
    })
    expect((await h.reader.readCheckRuns(REPO, SHA)).complete).toBe(false)
    expect(h.urls).toHaveLength(3)
  })

  it('keeps only the newest run of each check, so a green re-run in a new suite supersedes the old failure', async () => {
    const h = harness({
      '/repositories/42/actions/runs': () => ({
        status: 200,
        body: {
          total_count: 2,
          workflow_runs: [
            { check_suite_id: 1, path: 'conventional.yml' },
            { check_suite_id: 2, path: 'conventional.yml' }
          ]
        }
      }),
      [`/repositories/42/commits/${SHA}/check-runs`]: () => ({
        status: 200,
        body: {
          total_count: 4,
          check_runs: [
            {
              id: 20,
              name: 'Conventional PR',
              app: { id: 15368, slug: 'github-actions' },
              check_suite: { id: 1 },
              status: 'completed',
              conclusion: 'success'
            },
            {
              id: 10,
              name: 'Conventional PR',
              app: { id: 15368, slug: 'github-actions' },
              check_suite: { id: 2 },
              status: 'completed',
              conclusion: 'failure'
            },
            { id: 11, name: 'Conventional PR', app: { id: 999 }, status: 'completed', conclusion: 'failure' },
            { id: 12, name: 'lint', app: { id: 15368 }, status: 'in_progress', conclusion: null }
          ]
        }
      })
    })
    expect((await h.reader.readCheckRuns(REPO, SHA)).runs).toEqual([
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'failure' },
      { status: 'in_progress', conclusion: null }
    ])
  })
})

const actionsRun = (id: number, suite: number, conclusion: string) => ({
  id,
  name: 'test',
  app: { id: 15368, slug: 'github-actions' },
  check_suite: { id: suite },
  status: 'completed',
  conclusion
})

it.each([false, true])(
  'vera-415: workflow identity preserves failures while same-workflow reruns supersede them (%s)',
  async (sameWorkflow) => {
    const h = harness({
      [`/repositories/42/commits/${SHA}/check-runs`]: () => ({
        status: 200,
        body: {
          total_count: 2,
          check_runs: [actionsRun(100, 1, 'failure'), actionsRun(200, 2, 'success')]
        }
      }),
      '/repositories/42/actions/runs': (url) => {
        expect(url.searchParams.get('head_sha')).toBe(SHA)
        return {
          status: 200,
          body: {
            total_count: 2,
            workflow_runs: [
              { check_suite_id: 1, path: '.github/workflows/ci.yml' },
              { check_suite_id: 2, path: sameWorkflow ? '.github/workflows/ci.yml' : '.github/workflows/e2e.yml' }
            ]
          }
        }
      }
    })
    const result = await h.reader.readCheckRuns(REPO, SHA)
    expect(result.complete).toBe(true)
    expect(result.runs).toHaveLength(sameWorkflow ? 1 : 2)
    expect(checksVerdict(result.runs)).toBe(sameWorkflow ? 'green' : 'failed')
  }
)

it('vera-415: unmapped Actions suites and non-Actions suites never hide a same-named failure', async () => {
  for (const slug of ['github-actions', 'external-ci']) {
    const h = harness({
      [`/repositories/42/commits/${SHA}/check-runs`]: () => ({
        status: 200,
        body: {
          total_count: 2,
          check_runs: [actionsRun(1, 1, 'failure'), actionsRun(2, 2, 'success')].map((r) => ({
            ...r,
            app: { id: 15368, slug }
          }))
        }
      }),
      '/repositories/42/actions/runs': () => ({ status: 200, body: { total_count: 0, workflow_runs: [] } })
    })
    const result = await h.reader.readCheckRuns(REPO, SHA)
    expect(result.runs).toHaveLength(2)
    expect(checksVerdict(result.runs)).toBe('failed')
  }
})

it.each([150, 1000])(
  'vera-415: workflow mapping pages are bounded and truncation cannot complete a contract (%s)',
  async (total) => {
    const h = harness({
      [`/repositories/42/commits/${SHA}/check-runs`]: () => ({
        status: 200,
        body: { total_count: 1, check_runs: [actionsRun(1, 1, 'success')] }
      }),
      '/repositories/42/actions/runs': (url) => {
        const page = Number(url.searchParams.get('page'))
        const size = Math.min(100, total - (page - 1) * 100)
        return {
          status: 200,
          body: {
            total_count: total,
            workflow_runs: Array.from({ length: size }, (_, i) => ({
              check_suite_id: (page - 1) * 100 + i + 1,
              path: `ci-${i}.yml`
            }))
          }
        }
      }
    })
    const result = await h.reader.readCheckRuns(REPO, SHA)
    expect(result.complete).toBe(total === 150)
    expect(h.urls.filter((u) => u.pathname.endsWith('/actions/runs'))).toHaveLength(total === 150 ? 2 : 3)
  }
)

it('vera-415: the hosted Actions app id identifies workflow reruns when app slug is absent', async () => {
  const h = harness({
    [`/repositories/42/commits/${SHA}/check-runs`]: () => ({
      status: 200,
      body: {
        total_count: 2,
        check_runs: [actionsRun(1, 1, 'failure'), actionsRun(2, 2, 'success')].map((r) => ({
          ...r,
          app: { id: 15368 }
        }))
      }
    }),
    '/repositories/42/actions/runs': () => ({
      status: 200,
      body: {
        total_count: 2,
        workflow_runs: [
          { check_suite_id: 1, path: 'ci.yml' },
          { check_suite_id: 2, path: 'ci.yml' }
        ]
      }
    })
  })
  const result = await h.reader.readCheckRuns(REPO, SHA)
  expect(result.runs).toHaveLength(1)
  expect(checksVerdict(result.runs)).toBe('green')
})

it('vera-415 event key: a push success on the same workflow and job cannot hide a pull_request failure', async () => {
  const h = harness({
    [`/repositories/42/commits/${SHA}/check-runs`]: () => ({
      status: 200,
      body: { total_count: 2, check_runs: [actionsRun(100, 1, 'failure'), actionsRun(200, 2, 'success')] }
    }),
    '/repositories/42/actions/runs': () => ({
      status: 200,
      body: {
        total_count: 2,
        workflow_runs: [
          { check_suite_id: 1, path: '.github/workflows/ci.yml', event: 'pull_request' },
          { check_suite_id: 2, path: '.github/workflows/ci.yml', event: 'push' }
        ]
      }
    })
  })
  const result = await h.reader.readCheckRuns(REPO, SHA)
  expect(result.runs).toHaveLength(2)
  expect(checksVerdict(result.runs)).toBe('failed')
})

it('vera-415 actions:read: only the workflow lookup uses the separate actions token', async () => {
  const h = harness({
    [`/repositories/42/commits/${SHA}/check-runs`]: () => ({
      status: 200,
      body: { total_count: 1, check_runs: [actionsRun(1, 1, 'success')] }
    }),
    '/repositories/42/actions/runs': () => ({
      status: 200,
      body: { total_count: 1, workflow_runs: [{ check_suite_id: 1, path: 'ci.yml', event: 'pull_request' }] }
    })
  })
  const result = await h.reader.readCheckRuns(REPO, SHA)
  expect(result).toEqual({ runs: [{ status: 'completed', conclusion: 'success' }], complete: true })
  expect(h.auths.get(`/repositories/42/commits/${SHA}/check-runs`)).toBe('Bearer ghs_pr')
  expect(h.auths.get('/repositories/42/actions/runs')).toBe('Bearer ghs_actions')
  expect(h.mintKanbanActions).toHaveBeenCalledWith(9n, 'acme/web', 42n)
})

it('vera-415 actions:read: a refused actions mint or a 403 runs list reads as actionsUnreadable, never complete', async () => {
  const routes = {
    [`/repositories/42/commits/${SHA}/check-runs`]: () => ({
      status: 200,
      body: { total_count: 1, check_runs: [actionsRun(1, 1, 'success')] }
    })
  }
  const refusedMint = harness(routes)
  refusedMint.mintKanbanActions.mockRejectedValue(new GithubApiError('not granted', 422, 'INTERNAL', false))
  expect(await refusedMint.reader.readCheckRuns(REPO, SHA)).toMatchObject({ complete: false, actionsUnreadable: true })
  const forbidden = harness({
    ...routes,
    '/repositories/42/actions/runs': () => ({
      status: 403,
      body: { message: 'Resource not accessible by integration' }
    })
  })
  expect(await forbidden.reader.readCheckRuns(REPO, SHA)).toMatchObject({ complete: false, actionsUnreadable: true })
  // A transient failure is not a missing permission: it throws so the sweep retries.
  const flaky = harness({ ...routes, '/repositories/42/actions/runs': () => ({ status: 502, body: {} }) })
  await expect(flaky.reader.readCheckRuns(REPO, SHA)).rejects.toThrow()
  const limited = harness(routes)
  limited.mintKanbanActions.mockRejectedValue(new GithubApiError('slow down', 403, 'RATE_LIMITED', true))
  await expect(limited.reader.readCheckRuns(REPO, SHA)).rejects.toThrow()
})

it('vera-415 actions:read: a PR read never needs the actions token', async () => {
  const h = harness({
    '/repositories/42/pulls/12': () => ({
      status: 200,
      body: { number: 12, state: 'closed', merged: true, ...PR_FIELDS }
    })
  })
  h.mintKanbanActions.mockRejectedValue(new GithubApiError('not granted', 422, 'INTERNAL', false))
  expect((await h.reader.readPullRequest(REPO, 12))?.merged).toBe(true)
  expect(h.mintKanbanActions).not.toHaveBeenCalled()
})
