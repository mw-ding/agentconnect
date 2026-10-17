import { describe, expect, it, vi } from 'vitest'
import { OrgId } from '../domain/ids.js'
import { GithubApiError } from '../github/api.js'
import type { GithubInstallationRecord } from '../persistence/ports.js'
import { githubKanbanRepoResolver } from './repo-resolver.js'

const org = OrgId('org')
const installation = { installationId: 7n, revokedAt: null, suspendedAt: null } as GithubInstallationRecord

it('requires an installation even when GitHub could read the repository', async () => {
  const repoRefFor = vi.fn()
  const resolver = githubKanbanRepoResolver({
    installations: { liveByOrgAndAccount: async () => null },
    github: { repoRefFor }
  })
  expect(await resolver.resolve(org, 'acme/web')).toMatchObject({ ok: false, status: 400 })
  expect(repoRefFor).not.toHaveBeenCalled()
})

describe('live board repository coverage', () => {
  it.each(['revokedAt', 'suspendedAt'] as const)('refuses %s installations', async (field) => {
    const repoRefFor = vi.fn()
    const resolver = githubKanbanRepoResolver({
      installations: { liveByOrgAndAccount: async () => ({ ...installation, [field]: new Date() }) },
      github: { repoRefFor }
    })
    expect(await resolver.resolve(org, 'acme/web')).toMatchObject({ ok: false, status: 400 })
    expect(repoRefFor).not.toHaveBeenCalled()
  })

  it('uses the live repository identity through the org installation', async () => {
    const repoRefFor = vi.fn(async () => ({ repoId: 42n, fullName: 'Acme/Web', private: true, defaultBranch: 'main' }))
    const liveByOrgAndAccount = vi.fn(async () => installation)
    const resolver = githubKanbanRepoResolver({ installations: { liveByOrgAndAccount }, github: { repoRefFor } })
    expect(await resolver.resolve(org, 'acme/web')).toEqual({
      ok: true,
      repoId: 42n,
      repoFullName: 'Acme/Web',
      installationId: 7n
    })
    expect(liveByOrgAndAccount).toHaveBeenCalledWith(org, 'acme')
    expect(repoRefFor).toHaveBeenCalledWith(installation, 'acme', 'web')
  })

  it.each([
    [null, 400],
    [new GithubApiError('limited', 429, 'RATE_LIMITED', false), 429],
    [new GithubApiError('unavailable', 503, 'INTERNAL', false), 502]
  ] as const)('maps uncovered and unavailable repositories: %s', async (result, status) => {
    const repoRefFor = vi.fn(async () => {
      if (result instanceof Error) throw result
      return result
    })
    const resolver = githubKanbanRepoResolver({
      installations: { liveByOrgAndAccount: async () => installation },
      github: { repoRefFor }
    })
    expect(await resolver.resolve(org, 'acme/web')).toMatchObject({ ok: false, status })
  })
})
