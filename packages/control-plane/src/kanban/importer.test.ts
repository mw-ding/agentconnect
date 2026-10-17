import { describe, expect, it, vi } from 'vitest'
import type { KanbanBoardRecord } from '../persistence/ports.js'
import type { RepoPermissionLevel } from '../github/repo-permission.js'
import type { CardIssue } from './card-store.js'
import { KanbanImporter } from './importer.js'

const board = { id: 'board', orgId: 'org' } as KanbanBoardRecord
const repo = { installationId: 7n, repoId: 42n, repoFullName: 'acme/web' }
function harness(issue: CardIssue | null, level: RepoPermissionLevel | Error = 'write') {
  const cards = {
    findByIssueNumber: vi.fn(async () => null),
    resolveAgentSlug: vi.fn(async () => 'agent'),
    upsertCard: vi.fn()
  }
  const store = { readCard: vi.fn(async () => issue), applyPlan: vi.fn() }
  const permissions = {
    permission: vi.fn(async () => {
      if (level instanceof Error) throw level
      return level
    })
  }
  return { cards, store, permissions, importer: new KanbanImporter({ cards, store, permissions }) }
}
const issue = (labels = ['ac/status:ready']): CardIssue => ({
  issueId: 100n,
  nodeId: 'I_100',
  number: 1,
  state: 'open',
  labels,
  authorLogin: 'alice'
})

describe('Kanban issue import', () => {
  it.each(['admin', 'maintain', 'write', 'triage', 'read', 'none', new Error('offline')] as const)(
    'gates the author using live permission %s',
    async (level) => {
      const h = harness(issue(), level)
      expect(await h.importer.import(board, repo, 1)).toBe(true)
      const status = ['admin', 'maintain', 'write'].includes(String(level)) ? 'ready' : 'triage'
      expect(h.cards.upsertCard).toHaveBeenCalledWith(
        expect.objectContaining({ status, source: 'import', issueId: 100n })
      )
      expect(h.store.applyPlan).toHaveBeenCalledWith(repo, 1, issue(), expect.objectContaining({ status }))
      expect(h.permissions.permission).toHaveBeenCalledWith(repo, 'alice')
    }
  )
  it.each([null, issue([]), issue(['ac/agent:worker']), issue(['bug'])])(
    'ignores missing or unlabeled issues',
    async (candidate) => {
      const h = harness(candidate)
      expect(await h.importer.import(board, repo, 1)).toBe(false)
      expect(h.cards.upsertCard).not.toHaveBeenCalled()
      expect(h.permissions.permission).not.toHaveBeenCalled()
    }
  )
  it.each(['running', 'bogus'])('imports %s safely as triage', async (status) => {
    const h = harness(issue([`ac/status:${status}`]))
    await h.importer.import(board, repo, 1)
    expect(h.cards.upsertCard).toHaveBeenCalledWith(expect.objectContaining({ status: 'triage' }))
  })
  it('maps a single agent slug in the board organization', async () => {
    const h = harness(issue(['ac/status:todo', 'ac/agent:worker']))
    await h.importer.import(board, repo, 1)
    expect(h.cards.resolveAgentSlug).toHaveBeenCalledWith('org', 'worker')
    expect(h.cards.upsertCard).toHaveBeenCalledWith(expect.objectContaining({ assigneeAgentId: 'agent' }))
  })
  it('leaves no DB row if the safety label write fails', async () => {
    const h = harness(issue(), 'read')
    h.store.applyPlan.mockRejectedValueOnce(new Error('label write failed'))
    await expect(h.importer.import(board, repo, 1)).rejects.toThrow('label write failed')
    expect(h.cards.upsertCard).not.toHaveBeenCalled()
  })
})
