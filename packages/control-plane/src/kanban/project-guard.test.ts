import { describe, expect, it, vi } from 'vitest'
import { CreateKanbanBoardBody, UpdateKanbanBoardBody } from '../http/dto/index.js'
import {
  githubKanbanProjectVerifier,
  judgeProjectConfig,
  PROJECT_READ_QUERY,
  projectPairComplete,
  type ProjectReadback
} from './project-guard.js'

const PROJECT = 'PVT_kwDOAbc'
const FIELD = 'PVTSSF_lADOAbc'

const good: ProjectReadback = {
  project: { id: PROJECT, owner: { __typename: 'Organization', login: 'Acme' } },
  field: {
    __typename: 'ProjectV2SingleSelectField',
    id: FIELD,
    project: { id: PROJECT },
    options: [{ id: 'o1', name: 'Todo' }]
  }
}

const judge = (over: Partial<Parameters<typeof judgeProjectConfig>[0]> = {}) =>
  judgeProjectConfig({
    repoOwner: 'acme',
    ownerType: 'Organization',
    projectNodeId: PROJECT,
    statusFieldId: FIELD,
    readback: good,
    ...over
  })

describe('judgeProjectConfig', () => {
  it('accepts an org project whose login matches the repo owner case-insensitively', () => {
    expect(judge()).toEqual({ ok: true, options: [{ id: 'o1', name: 'Todo' }] })
    expect(judge({ repoOwner: 'ACME' }).ok).toBe(true)
  })

  it.each([undefined, 'User', 'Bot'])('refuses a %s repo owner before reading the project', (ownerType) => {
    expect(judge({ ownerType, readback: undefined })).toEqual({ ok: false, code: 'project_requires_org_repo' })
  })

  it('refuses a missing, mismatched or null project as project_not_found', () => {
    expect(judge({ readback: { ...good, project: null } })).toEqual({ ok: false, code: 'project_not_found' })
    expect(judge({ readback: {} })).toEqual({ ok: false, code: 'project_not_found' })
    expect(judge({ readback: { ...good, project: { id: 'other', owner: good.project!.owner } } })).toEqual({
      ok: false,
      code: 'project_not_found'
    })
  })

  it('refuses a user-owned project as project_not_org_owned', () => {
    const readback = { ...good, project: { id: PROJECT, owner: { __typename: 'User', login: 'acme' } } }
    expect(judge({ readback })).toEqual({ ok: false, code: 'project_not_org_owned' })
  })

  it('refuses another organization as project_owner_mismatch', () => {
    const readback = { ...good, project: { id: PROJECT, owner: { __typename: 'Organization', login: 'evil' } } }
    expect(judge({ readback })).toEqual({ ok: false, code: 'project_owner_mismatch' })
  })

  it.each([
    ['null node', null],
    ['not single-select', { ...good.field, __typename: 'ProjectV2Field' }],
    ['wrong id', { ...good.field, id: 'other' }],
    ['other project', { ...good.field, project: { id: 'PVT_other' } }]
  ])('refuses %s as status_field_invalid', (_name, field) => {
    expect(judge({ readback: { ...good, field } })).toEqual({ ok: false, code: 'status_field_invalid' })
  })
})

describe('projectPairComplete and DTO pair validation', () => {
  it('requires both or neither', () => {
    expect(projectPairComplete(null, undefined)).toBe(true)
    expect(projectPairComplete('a', 'b')).toBe(true)
    expect(projectPairComplete('a', null)).toBe(false)
  })

  const base = { repoFullName: 'acme/web', name: 'b' }
  it('create accepts both or neither, refuses one', () => {
    expect(CreateKanbanBoardBody.safeParse(base).success).toBe(true)
    expect(CreateKanbanBoardBody.safeParse({ ...base, projectNodeId: 'p', statusFieldId: 'f' }).success).toBe(true)
    expect(CreateKanbanBoardBody.safeParse({ ...base, projectNodeId: 'p' }).success).toBe(false)
    expect(CreateKanbanBoardBody.safeParse({ ...base, statusFieldId: 'f' }).success).toBe(false)
    expect(CreateKanbanBoardBody.safeParse({ ...base, projectNodeId: null, statusFieldId: null }).success).toBe(false)
  })

  it('update accepts a pair, a null pair, or neither; refuses a half or a mixed pair', () => {
    expect(UpdateKanbanBoardBody.safeParse({ projectNodeId: 'p', statusFieldId: 'f' }).success).toBe(true)
    expect(UpdateKanbanBoardBody.safeParse({ projectNodeId: null, statusFieldId: null }).success).toBe(true)
    expect(UpdateKanbanBoardBody.safeParse({ enabled: true }).success).toBe(true)
    expect(UpdateKanbanBoardBody.safeParse({ projectNodeId: 'p' }).success).toBe(false)
    expect(UpdateKanbanBoardBody.safeParse({ projectNodeId: 'p', statusFieldId: null }).success).toBe(false)
    expect(UpdateKanbanBoardBody.safeParse({ projectNodeId: null }).success).toBe(false)
  })
})

describe('githubKanbanProjectVerifier', () => {
  const args = {
    installationId: 7n,
    repoId: 42n,
    repoFullName: 'acme/web',
    ownerType: 'Organization',
    projectNodeId: PROJECT,
    statusFieldId: FIELD
  }
  const gql = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
  const tokens = () => ({
    mintKanbanProject: vi.fn(async () => ({
      token: 'ghs_x',
      ttlSec: 3600,
      expiresAt: '',
      repoFullName: 'acme/web',
      access: 'read' as const
    }))
  })

  it('mints the project token, sends the exact query and variables, and judges the readback', async () => {
    const fetchImpl = gql({ data: good })
    const t = tokens()
    const verdict = await githubKanbanProjectVerifier({ tokens: t, fetchImpl }).verify(args)
    expect(verdict.ok).toBe(true)
    expect(t.mintKanbanProject).toHaveBeenCalledWith(7n, 'acme/web', 42n)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.github.com/graphql')
    expect(JSON.parse(init.body as string)).toEqual({
      query: PROJECT_READ_QUERY,
      variables: { project: PROJECT, field: FIELD }
    })
  })

  it('makes no mint and no call for a user-owned repo', async () => {
    const fetchImpl = gql({ data: good })
    const t = tokens()
    const verdict = await githubKanbanProjectVerifier({ tokens: t, fetchImpl }).verify({ ...args, ownerType: 'User' })
    expect(verdict).toEqual({ ok: false, code: 'project_requires_org_repo' })
    expect(t.mintKanbanProject).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('maps a null project (NOT_FOUND beside partial data) to project_not_found with the denied reason', async () => {
    const fetchImpl = gql({ data: { project: null, field: null }, errors: [{ type: 'NOT_FOUND', message: 'secret' }] })
    const verdict = await githubKanbanProjectVerifier({ tokens: tokens(), fetchImpl }).verify(args)
    expect(verdict).toEqual({ ok: false, code: 'project_not_found', reason: 'project_access_denied' })
    expect(JSON.stringify(verdict)).not.toContain('secret')
  })

  it('maps a FORBIDDEN read beside partial data to project_not_found with the denied reason', async () => {
    const fetchImpl = gql({
      data: { project: null, field: null },
      errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration [SECRET]' }]
    })
    const verdict = await githubKanbanProjectVerifier({ tokens: tokens(), fetchImpl }).verify(args)
    expect(verdict).toEqual({ ok: false, code: 'project_not_found', reason: 'project_access_denied' })
    expect(JSON.stringify(verdict)).not.toContain('SECRET')
  })

  it.each([
    [403, 'project_not_found', 'project_access_denied'],
    [404, 'project_not_found', 'project_access_denied'],
    [401, 'github_unavailable', undefined],
    [429, 'github_rate_limited', undefined],
    [500, 'github_unavailable', undefined]
  ] as const)('maps HTTP %i to %s without leaking GitHub text', async (status, code, reason) => {
    const fetchImpl = gql({ message: 'Resource not accessible by integration [SECRET]' }, status)
    const verdict = await githubKanbanProjectVerifier({ tokens: tokens(), fetchImpl }).verify(args)
    expect(verdict).toMatchObject(reason === undefined ? { ok: false, code } : { ok: false, code, reason })
    expect(JSON.stringify(verdict)).not.toContain('SECRET')
  })

  it('carries project_access_denied for a denial, including a token mint the App permission refuses', async () => {
    const { GithubApiError } = await import('../github/api.js')
    const t = {
      mintKanbanProject: vi.fn().mockRejectedValue(new GithubApiError('denied (422)', 422, 'LEASE_DENIED', false))
    }
    const verdict = await githubKanbanProjectVerifier({ tokens: t, fetchImpl: gql({}) }).verify(args)
    expect(verdict).toEqual({ ok: false, code: 'project_not_found', reason: 'project_access_denied' })
    expect(JSON.stringify(verdict)).not.toContain('denied (422)')
  })

  it('maps a GraphQL RATE_LIMITED body to github_rate_limited', async () => {
    const fetchImpl = gql({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'slow down' }] })
    expect(await githubKanbanProjectVerifier({ tokens: tokens(), fetchImpl }).verify(args)).toMatchObject({
      code: 'github_rate_limited'
    })
  })

  it('maps a non-denial GraphQL error body to github_unavailable without its text', async () => {
    const fetchImpl = gql({ data: null, errors: [{ type: 'SOME_NEW_KIND', message: 'boom [SECRET]' }] })
    const verdict = await githubKanbanProjectVerifier({ tokens: tokens(), fetchImpl }).verify(args)
    expect(verdict).toEqual({ ok: false, code: 'github_unavailable' })
    expect(JSON.stringify(verdict)).not.toContain('SECRET')
  })

  it('fails a non-GitHub error closed as github_unavailable instead of throwing', async () => {
    const t = { mintKanbanProject: vi.fn().mockRejectedValue(new Error('config exploded [SECRET]')) }
    const verdict = await githubKanbanProjectVerifier({ tokens: t, fetchImpl: gql({}) }).verify(args)
    expect(verdict).toEqual({ ok: false, code: 'github_unavailable' })
    expect(JSON.stringify(verdict)).not.toContain('SECRET')
  })
})
