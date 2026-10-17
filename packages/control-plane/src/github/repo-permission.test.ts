import { describe, expect, it, vi } from 'vitest'
import {
  GithubRepoPermission,
  checkWriteAccess,
  hasWriteAccess,
  parseRepoPermission,
  type RepoPermissionLevel
} from './repo-permission.js'

const repo = { installationId: 9n, repoId: 4242n, repoFullName: 'acme/web' }
const grant = { token: 'ghs_test', ttlSec: 3600, expiresAt: '', repoFullName: 'acme/web', access: 'read' as const }

function respond(status: number, body: unknown) {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  )
}

describe('parseRepoPermission', () => {
  it.each([
    [{ permission: 'admin', role_name: 'admin' }, 'admin'],
    [{ permission: 'write', role_name: 'maintain' }, 'maintain'],
    [{ permission: 'write', role_name: 'write' }, 'write'],
    [{ permission: 'read', role_name: 'triage' }, 'triage'],
    [{ permission: 'read', role_name: 'read' }, 'read'],
    [{ permission: 'write', role_name: 'custom-deployer' }, 'write'],
    [{ permission: 'none' }, 'none'],
    [{}, 'none'],
    [{ permission: 'owner' }, 'none']
  ] as const)('%j → %s', (res, want) => {
    expect(parseRepoPermission(res)).toBe(want)
  })
})

describe('hasWriteAccess', () => {
  it.each([
    ['admin', true],
    ['maintain', true],
    ['write', true],
    ['triage', false],
    ['read', false],
    ['none', false]
  ] as Array<[RepoPermissionLevel, boolean]>)('%s → %s', (level, want) => {
    expect(hasWriteAccess(level)).toBe(want)
  })
})

describe('GithubRepoPermission', () => {
  it('asks the collaborator permission endpoint by repo id with a read-scoped Kanban token', async () => {
    const fetchImpl = respond(200, { permission: 'write', role_name: 'maintain' })
    const tokens = { mintKanbanCard: vi.fn(async () => grant) }
    const lookup = new GithubRepoPermission({ tokens, fetchImpl, baseUrl: 'https://gh.test' })
    await expect(lookup.permission(repo, 'Octo Cat')).resolves.toBe('maintain')
    expect(tokens.mintKanbanCard).toHaveBeenCalledWith(9n, 'acme/web', 4242n, 'read')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://gh.test/repositories/4242/collaborators/Octo%20Cat/permission')
    expect(new Headers(init.headers).get('authorization')).toContain('ghs_test')
  })

  it.each([404, 422])('reads %s as no access', async (status) => {
    const lookup = new GithubRepoPermission({
      tokens: { mintKanbanCard: async () => grant },
      fetchImpl: respond(status, { message: 'nope' }),
      baseUrl: 'https://gh.test'
    })
    await expect(lookup.permission(repo, 'octocat')).resolves.toBe('none')
  })

  it('throws a transient failure instead of guessing', async () => {
    const lookup = new GithubRepoPermission({
      tokens: { mintKanbanCard: async () => grant },
      fetchImpl: respond(502, { message: 'bad gateway' }),
      baseUrl: 'https://gh.test'
    })
    await expect(lookup.permission(repo, 'octocat')).rejects.toThrow()
  })

  it('reuses a lookup within the TTL, case-insensitively, and asks again after it', async () => {
    let now = 1_000
    const fetchImpl = respond(200, { permission: 'admin', role_name: 'admin' })
    const lookup = new GithubRepoPermission({
      tokens: { mintKanbanCard: async () => grant },
      fetchImpl,
      baseUrl: 'https://gh.test',
      ttlMs: 500,
      now: () => now
    })
    await lookup.permission(repo, 'mw-ding')
    await lookup.permission(repo, 'MW-Ding')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    now += 501
    await lookup.permission(repo, 'mw-ding')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('never caches a failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ permission: 'write' }), { status: 200 }))
    const lookup = new GithubRepoPermission({
      tokens: { mintKanbanCard: async () => grant },
      fetchImpl,
      baseUrl: 'https://gh.test'
    })
    await expect(lookup.permission(repo, 'mw-ding')).rejects.toThrow()
    await expect(lookup.permission(repo, 'mw-ding')).resolves.toBe('write')
  })
})

describe('checkWriteAccess', () => {
  it('fails closed when the lookup throws', async () => {
    const error = new Error('down')
    const result = await checkWriteAccess({ permission: async () => Promise.reject(error) }, repo, 'mw-ding')
    expect(result).toEqual({ level: 'none', write: false, error })
  })

  it.each([
    ['admin', true],
    ['read', false]
  ] as Array<[RepoPermissionLevel, boolean]>)('passes %s through', async (level, write) => {
    await expect(checkWriteAccess({ permission: async () => level }, repo, 'x')).resolves.toEqual({ level, write })
  })
})
