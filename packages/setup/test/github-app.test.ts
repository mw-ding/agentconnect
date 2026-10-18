import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { auditGithubApp, buildGithubAppManifest, GITHUB_APP_EVENTS, GITHUB_APP_PERMISSIONS } from '../src/github-app.js'

describe('GitHub App manifest', () => {
  it('subscribes to the Kanban graph events without a new permission', () => {
    expect(GITHUB_APP_EVENTS).toContain('sub_issues')
    expect(GITHUB_APP_EVENTS).toContain('issue_dependencies')
    expect(Object.keys(GITHUB_APP_PERMISSIONS).sort()).toEqual(
      [
        'actions',
        'checks',
        'contents',
        'deployments',
        'emails',
        'issues',
        'metadata',
        'organization_projects',
        'pull_requests',
        'workflows'
      ].sort()
    )
    expect(GITHUB_APP_PERMISSIONS.issues).toBe('write')
  })

  it('requests organization_projects:write for the Kanban Status projection', () => {
    expect(GITHUB_APP_PERMISSIONS.organization_projects).toBe('write')
    const manifest = buildGithubAppManifest(
      {
        services: {
          web: 'https://console.example',
          controlPlane: 'https://cp.example',
          relay: 'https://relay.example'
        }
      },
      'AgentConnect',
      'https://cp.example/v1/github/setup/callback'
    )
    expect(manifest.default_permissions).toMatchObject({ organization_projects: 'write' })
  })
})

describe('GitHub App audit', () => {
  // Offline key: the audit mints its own JWT, so only the /app read needs a stubbed fetch.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privateKeyBase64 = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64')
  const identity = { appId: 123, slug: 'agentconnect', clientId: null as string | null, privateKeyBase64 }
  const expectedManifest = {
    url: 'https://example.com',
    default_events: [...GITHUB_APP_EVENTS]
  }
  const appBody = (permissions: Record<string, string>) => ({
    id: 123,
    slug: 'agentconnect',
    external_url: 'https://example.com',
    permissions,
    events: [...GITHUB_APP_EVENTS],
    owner: { login: 'acme', type: 'Organization' }
  })
  const fetchApp = (permissions: Record<string, string>) =>
    (async () => new Response(JSON.stringify(appBody(permissions)), { status: 200 })) as typeof fetch

  it('reports no diff when the installed permissions match', async () => {
    const result = await auditGithubApp(
      identity,
      privateKeyBase64,
      expectedManifest,
      fetchApp({ ...GITHUB_APP_PERMISSIONS })
    )
    expect(result.missing).toEqual([])
    expect(result.diff).toEqual([])
  })

  it('names a missing organization_projects grant as Organization permissions', async () => {
    const { organization_projects: dropped, ...repoOnly } = { ...GITHUB_APP_PERMISSIONS }
    expect(dropped).toBe('write')
    const result = await auditGithubApp(identity, privateKeyBase64, expectedManifest, fetchApp(repoOnly))
    expect(result.diff).toEqual([
      {
        id: 'org_permissions',
        field: 'Organization permissions',
        current: {},
        expected: { organization_projects: 'write' }
      }
    ])
  })

  it('keeps a repository permission gap under Repository permissions', async () => {
    const { issues: dropped, ...withoutIssues } = { ...GITHUB_APP_PERMISSIONS }
    expect(dropped).toBe('write')
    const result = await auditGithubApp(identity, privateKeyBase64, expectedManifest, fetchApp(withoutIssues))
    expect(result.diff.map((d) => d.id)).toEqual(['permissions'])
    expect(result.diff[0]?.field).toBe('Repository permissions')
  })
})
