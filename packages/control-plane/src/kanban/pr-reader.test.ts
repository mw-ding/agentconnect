// GithubPrReader over a fake fetch: repo-id addressing, the PR-contract token, 404 handling, and bounded check-run paging.
import { describe, expect, it, vi } from 'vitest'
import { GithubPrReader } from './pr-reader.js'

const REPO = { installationId: 9n, repoId: 42n, repoFullName: 'acme/web' }
const SHA = 'a'.repeat(40)

function harness(routes: Record<string, (url: URL) => { status: number; body: unknown }>) {
  const urls: URL[] = []
  const fetchImpl = vi.fn(async (input: string) => {
    const url = new URL(input)
    urls.push(url)
    const route = routes[url.pathname]
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
  const reader = new GithubPrReader({ tokens: { mintKanbanPr }, fetchImpl: fetchImpl as never })
  return { reader, urls, mintKanbanPr }
}

describe('GithubPrReader', () => {
  it('reads a PR by repository id with the PR-contract token, keeping only state, merged, and head', async () => {
    const h = harness({
      '/repositories/42/pulls/12': () => ({
        status: 200,
        body: { number: 12, state: 'closed', merged: true, title: 'secret', body: 'secret', head: { sha: SHA } }
      })
    })
    expect(await h.reader.readPullRequest(REPO, 12)).toEqual({
      number: 12,
      state: 'closed',
      merged: true,
      headSha: SHA
    })
    expect(h.mintKanbanPr).toHaveBeenCalledWith(9n, 'acme/web', 42n)
  })

  it('treats merged_at as merged (list-shaped payloads omit `merged`) and a missing PR as null', async () => {
    const h = harness({
      '/repositories/42/pulls/12': () => ({
        status: 200,
        body: { number: 12, state: 'closed', merged_at: '2026-10-17T00:00:00Z', head: { sha: SHA } }
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
    const run = (i: number) => ({
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
      [`/repositories/42/commits/${SHA}/check-runs`]: () => ({
        status: 200,
        body: {
          total_count: 4,
          check_runs: [
            { id: 20, name: 'Conventional PR', app: { id: 15368 }, status: 'completed', conclusion: 'success' },
            { id: 10, name: 'Conventional PR', app: { id: 15368 }, status: 'completed', conclusion: 'failure' },
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
