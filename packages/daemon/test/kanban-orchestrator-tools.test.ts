// Kanban orchestrator tools (issue #2 M3): the daemon files the issue body, keys on a spec digest, and keeps a
// pending map so a retry after a failed commit re-commits the same issue instead of filing a second one.
import { describe, expect, it, vi } from 'vitest'
import type { KanbanOrchestrate, KanbanOrchestrateOk } from '@agentconnect.md/protocol'
import { KanbanOrchestratorTools, orchestratorSpecDigest } from '../src/kanban/orchestrator-tools.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const BOARD = '22222222-2222-4222-8222-222222222222'
const STEP = 'split-auth'
const TITLE = 'Add login'
const BODY = 'Implement the login page'

function tools(orchestrate: (p: KanbanOrchestrate) => Promise<KanbanOrchestrateOk>) {
  const fileIssue = vi.fn(async () => 42)
  const repoFullNameFor = vi.fn(async () => 'acme/web')
  const svc = new KanbanOrchestratorTools({
    orchestrate: vi.fn(orchestrate),
    repoFullNameFor,
    fileIssue
  })
  return { svc, fileIssue, repoFullNameFor }
}

describe('orchestratorSpecDigest', () => {
  it('is a stable sha256 over the masked title and body', () => {
    const digest = orchestratorSpecDigest('a', 'b')
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(orchestratorSpecDigest('a', 'b')).toBe(digest)
    expect(orchestratorSpecDigest('a', 'c')).not.toBe(digest)
  })
})

describe('KanbanOrchestratorTools', () => {
  it('translates a refusal into one human line and lists boards on success', async () => {
    const h = tools(async () => ({ ok: false, op: 'list', code: 'not_orchestrator' }))
    await expect(h.svc.list({ agentId: AGENT })).resolves.toEqual({
      refused: 'this agent is not the orchestrator of that board'
    })

    const ok = tools(async () => ({
      ok: true,
      op: 'list',
      truncated: false,
      boards: [
        {
          boardId: BOARD,
          repoFullName: 'acme/web',
          cards: [
            {
              issueNumber: 7,
              status: 'todo',
              assigneeAgentId: null,
              assigneeSlug: null,
              priority: 1,
              blockKind: null,
              epicIssueNumber: null,
              leased: false
            }
          ]
        }
      ]
    }))
    await expect(ok.svc.list({ agentId: AGENT, board: BOARD })).resolves.toEqual({
      truncated: false,
      boards: [
        {
          boardId: BOARD,
          repoFullName: 'acme/web',
          cards: [{ issue: 7, status: 'todo', assignee: null, priority: 1, blockKind: null, epic: null, leased: false }]
        }
      ]
    })
  })

  it('returns the existing card without filing when the B1 key already has one', async () => {
    const h = tools(async () => ({ ok: true, op: 'prepare_create', verdict: 'existing', issueNumber: 99 }))
    await expect(h.svc.create({ agentId: AGENT, board: BOARD, title: TITLE, body: BODY, step: STEP })).resolves.toEqual(
      {
        existing: true,
        issueNumber: 99
      }
    )
    expect(h.fileIssue).not.toHaveBeenCalled()
  })

  it('files the issue and commits it, and re-commits the same issue on a retry after a failed commit', async () => {
    let commits = 0
    const h = tools(async (p) => {
      if (p.op === 'prepare_create') return { ok: true, op: 'prepare_create', verdict: 'proceed' }
      commits += 1
      if (commits === 1) throw new Error('CP unreachable')
      return { ok: true, op: 'commit_create', cardId: 'c', issueNumber: 42 }
    })
    const first = await h.svc.create({ agentId: AGENT, board: BOARD, title: TITLE, body: BODY, step: STEP })
    expect(first).toEqual({ filed: true, issueNumber: 42, repoFullName: 'acme/web', retryable: true })
    expect(h.fileIssue).toHaveBeenCalledTimes(1)
    // The retry re-commits the same issue instead of filing a second one.
    const second = await h.svc.create({ agentId: AGENT, board: BOARD, title: TITLE, body: BODY, step: STEP })
    expect(second).toEqual({ created: true, cardId: 'c', issueNumber: 42, repoFullName: 'acme/web' })
    expect(h.fileIssue).toHaveBeenCalledTimes(1)
  })

  it('surfaces a refusal from commit and clears the pending map', async () => {
    const h = tools(async (p) => {
      if (p.op === 'prepare_create') return { ok: true, op: 'prepare_create', verdict: 'proceed' }
      return { ok: false, op: 'commit_create', code: 'epic_budget_exhausted' }
    })
    await expect(
      h.svc.create({ agentId: AGENT, board: BOARD, title: TITLE, body: BODY, step: STEP, epic: 1 })
    ).resolves.toEqual({
      refused: 'the epic has reached its card budget'
    })
  })

  it('link, unblock, and assign return short results', async () => {
    const h = tools(async (p) => {
      if (p.op === 'link') return { ok: true, op: 'link' }
      if (p.op === 'unblock') return { ok: true, op: 'unblock', status: 'todo' }
      if (p.op === 'assign') return { ok: true, op: 'assign', assigned: true }
      return { ok: false, op: 'list', code: 'not_orchestrator' }
    })
    await expect(h.svc.link({ agentId: AGENT, board: BOARD, issue: 7, blockedBy: [3] })).resolves.toEqual({
      linked: true
    })
    await expect(h.svc.unblock({ agentId: AGENT, board: BOARD, issue: 7, blockers: [3] })).resolves.toEqual({
      unblocked: true,
      status: 'todo'
    })
    await expect(h.svc.assign({ agentId: AGENT, board: BOARD, issue: 7, assignee: 'ash' })).resolves.toEqual({
      assigned: true
    })
  })
})
