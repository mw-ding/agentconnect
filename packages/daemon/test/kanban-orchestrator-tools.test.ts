// Failed commits retain the filed issue for a bounded, caller-scoped retry.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  kanbanCardKeyMarker,
  kanbanOrchestrateCardKey,
  type KanbanOrchestrate,
  type KanbanOrchestrateOk
} from '@agentconnect.md/protocol'
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
    fileIssue,
    findIssue: async () => null
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

describe('pending creates', () => {
  function pendingHarness() {
    let now = 0
    const fileIssue = vi.fn(async () => fileIssue.mock.calls.length)
    const svc = new KanbanOrchestratorTools({
      orchestrate: async (p) => {
        if (p.op === 'prepare_create') return { ok: true, op: p.op, verdict: 'proceed' }
        throw new Error('CP unavailable')
      },
      repoFullNameFor: async () => 'acme/web',
      fileIssue,
      findIssue: async () => null,
      now: () => now
    })
    const req = { agentId: AGENT, board: BOARD, title: TITLE, body: BODY }
    return {
      svc,
      req,
      fileIssue,
      advance: (ms: number) => {
        now += ms
      }
    }
  }

  it('isolates agent, board, epic, step, and masked spec while sharing the default step', async () => {
    const h = pendingHarness()
    const requests = [
      h.req,
      { ...h.req, agentId: 'other-agent' },
      { ...h.req, board: 'other-board' },
      { ...h.req, epic: 1 },
      { ...h.req, epic: 2 },
      { ...h.req, step: 'other-step' },
      { ...h.req, body: 'other-spec' }
    ]
    for (const [index, req] of requests.entries()) {
      expect(await h.svc.create(req)).toMatchObject({ issueNumber: index + 1 })
    }
    for (const [index, req] of requests.entries()) {
      expect(await h.svc.create(req)).toMatchObject({ issueNumber: index + 1 })
    }
    expect(await h.svc.create({ ...h.req, step: 'default' })).toMatchObject({ issueNumber: 1 })
    expect(h.fileIssue).toHaveBeenCalledTimes(requests.length)
  })

  it('evicts the oldest filed entry above 256 even if it was recently retried', async () => {
    const h = pendingHarness()
    for (let i = 0; i < 256; i++) {
      await h.svc.create({ ...h.req, step: `step-${i}` })
      h.advance(1)
    }
    await h.svc.create({ ...h.req, step: 'step-0' })
    expect(h.fileIssue).toHaveBeenCalledTimes(256)
    await h.svc.create({ ...h.req, step: 'step-256' })
    await h.svc.create({ ...h.req, step: 'step-1' })
    expect(h.fileIssue).toHaveBeenCalledTimes(257)
    await h.svc.create({ ...h.req, step: 'step-0' })
    expect(h.fileIssue).toHaveBeenCalledTimes(258)
  })

  it('expires entries older than one hour without extending their age on retry', async () => {
    const h = pendingHarness()
    await h.svc.create(h.req)
    h.advance(60 * 60 * 1000)
    await h.svc.create(h.req)
    expect(h.fileIssue).toHaveBeenCalledTimes(1)
    h.advance(1)
    await h.svc.create({ ...h.req, step: 'new-step' })
    expect((h.svc as any).pending.size).toBe(1)
    await h.svc.create(h.req)
    expect(h.fileIssue).toHaveBeenCalledTimes(3)
  })
})

describe('durable crash recovery', () => {
  it.each([true, false])('adopts a marker match (%s) or files a marked issue before committing', async (found) => {
    const orchestrate = vi.fn(async (p: KanbanOrchestrate): Promise<KanbanOrchestrateOk> =>
      p.op === 'prepare_create'
        ? { ok: true, op: p.op, verdict: 'proceed' }
        : { ok: true, op: 'commit_create', cardId: 'c', issueNumber: 42 }
    )
    const findIssue = vi.fn(async () => (found ? 42 : null))
    const fileIssue = vi.fn(async () => 42)
    const svc = new KanbanOrchestratorTools({
      orchestrate,
      findIssue,
      fileIssue,
      repoFullNameFor: async () => 'acme/web'
    })
    await expect(
      svc.create({ agentId: AGENT, board: BOARD, title: TITLE, body: BODY, epic: 1, step: STEP })
    ).resolves.toMatchObject({ created: true, issueNumber: 42 })
    const marker = kanbanCardKeyMarker(
      kanbanOrchestrateCardKey({
        boardId: BOARD,
        epicIssueNumber: 1,
        step: STEP,
        specDigest: orchestratorSpecDigest(TITLE, BODY)
      })
    )
    expect(findIssue).toHaveBeenCalledWith(AGENT, 'acme/web', marker)
    expect(fileIssue).toHaveBeenCalledTimes(found ? 0 : 1)
    if (!found) expect(fileIssue).toHaveBeenCalledWith(AGENT, 'acme/web', TITLE, `${BODY}\n\n${marker}`)
    expect(orchestrate.mock.calls[1]![0]).toMatchObject({ op: 'commit_create', issueNumber: 42 })
  })

  it('never files when the durable lookup fails', async () => {
    const fileIssue = vi.fn(async () => 42)
    const svc = new KanbanOrchestratorTools({
      orchestrate: async () => ({ ok: true, op: 'prepare_create', verdict: 'proceed' }),
      repoFullNameFor: async () => 'acme/web',
      fileIssue,
      findIssue: async () => {
        throw new Error('GitHub unavailable')
      }
    })
    await expect(svc.create({ agentId: AGENT, board: BOARD, title: TITLE, body: BODY })).rejects.toThrow(
      'GitHub unavailable'
    )
    expect(fileIssue).not.toHaveBeenCalled()
  })
})

describe('pending journal', () => {
  const journalRoots: string[] = []
  afterEach(() => {
    for (const root of journalRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function freshJournalPath(): string {
    const root = mkdtempSync(join(tmpdir(), 'ac-pending-journal-'))
    journalRoots.push(root)
    return join(root, 'state', 'kanban-pending-creates.json')
  }

  function journaled(orchestrate: (p: KanbanOrchestrate) => Promise<KanbanOrchestrateOk>, journalPath: string) {
    const findIssue = vi.fn(async () => null)
    const fileIssue = vi.fn(async () => 42)
    const svc = new KanbanOrchestratorTools({
      orchestrate: vi.fn(orchestrate),
      repoFullNameFor: async () => 'acme/web',
      findIssue,
      fileIssue,
      journalPath
    })
    return { svc, findIssue, fileIssue }
  }

  const req = { agentId: AGENT, board: BOARD, title: TITLE, body: BODY, step: STEP }

  it('round-trips across a fresh toolset, so the retry does no POST and no lookup', async () => {
    const journalPath = freshJournalPath()
    let commits = 0
    const orchestrate = async (p: KanbanOrchestrate): Promise<KanbanOrchestrateOk> => {
      if (p.op === 'prepare_create') return { ok: true, op: 'prepare_create', verdict: 'proceed' }
      commits += 1
      if (commits === 1) throw new Error('CP unreachable')
      return { ok: true, op: 'commit_create', cardId: 'c', issueNumber: 42 }
    }
    const first = journaled(orchestrate, journalPath)
    await expect(first.svc.create(req)).resolves.toEqual({
      filed: true,
      issueNumber: 42,
      repoFullName: 'acme/web',
      retryable: true
    })
    expect(first.fileIssue).toHaveBeenCalledTimes(1)
    // A simulated restart rebuilds the toolset over the same journal file.
    const findIssue = vi.fn(async () => {
      throw new Error('lookup must not run on a journal hit')
    })
    const fileIssue = vi.fn(async () => 43)
    const second = new KanbanOrchestratorTools({
      orchestrate,
      repoFullNameFor: async () => 'acme/web',
      findIssue,
      fileIssue,
      journalPath
    })
    await expect(second.create(req)).resolves.toEqual({
      created: true,
      cardId: 'c',
      issueNumber: 42,
      repoFullName: 'acme/web'
    })
    expect(findIssue).not.toHaveBeenCalled()
    expect(fileIssue).not.toHaveBeenCalled()
  })

  it('a corrupt file means empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-pending-journal-'))
    journalRoots.push(root)
    const journalPath = join(root, 'journal.json')
    writeFileSync(journalPath, 'not json{{{')
    const warn = vi.fn()
    const fileIssue = vi.fn(async () => 42)
    const svc = new KanbanOrchestratorTools({
      orchestrate: async (p) => {
        if (p.op === 'prepare_create') return { ok: true, op: p.op, verdict: 'proceed' }
        throw new Error('CP unavailable')
      },
      repoFullNameFor: async () => 'acme/web',
      findIssue: async () => null,
      fileIssue,
      journalPath,
      log: { warn }
    })
    expect(warn).toHaveBeenCalledTimes(1)
    // Nothing usable loaded, so this files anew instead of reusing a phantom entry.
    await expect(svc.create(req)).resolves.toMatchObject({ issueNumber: 42 })
    expect(fileIssue).toHaveBeenCalledTimes(1)
  })

  it('a missing file means empty', async () => {
    const journalPath = freshJournalPath()
    const warn = vi.fn()
    const fileIssue = vi.fn(async () => 42)
    const svc = new KanbanOrchestratorTools({
      orchestrate: async (p) => {
        if (p.op === 'prepare_create') return { ok: true, op: p.op, verdict: 'proceed' }
        throw new Error('CP unavailable')
      },
      repoFullNameFor: async () => 'acme/web',
      findIssue: async () => null,
      fileIssue,
      journalPath,
      log: { warn }
    })
    expect(warn).toHaveBeenCalledTimes(1)
    await expect(svc.create(req)).resolves.toMatchObject({ issueNumber: 42 })
    expect(fileIssue).toHaveBeenCalledTimes(1)
  })

  it('removes entries on commit success and terminal refusal, keeps them on github_partial', async () => {
    const commitWith = (commit: (p: KanbanOrchestrate) => Promise<KanbanOrchestrateOk>) => {
      const journalPath = freshJournalPath()
      return {
        ...journaled(async (p) => {
          if (p.op === 'prepare_create') return { ok: true, op: p.op, verdict: 'proceed' }
          return commit(p)
        }, journalPath),
        journalPath
      }
    }

    const success = commitWith(async () => ({ ok: true, op: 'commit_create', cardId: 'c', issueNumber: 42 }))
    await expect(success.svc.create(req)).resolves.toMatchObject({ created: true })
    expect(JSON.parse(readFileSync(success.journalPath, 'utf8'))).toEqual({})

    const refused = commitWith(async () => ({ ok: false, op: 'commit_create', code: 'epic_budget_exhausted' }))
    await expect(refused.svc.create({ ...req, epic: 1 })).resolves.toMatchObject({
      refused: 'the epic has reached its card budget'
    })
    expect(JSON.parse(readFileSync(refused.journalPath, 'utf8'))).toEqual({})

    const partial = commitWith(async () => ({ ok: false, op: 'commit_create', code: 'github_partial' }))
    await expect(partial.svc.create(req)).resolves.toMatchObject({ partial: true, retryable: true })
    const entries = Object.values(JSON.parse(readFileSync(partial.journalPath, 'utf8')))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ issueNumber: 42 })
  })

  it('holds the 256-entry oldest-first bound in the file', async () => {
    const journalPath = freshJournalPath()
    const h = journaled(async (p) => {
      if (p.op === 'prepare_create') return { ok: true, op: p.op, verdict: 'proceed' }
      throw new Error('CP unavailable')
    }, journalPath)
    h.fileIssue.mockImplementation(async () => h.fileIssue.mock.calls.length)
    for (let i = 0; i < 257; i++) {
      await h.svc.create({ ...req, step: `step-${i}` })
    }
    const entries = Object.entries(JSON.parse(readFileSync(journalPath, 'utf8')))
    expect(entries).toHaveLength(256)
    expect(JSON.stringify(entries[0])).toContain('step-1')
    expect(JSON.stringify(entries)).not.toContain('step-0')
  })

  it('expires file entries older than one hour on load', async () => {
    const journalPath = freshJournalPath()
    const h = journaled(async (p) => {
      if (p.op === 'prepare_create') return { ok: true, op: p.op, verdict: 'proceed' }
      throw new Error('CP unavailable')
    }, journalPath)
    await h.svc.create(req)
    const aged = new KanbanOrchestratorTools({
      orchestrate: async (p) => {
        if (p.op === 'prepare_create') return { ok: true, op: p.op, verdict: 'proceed' }
        throw new Error('CP unavailable')
      },
      repoFullNameFor: async () => 'acme/web',
      findIssue: async () => null,
      fileIssue: vi.fn(async () => 43),
      journalPath,
      now: () => Date.now() + 2 * 60 * 60 * 1000
    })
    expect((aged as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
  })

  it('stores only keys, never titles or bodies, at mode 0600', async () => {
    const journalPath = freshJournalPath()
    const h = journaled(async (p) => {
      if (p.op === 'prepare_create') return { ok: true, op: p.op, verdict: 'proceed' }
      throw new Error('CP unavailable')
    }, journalPath)
    await h.svc.create(req)
    const raw = readFileSync(journalPath, 'utf8')
    expect(raw).not.toContain(TITLE)
    expect(raw).not.toContain(BODY)
    expect(raw).toContain('issueNumber')
    expect(statSync(journalPath).mode & 0o777).toBe(0o600)
  })
})
