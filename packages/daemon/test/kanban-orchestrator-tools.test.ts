// Failed commits retain the filed issue for a bounded, caller-scoped retry.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type KanbanOrchestrate, type KanbanOrchestrateOk } from '@agentconnect.md/protocol'
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
  it('vera-349: ordinary fresh creates skip marker lookup', async () => {
    const findIssue = vi.fn(async () => 777)
    const fileIssue = vi.fn(async () => 42)
    const svc = new KanbanOrchestratorTools({
      orchestrate: async (p) =>
        p.op === 'prepare_create'
          ? { ok: true, op: p.op, verdict: 'proceed' }
          : { ok: true, op: 'commit_create', cardId: 'c', issueNumber: 42 },
      repoFullNameFor: async () => 'acme/web',
      findIssue,
      fileIssue
    })
    expect(await svc.create({ agentId: AGENT, board: BOARD, title: TITLE, body: BODY })).toMatchObject({
      created: true,
      issueNumber: 42
    })
    expect(findIssue).not.toHaveBeenCalled()
    expect(fileIssue).toHaveBeenCalledTimes(1)
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

  it('a corrupt file requires recovery before another POST', async () => {
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
    // Lost state may hide a landed POST; the empty lookup leaves a retryable intent.
    await expect(svc.create(req)).resolves.toMatchObject({ retryable: true, refused: expect.any(String) })
    expect(fileIssue).not.toHaveBeenCalled()
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

  it('stores only keys, never titles or bodies', async () => {
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
  })

  it.skipIf(process.platform === 'win32')('stores the journal at mode 0600', async () => {
    const journalPath = freshJournalPath()
    const h = journaled(async (p) => {
      if (p.op === 'prepare_create') return { ok: true, op: p.op, verdict: 'proceed' }
      throw new Error('CP unavailable')
    }, journalPath)
    await h.svc.create(req)
    expect(statSync(journalPath).mode & 0o777).toBe(0o600)
  })
})

describe('vera-349: partial retry', () => {
  it('vera-349: replays labels and edges after prepare sees the partially registered card', async () => {
    let registered = false
    let labels = false
    let edges = false
    let commits = 0
    const h = tools(async (p) => {
      if (p.op === 'prepare_create')
        return registered
          ? { ok: true, op: p.op, verdict: 'existing', issueNumber: 42 }
          : { ok: true, op: p.op, verdict: 'proceed' }
      registered = true
      commits++
      if (commits === 1) return { ok: false, op: 'commit_create', code: 'github_partial' }
      labels = true
      edges = p.op === 'commit_create' && p.blockedBy?.[0] === 7
      return { ok: true, op: 'commit_create', cardId: 'c', issueNumber: 42 }
    })
    const req = { agentId: AGENT, board: BOARD, title: TITLE, body: BODY, blockedBy: [7] }
    expect(await h.svc.create(req)).toMatchObject({ partial: true, retryable: true })
    expect(await h.svc.create(req)).toMatchObject({ created: true, issueNumber: 42 })
    expect({ commits, labels, edges }).toEqual({ commits: 2, labels: true, edges: true })
    expect(h.fileIssue).toHaveBeenCalledTimes(1)
    expect((h.svc as any).pending.size).toBe(0)
    expect(await h.svc.create(req)).toEqual({ existing: true, issueNumber: 42 })
    expect(commits).toBe(2)
  })

  it('vera-349: a different pending issue cannot authorize replay of an existing card', async () => {
    let existing = false
    const h = tools(async (p) => {
      if (p.op === 'prepare_create')
        return existing
          ? { ok: true, op: p.op, verdict: 'existing', issueNumber: 99 }
          : { ok: true, op: p.op, verdict: 'proceed' }
      existing = true
      return { ok: false, op: 'commit_create', code: 'github_partial' }
    })
    const req = { agentId: AGENT, board: BOARD, title: TITLE, body: BODY }
    await h.svc.create(req)
    expect(await h.svc.create(req)).toEqual({ existing: true, issueNumber: 99 })
    expect(h.fileIssue).toHaveBeenCalledTimes(1)
    expect((h.svc as any).pending.size).toBe(1)
  })
})

describe('vera-349: safe recovery', () => {
  const req = { agentId: AGENT, board: BOARD, title: TITLE, body: BODY, step: STEP }
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })
  const pathFor = () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-vera-349-'))
    roots.push(root)
    return join(root, 'journal.json')
  }
  const keyFor = (r = req) =>
    JSON.stringify([r.agentId, r.board, null, r.step, orchestratorSpecDigest(r.title, r.body)])

  it('vera-349: neutralizes agent markers before filing and taking the digest', async () => {
    const orchestrate = vi.fn(async (p: KanbanOrchestrate): Promise<KanbanOrchestrateOk> =>
      p.op === 'prepare_create'
        ? { ok: true, op: p.op, verdict: 'proceed' }
        : { ok: true, op: 'commit_create', cardId: 'c', issueNumber: 42 }
    )
    const fileIssue = vi.fn(async (_agent: string, _repo: string, _title: string, _body: string) => 42)
    const findIssue = vi.fn(async () => null)
    const svc = new KanbanOrchestratorTools({
      orchestrate,
      fileIssue,
      findIssue,
      repoFullNameFor: async () => 'acme/web'
    })
    const planted = '<!--  AGENTCONNECT : kanban-card-key : ' + 'd'.repeat(64) + ' -->'
    await svc.create({ ...req, title: TITLE + planted, body: BODY + planted })
    const [, , title, body] = fileIssue.mock.calls[0] as unknown as string[]
    expect(title).not.toMatch(/<!--\s*agentconnect\s*:\s*kanban-card-key\s*:/i)
    expect(body?.match(/<!--\s*agentconnect\s*:\s*kanban-card-key\s*:/gi)).toHaveLength(1)
    const agentBody = body!.slice(0, body!.lastIndexOf('\n\n'))
    expect(orchestrate.mock.calls[0]![0]).toMatchObject({ specDigest: orchestratorSpecDigest(title!, agentBody) })
    expect(body?.trimEnd().endsWith(planted)).toBe(false)
  })

  it('vera-349: writes an intent before POST, and an uncertain restart never files again', async () => {
    const journalPath = pathFor()
    const fileIssue = vi.fn(async () => {
      expect(JSON.parse(readFileSync(journalPath, 'utf8'))[keyFor()]).toMatchObject({
        issueNumber: null,
        startedAt: expect.any(Number)
      })
      throw new Error('POST may have landed')
    })
    const orchestrate = async (): Promise<KanbanOrchestrateOk> => ({
      ok: true,
      op: 'prepare_create',
      verdict: 'proceed',
      appLogin: 'acme-app[bot]'
    })
    const findIssue = vi.fn(async () => null)
    const deps = { orchestrate, fileIssue, findIssue, repoFullNameFor: async () => 'acme/web', journalPath }
    const svc = new KanbanOrchestratorTools(deps)
    await expect(svc.create(req)).rejects.toThrow('POST may have landed')
    expect(findIssue).not.toHaveBeenCalled()
    const restarted = new KanbanOrchestratorTools(deps)
    expect(await restarted.create(req)).toMatchObject({ retryable: true, refused: expect.any(String) })
    expect(fileIssue).toHaveBeenCalledTimes(1)
    expect(findIssue).toHaveBeenCalledTimes(1)
  })

  it.each(['issue_not_from_app', 'issue_mismatch', 'key_conflict'] as const)(
    'vera-349: remembers a looked-up issue refused as %s across restarts',
    async (code) => {
      const journalPath = pathFor()
      writeFileSync(journalPath, JSON.stringify({ [keyFor()]: { issueNumber: null, startedAt: Date.now() } }))
      const findIssue = vi.fn(
        async (_agent: string, _repo: string, _marker: string, _login?: string | null, rejected?: number[]) =>
          rejected?.includes(777) ? 42 : 777
      )
      const fileIssue = vi.fn(async () => 43)
      const orchestrate = async (p: KanbanOrchestrate): Promise<KanbanOrchestrateOk> => {
        if (p.op === 'prepare_create') return { ok: true, op: p.op, verdict: 'proceed', appLogin: 'acme-app[bot]' }
        if (p.op === 'commit_create' && p.issueNumber === 777) return { ok: false, op: p.op, code }
        return { ok: true, op: 'commit_create', cardId: 'c', issueNumber: 42 }
      }
      const deps = { orchestrate, fileIssue, findIssue, journalPath, repoFullNameFor: async () => 'acme/web' }
      expect(await new KanbanOrchestratorTools(deps).create(req)).toMatchObject({ refused: expect.any(String) })
      expect(await new KanbanOrchestratorTools(deps).create(req)).toMatchObject({ created: true, issueNumber: 42 })
      expect(findIssue.mock.calls[1]?.[4]).toEqual([777])
      expect(fileIssue).not.toHaveBeenCalled()
      expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toEqual({})
    }
  )

  it('vera-349: a corrupt journal blocks fresh creates only through the listing lag, then files once', async () => {
    const journalPath = pathFor()
    writeFileSync(journalPath, 'lost journal contents')
    let now = 1_000_000
    const findIssue = vi.fn(async () => null)
    const fileIssue = vi.fn(async () => 42)
    const svc = new KanbanOrchestratorTools({
      orchestrate: async (p) =>
        p.op === 'prepare_create'
          ? { ok: true, op: p.op, verdict: 'proceed' }
          : { ok: true, op: 'commit_create', cardId: 'c', issueNumber: 42 },
      repoFullNameFor: async () => 'acme/web',
      findIssue,
      fileIssue,
      journalPath,
      now: () => now
    })
    // Inside the lag a landed POST may still be unlisted, so refuse without leaving an intent that outlives it.
    expect(await svc.create(req)).toMatchObject({ refused: expect.any(String), retryable: true })
    expect(fileIssue).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toEqual({})
    now += 60_000
    expect(await svc.create(req)).toMatchObject({ created: true, issueNumber: 42 })
    expect(findIssue).toHaveBeenCalledTimes(2)
    expect(fileIssue).toHaveBeenCalledTimes(1)
    // Past the one-hour retention nothing lost can remain, so ordinary creates skip lookup again.
    now += 60 * 60 * 1000
    expect(await svc.create({ ...req, step: 'later' })).toMatchObject({ created: true })
    expect(findIssue).toHaveBeenCalledTimes(2)
    expect(fileIssue).toHaveBeenCalledTimes(2)
  })

  it('vera-349: a transient commit refusal retains the filed number', async () => {
    const h = tools(async (p) =>
      p.op === 'prepare_create'
        ? { ok: true, op: p.op, verdict: 'proceed' }
        : { ok: false, op: 'commit_create', code: 'github_unavailable' }
    )
    expect(await h.svc.create(req)).toMatchObject({ retryable: true })
    await h.svc.create(req)
    expect(h.fileIssue).toHaveBeenCalledTimes(1)
  })

  it.each(['not_orchestrator', 'board_disabled'] as const)(
    'vera-349: a prepare %s refusal evicts every orchestrator grant before board resolution',
    async (code) => {
      const invalidateAllTokens = vi.fn()
      const svc = new KanbanOrchestratorTools({
        orchestrate: async () => ({ ok: false, op: 'prepare_create', code }),
        repoFullNameFor: async () => 'acme/web',
        findIssue: async () => null,
        fileIssue: async () => 42,
        invalidateToken: vi.fn(),
        invalidateAllTokens
      })
      await expect(svc.create(req)).resolves.toMatchObject({ refused: expect.any(String) })
      expect(invalidateAllTokens).toHaveBeenCalledWith(AGENT)
    }
  )
})
