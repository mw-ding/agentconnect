import { describe, expect, it, vi } from 'vitest'
import type { KanbanBoardRecord } from '../persistence/ports.js'
import type { RepoPermissionLevel } from '../github/repo-permission.js'
import type { CardIssue, LabelEvent } from './card-store.js'
import { KanbanImporter } from './importer.js'

const board = { id: 'board', orgId: 'org' } as KanbanBoardRecord
const repo = { installationId: 7n, repoId: 42n, repoFullName: 'acme/web' }
const APP = 'agentconnect'

type Levels = Record<string, RepoPermissionLevel | Error>

function harness(
  issue: CardIssue | null,
  levels: Levels = { alice: 'write', bob: 'write' },
  events: LabelEvent[] | Error = labeled('ac/status:ready', 'bob')
) {
  const cards = {
    findByIssueNumber: vi.fn(async () => null),
    resolveAgentSlug: vi.fn(async () => 'agent'),
    upsertCard: vi.fn()
  }
  const store = {
    readCard: vi.fn(async () => issue),
    applyPlan: vi.fn(),
    readLabelEvents: vi.fn(async () => {
      if (events instanceof Error) throw events
      return events
    })
  }
  const permissions = {
    permission: vi.fn(async (_repo: unknown, login: string) => {
      const level = levels[login] ?? 'none'
      if (level instanceof Error) throw level
      return level
    })
  }
  const log = { warn: vi.fn() }
  const importer = new KanbanImporter({ cards, store, permissions, appSlug: APP, log })
  return { cards, store, permissions, log, importer }
}

const issue = (labels = ['ac/status:ready']): CardIssue => ({
  issueId: 100n,
  nodeId: 'I_100',
  number: 1,
  state: 'open',
  labels,
  authorLogin: 'alice'
})

let nextId = 1
const user = (login: string) => ({ type: 'User', login })
function labeled(label: string, login: string, extra: Partial<LabelEvent> = {}): LabelEvent[] {
  return [{ id: nextId++, event: 'labeled', label: { name: label }, actor: user(login), ...extra }]
}
const transferred = (login: string): LabelEvent[] => [{ id: nextId++, event: 'transferred', actor: user(login) }]
const upserted = (h: ReturnType<typeof harness>) => h.cards.upsertCard.mock.calls[0]![0] as Record<string, unknown>

describe('Kanban issue import', () => {
  it.each(['admin', 'maintain', 'write', 'triage', 'read', 'none', new Error('offline')] as const)(
    'gates the author using live permission %s',
    async (level) => {
      const h = harness(issue(), { alice: level, bob: 'write' })
      expect(await h.importer.import(board, repo, 1)).toBe(true)
      const status = ['admin', 'maintain', 'write'].includes(String(level)) ? 'ready' : 'triage'
      expect(h.cards.upsertCard).toHaveBeenCalledWith(
        expect.objectContaining({ status, source: 'import', issueId: 100n, expectedRepoId: 42n })
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
    const h = harness(issue([`ac/status:${status}`]), undefined, labeled(`ac/status:${status}`, 'bob'))
    await h.importer.import(board, repo, 1)
    expect(h.cards.upsertCard).toHaveBeenCalledWith(expect.objectContaining({ status: 'triage' }))
    expect(upserted(h)).not.toHaveProperty('humanAuthority')
  })
  it('leaves no DB row if the safety label write fails', async () => {
    const h = harness(issue(), { alice: 'read' })
    h.store.applyPlan.mockRejectedValueOnce(new Error('label write failed'))
    await expect(h.importer.import(board, repo, 1)).rejects.toThrow('label write failed')
    expect(h.cards.upsertCard).not.toHaveBeenCalled()
  })
})

describe('Kanban import label attribution', () => {
  const both = ['ac/status:ready', 'ac/agent:worker']

  it('keeps status and assignee when a writer authored and a writer added both labels', async () => {
    const h = harness(issue(both), undefined, [
      ...labeled('ac/status:ready', 'bob'),
      ...labeled('ac/agent:worker', 'bob')
    ])
    await h.importer.import(board, repo, 1)
    expect(h.cards.resolveAgentSlug).toHaveBeenCalledWith('org', 'worker')
    expect(upserted(h)).toMatchObject({
      status: 'ready',
      assigneeAgentId: 'agent',
      humanAuthority: { login: 'bob', permission: 'write' }
    })
    expect(h.store.readLabelEvents).toHaveBeenCalledWith(repo, 1)
  })

  it("imports a triage-role collaborator's ready label on a writer's issue as triage with no assignee", async () => {
    const h = harness(issue(both), { alice: 'write', tim: 'triage' }, [
      ...labeled('ac/status:ready', 'tim'),
      ...labeled('ac/agent:worker', 'tim')
    ])
    await h.importer.import(board, repo, 1)
    expect(upserted(h)).toMatchObject({ status: 'triage', assigneeAgentId: null })
    expect(upserted(h)).not.toHaveProperty('humanAuthority')
    expect(h.cards.resolveAgentSlug).not.toHaveBeenCalled()
    expect(h.store.applyPlan).toHaveBeenCalledWith(repo, 1, issue(both), expect.objectContaining({ status: 'triage' }))
  })

  it.each([
    ['our App', { actor: { type: 'Bot', login: `${APP}[bot]` } }],
    ['another bot', { actor: { type: 'Bot', login: 'renovate[bot]' } }],
    ['a [bot] user login', { actor: { type: 'User', login: 'helper[bot]' } }],
    ['an App acting for a user', { actor: user('bob'), performed_via_github_app: { slug: 'x' } }],
    ['no actor', { actor: null }]
  ] as Array<[string, Partial<LabelEvent>]>)('forces triage when %s added the status label', async (_name, actor) => {
    const writers = { alice: 'write', bob: 'write', [`${APP}[bot]`]: 'write', 'renovate[bot]': 'write' } as const
    const h = harness(issue(both), { ...writers, 'helper[bot]': 'write' }, [
      ...labeled('ac/status:ready', 'bob', actor),
      ...labeled('ac/agent:worker', 'bob')
    ])
    await h.importer.import(board, repo, 1)
    expect(upserted(h)).toMatchObject({ status: 'triage', assigneeAgentId: null })
  })

  it('keeps a human writer’s status but drops an assignee our App labeled', async () => {
    const h = harness(issue(both), undefined, [
      ...labeled('ac/status:ready', 'bob'),
      ...labeled('ac/agent:worker', 'x', { actor: { type: 'Bot', login: `${APP}[bot]` } })
    ])
    await h.importer.import(board, repo, 1)
    expect(upserted(h)).toMatchObject({ status: 'ready', assigneeAgentId: null })
    expect(h.cards.resolveAgentSlug).not.toHaveBeenCalled()
  })

  it('drops an assignee a non-writer labeled', async () => {
    const h = harness(issue(['ac/status:todo', 'ac/agent:worker']), { alice: 'write', bob: 'write', rita: 'read' }, [
      ...labeled('ac/status:todo', 'bob'),
      ...labeled('ac/agent:worker', 'rita')
    ])
    await h.importer.import(board, repo, 1)
    expect(upserted(h)).toMatchObject({ status: 'todo', assigneeAgentId: null })
  })

  it('attributes the latest add of each label, not an earlier one', async () => {
    const h = harness(issue(both), { alice: 'write', bob: 'write', rita: 'read' }, [
      ...labeled('ac/status:ready', 'bob'),
      ...labeled('ac/agent:worker', 'bob'),
      ...labeled('ac/status:ready', 'rita')
    ])
    await h.importer.import(board, repo, 1)
    expect(upserted(h)).toMatchObject({ status: 'triage', assigneeAgentId: null })
  })

  it('forces triage when no labeled event names the current status label', async () => {
    const h = harness(issue(), undefined, labeled('ac/status:todo', 'bob'))
    await h.importer.import(board, repo, 1)
    expect(upserted(h)).toMatchObject({ status: 'triage' })
  })

  it('forces triage and logs body-free when the events read fails', async () => {
    const err = Object.assign(new Error('token ghs_secret leaked?'), { status: 502 })
    const h = harness(issue(), undefined, err)
    await h.importer.import(board, repo, 1)
    expect(upserted(h)).toMatchObject({ status: 'triage', assigneeAgentId: null })
    expect(h.log.warn).toHaveBeenCalledWith(
      { boardId: 'board', issueNumber: 1, reason: 'events_unreadable', errorName: 'Error', status: 502 },
      expect.any(String)
    )
    expect(JSON.stringify(h.log.warn.mock.calls)).not.toContain('ghs_secret')
  })

  it.each(['alice', 'bob'])('forces triage and logs when the %s permission lookup throws', async (login) => {
    const h = harness(issue(), { alice: 'write', bob: 'write', [login]: new Error('down') })
    await h.importer.import(board, repo, 1)
    expect(upserted(h)).toMatchObject({ status: 'triage' })
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'permission_lookup_failed', boardId: 'board', issueNumber: 1 }),
      expect.any(String)
    )
  })

  it('forces triage when a non-writer transferred the issue in', async () => {
    const h = harness(issue(), { alice: 'write', bob: 'write', rita: 'read' }, [
      ...labeled('ac/status:ready', 'bob'),
      ...transferred('rita')
    ])
    await h.importer.import(board, repo, 1)
    expect(upserted(h)).toMatchObject({ status: 'triage' })
  })

  it('keeps status when a writer transferred the issue in', async () => {
    const h = harness(issue(), undefined, [...transferred('alice'), ...labeled('ac/status:ready', 'bob')])
    await h.importer.import(board, repo, 1)
    expect(upserted(h)).toMatchObject({ status: 'ready', humanAuthority: { login: 'bob', permission: 'write' } })
  })

  it('never reads events or stores an assignee once the author forces triage', async () => {
    const h = harness(issue(both), { alice: 'read', bob: 'write' }, [
      ...labeled('ac/status:ready', 'bob'),
      ...labeled('ac/agent:worker', 'bob')
    ])
    await h.importer.import(board, repo, 1)
    expect(upserted(h)).toMatchObject({ status: 'triage', assigneeAgentId: null })
    expect(upserted(h)).not.toHaveProperty('humanAuthority')
    expect(h.store.readLabelEvents).not.toHaveBeenCalled()
    expect(h.cards.resolveAgentSlug).not.toHaveBeenCalled()
  })

  it('forces triage when several status labels are on the issue', async () => {
    const h = harness(issue(['ac/status:ready', 'ac/status:todo']), undefined, [
      ...labeled('ac/status:ready', 'bob'),
      ...labeled('ac/status:todo', 'bob')
    ])
    await h.importer.import(board, repo, 1)
    expect(upserted(h)).toMatchObject({ status: 'triage', assigneeAgentId: null })
  })

  it('asks GitHub once per login within one import', async () => {
    const h = harness(issue(both), undefined, [
      ...transferred('Alice'),
      ...labeled('ac/status:ready', 'alice'),
      ...labeled('ac/agent:worker', 'ALICE')
    ])
    await h.importer.import(board, repo, 1)
    expect(upserted(h)).toMatchObject({ status: 'ready', assigneeAgentId: 'agent' })
    expect(h.permissions.permission).toHaveBeenCalledTimes(1)
  })
})
