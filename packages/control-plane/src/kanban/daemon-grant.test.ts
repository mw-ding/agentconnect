import { describe, expect, it } from 'vitest'
import { kanbanGrantFor, kanbanRequestRepo } from './daemon-grant.js'

const read = { repoId: 7n, repoFullName: 'acme/web', mode: 'read' as const }
const write = { repoId: 7n, repoFullName: 'Acme/Web', mode: 'write' as const }

describe('kanban daemon grant selection', () => {
  it('uses the named repo, else a GitHub-credentialed workspace, and ignores other workspace modes', () => {
    expect(kanbanRequestRepo('acme/web', undefined)).toBe('acme/web')
    expect(
      kanbanRequestRepo(undefined, {
        mode: 'git',
        gitRepo: 'https://github.com/acme/web.git',
        credential: { provider: 'github' }
      })
    ).toBe('acme/web')
    expect(kanbanRequestRepo(undefined, { mode: 'scratch' })).toBeUndefined()
    expect(kanbanRequestRepo(undefined, undefined)).toBeUndefined()
  })

  it('clamps to read when any open run on the repo is read', () => {
    expect(kanbanGrantFor([write, read], 'ACME/web')).toEqual({
      repoId: 7n,
      repoFullName: 'Acme/Web',
      mode: 'read'
    })
    expect(kanbanGrantFor([write], 'acme/web')?.mode).toBe('write')
    expect(kanbanGrantFor([read], 'acme/other')).toBeUndefined()
  })
})
