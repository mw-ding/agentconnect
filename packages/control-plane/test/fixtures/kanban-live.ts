// Live GitHub test helpers keep scratch issue cleanup explicit and never print the injected credential.
import { expect } from 'vitest'
import { KANBAN_STATUSES } from '../../src/kanban/card-state.js'
import { OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import type { GithubInstallationRecord } from '../../src/persistence/ports.js'

export const TOKEN = process.env.GITHUB_TOKEN
export const enabled = process.env.KANBAN_E2E === '1' && !!TOKEN && !process.env.CI
export const FULL = 'mw-ding/agentconnect'
export const REPO_ID = 1332342098n
export const installation: GithubInstallationRecord = {
  id: 'kanban-live',
  orgId: OrgId(DEFAULT_ORG_ID),
  installationId: 1n,
  accountLogin: 'mw-ding',
  accountType: 'User',
  permissions: { issues: 'write' },
  repositorySelection: 'selected',
  revokedAt: null,
  suspendedAt: null,
  createdAt: new Date(0)
}
export const tokens = { mintKanbanCard: async () => ({ token: TOKEN! }) } as never
export const repoRef = { installationId: 1n, repoId: REPO_ID, repoFullName: FULL }

export async function gh<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status}`)
  const raw = await response.text()
  return (raw ? JSON.parse(raw) : null) as T
}
export async function ensureLabels() {
  for (const status of KANBAN_STATUSES) {
    const name = `ac/status:${status}`
    const response = await fetch(`https://api.github.com/repos/${FULL}/labels/${encodeURIComponent(name)}`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    if (response.status === 404) await gh('POST', `/repos/${FULL}/labels`, { name, color: 'ededed' })
    else expect(response.status).toBe(200)
  }
}
export async function createIssue(issues: number[], scenario: string, labels: string[]) {
  const issue = await gh<{ id: number; number: number }>('POST', `/repos/${FULL}/issues`, {
    title: `[kanban-e2e] ${scenario} ${Date.now()}`,
    labels
  })
  issues.push(issue.number)
  return issue
}
export async function closeIssues(issues: number[]) {
  const results = await Promise.allSettled(
    issues.map((n) => gh('PATCH', `/repos/${FULL}/issues/${n}`, { state: 'closed', state_reason: 'not_planned' }))
  )
  for (const result of results) if (result.status === 'rejected') throw result.reason
}
export function record(scenario: string, issues: number[], started: number) {
  console.log('KANBAN_SCENARIO', JSON.stringify({ scenario, issues, result: 'PASS', durationMs: Date.now() - started }))
}
