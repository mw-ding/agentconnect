import { describe, expect, it, vi } from 'vitest'
import type { KanbanBoardRecord } from '../persistence/ports.js'
import type { RepoPermissionLevel } from '../github/repo-permission.js'
import type { CardIssue, LabelEvent } from './card-store.js'
import { KanbanImporter, KanbanImportInconclusiveError } from './importer.js'

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
  const clock = { now: new Date('2026-10-17T00:00:00Z') }
  const importer = new KanbanImporter({ cards, store, permissions, appSlug: APP, log, now: () => clock.now })
  return { cards, store, permissions, log, importer, clock }
}

const issue = (labels = ['ac/status:ready']): CardIssue => ({
  issueId: 100n,
  nodeId: 'I_100',
  number: 1,
  state: 'open',
  labels,
  authorLogin: 'alice',
  authorType: 'User',
  authorViaGithubApp: false
})

let nextId = 1
const user = (login: string) => ({ type: 'User', login })
function labeled(label: string, login: string, extra: Partial<LabelEvent> = {}): LabelEvent[] {
  return [{ id: nextId++, event: 'labeled', label: { name: label }, actor: user(login), ...extra }]
}
const transferred = (login: string): LabelEvent[] => [{ id: nextId++, event: 'transferred', actor: user(login) }]
const upserted = (h: ReturnType<typeof harness>) => h.cards.upsertCard.mock.calls[0]![0] as Record<string, unknown>

describe('Kanban issue import', () => {
  it.each([
    ['other/web', false],
    [null, false],
    ['ACME/Web', true],
    [undefined, true]
  ] as const)('fences the read on the board repository name %s', async (name, imports) => {
    const h = harness({ ...issue(), ...(name !== undefined ? { repositoryFullName: name } : {}) })
    expect(await h.importer.import(board, repo, 1)).toBe(imports)
    expect(h.cards.upsertCard).toHaveBeenCalledTimes(imports ? 1 : 0)
    expect(h.store.applyPlan).toHaveBeenCalledTimes(imports ? 1 : 0)
    if (!imports)
      expect(h.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'repository_mismatch' }),
        expect.any(String)
      )
  })
  it('refreshes the board name after a repository rename and imports under the new name', async () => {
    const h = harness({ ...issue(), repositoryFullName: 'acme/web-renamed' })
    const boards = { refreshRepoFullName: vi.fn(async () => true) }
    const store = { ...h.store, readRepositoryFullName: vi.fn(async () => 'acme/web-renamed') }
    const importer = new KanbanImporter({ cards: h.cards, boards, store, permissions: h.permissions, appSlug: APP })
    expect(await importer.import(board, repo, 1)).toBe(true)
    expect(store.readRepositoryFullName).toHaveBeenCalledWith(repo)
    expect(boards.refreshRepoFullName).toHaveBeenCalledWith('board', 42n, 'acme/web-renamed')
    expect(h.store.applyPlan.mock.calls[0]![0]).toMatchObject({ repoFullName: 'acme/web-renamed' })
  })

  it.each([
    ['a redirect to another repository', 'acme/web'],
    ['an unreadable repository name', null],
    ['a lost rename compare-and-set', 'other/web']
  ] as const)('refuses the import on %s', async (_case, current) => {
    const h = harness({ ...issue(), repositoryFullName: 'other/web' })
    const boards = { refreshRepoFullName: vi.fn(async () => false) }
    const store = { ...h.store, readRepositoryFullName: vi.fn(async () => current) }
    const importer = new KanbanImporter({ cards: h.cards, boards, store, permissions: h.permissions, appSlug: APP })
    expect(await importer.import(board, repo, 1)).toBe(false)
    expect(h.cards.upsertCard).not.toHaveBeenCalled()
    if (current !== 'other/web') expect(boards.refreshRepoFullName).not.toHaveBeenCalled()
  })

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

describe('Kanban import event lag and identity regressions', () => {
  const both = ['ac/status:ready', 'ac/agent:worker']
  const removed = (label: string) => labeled(label, 'bob', { event: 'unlabeled' })

  it.each(['ac/status:ready', 'AC/STATUS:READY'])(
    'rejects a stale writer add when the latest visible status event removes %s',
    async (label) => {
      const h = harness(issue(both), undefined, [
        ...labeled('ac/status:ready', 'bob'),
        ...labeled('ac/agent:worker', 'bob'),
        ...removed(label)
      ])
      await h.importer.import(board, repo, 1)
      expect(upserted(h)).toMatchObject({ status: 'triage', assigneeAgentId: null })
      expect(upserted(h)).not.toHaveProperty('humanAuthority')
    }
  )

  it.each(['read', 'write'] as const)('checks the different re-adder with %s permission', async (level) => {
    const h = harness(
      issue(both),
      { alice: 'write', bob: 'write', rita: level },
      [
        ...labeled('ac/status:ready', 'bob'),
        ...labeled('ac/agent:worker', 'bob'),
        ...removed('ac/status:ready'),
        ...labeled('AC/STATUS:READY', 'rita')
      ].reverse()
    )
    await h.importer.import(board, repo, 1)
    expect(upserted(h)).toMatchObject({
      status: level === 'write' ? 'ready' : 'triage',
      assigneeAgentId: level === 'write' ? 'agent' : null
    })
    if (level === 'read') expect(upserted(h)).not.toHaveProperty('humanAuthority')
    else expect(upserted(h)).toHaveProperty('humanAuthority.login', 'rita')
  })

  it.each(['ac/agent:worker', 'AC/Agent:worker'])(
    'drops the agent when the latest visible event removes %s',
    async (label) => {
      const h = harness(issue(both), undefined, [
        ...labeled('ac/status:ready', 'bob'),
        ...labeled('ac/agent:worker', 'bob'),
        ...removed(label)
      ])
      await h.importer.import(board, repo, 1)
      expect(upserted(h)).toMatchObject({ status: 'ready', assigneeAgentId: null })
      expect(h.cards.resolveAgentSlug).not.toHaveBeenCalled()
    }
  )

  it('orders equal event ids by created_at, regardless of array order', async () => {
    const h = harness(issue(both), undefined, [
      ...labeled('ac/status:ready', 'bob', { id: 10, event: 'unlabeled', created_at: '2026-10-17T12:00:01Z' }),
      ...labeled('ac/status:ready', 'bob', { id: 10, created_at: '2026-10-17T12:00:00Z' }),
      ...labeled('ac/agent:worker', 'bob')
    ])
    await h.importer.import(board, repo, 1)
    expect(upserted(h)).toMatchObject({ status: 'triage', assigneeAgentId: null })
  })

  it('requires a visible transfer event for the transferred action', async () => {
    const h = harness(issue(both), undefined, [
      ...labeled('ac/status:ready', 'bob'),
      ...labeled('ac/agent:worker', 'bob')
    ])
    await h.importer.import(board, repo, 1, { action: 'transferred' })
    expect(upserted(h)).toMatchObject({ status: 'triage', assigneeAgentId: null })
    expect(upserted(h)).not.toHaveProperty('humanAuthority')
  })

  it.each([
    ['writer', user('bob'), false, 'ready'],
    ['non-writer', user('rita'), false, 'triage'],
    ['App', { type: 'Bot', login: `${APP}[bot]` }, false, 'triage'],
    ['App on behalf of a writer', user('bob'), true, 'triage']
  ] as const)('checks a visible %s transfer actor on transferred actions', async (_name, actor, viaApp, status) => {
    const h = harness(issue(both), { alice: 'write', bob: 'write', rita: 'read', [`${APP}[bot]`]: 'write' }, [
      ...labeled('ac/status:ready', 'bob'),
      ...labeled('ac/agent:worker', 'bob'),
      { id: nextId++, event: 'transferred', actor, performed_via_github_app: viaApp }
    ])
    await h.importer.import(board, repo, 1, { action: 'transferred' })
    expect(upserted(h)).toMatchObject({ status, assigneeAgentId: status === 'ready' ? 'agent' : null })
    if (status === 'triage') expect(upserted(h)).not.toHaveProperty('humanAuthority')
  })

  it.each([
    ['App on behalf of a writer', { authorViaGithubApp: true }],
    ['bot', { authorType: 'Bot' }],
    ['bot login', { authorLogin: 'helper[bot]' }],
    ['unknown author type', { authorType: undefined }]
  ])('forces triage for an %s author before checking permissions', async (_name, author) => {
    const h = harness({ ...issue(both), ...author }, { alice: 'write', bob: 'write', 'helper[bot]': 'write' })
    await h.importer.import(board, repo, 1)
    expect(upserted(h)).toMatchObject({ status: 'triage', assigneeAgentId: null })
    expect(upserted(h)).not.toHaveProperty('humanAuthority')
    expect(h.permissions.permission).not.toHaveBeenCalled()
  })

  it.each([['AC/STATUS:todo', 'ac/status:ready'], ['AC/STATUS:todo']])(
    'imports malformed status case variants as triage: %s',
    async (...labels) => {
      const h = harness(issue(labels))
      expect(await h.importer.import(board, repo, 1)).toBe(true)
      expect(upserted(h)).toMatchObject({ status: 'triage', assigneeAgentId: null })
      expect(upserted(h)).not.toHaveProperty('humanAuthority')
    }
  )
})

// The visible history shows bob's adds while a later remove+re-add is still invisible; the doorbell names its sender.
describe('Kanban import labeled-doorbell sender', () => {
  const events = () => [...labeled('ac/status:ready', 'bob'), ...labeled('ac/agent:worker', 'bob')]
  const levels: Levels = { alice: 'write', bob: 'write', carol: 'write', mallory: 'triage' }
  const doorbell = (login: string, label = 'ac/status:ready') => ({
    action: 'labeled',
    sender: { login, id: login.length, type: 'User' },
    label
  })

  it.each(['ac/status:ready', 'ac/agent:worker'])(
    "imports a non-writer sender's invisible %s re-add as unassigned triage",
    async (label) => {
      const h = harness(issue(['ac/status:ready', 'ac/agent:worker']), levels, events())
      expect(await h.importer.import(board, repo, 1, doorbell('mallory', label))).toBe(true)
      expect(upserted(h)).toMatchObject({ status: 'triage', assigneeAgentId: null })
      expect(h.permissions.permission).toHaveBeenCalledWith(repo, 'mallory')
    }
  )

  it("retries a writer sender's invisible re-add, then imports triage at the bound", async () => {
    const h = harness(issue(['ac/status:ready', 'ac/agent:worker']), levels, events())
    await expect(h.importer.import(board, repo, 1, doorbell('carol'))).rejects.toBeInstanceOf(
      KanbanImportInconclusiveError
    )
    h.clock.now = new Date(h.clock.now.getTime() + 9 * 60_000)
    await expect(h.importer.import(board, repo, 1, doorbell('carol'))).rejects.toBeInstanceOf(
      KanbanImportInconclusiveError
    )
    expect(h.cards.upsertCard).not.toHaveBeenCalled()
    expect(h.store.applyPlan).not.toHaveBeenCalled()
    h.clock.now = new Date(h.clock.now.getTime() + 60_000)
    expect(await h.importer.import(board, repo, 1, doorbell('carol'))).toBe(true)
    expect(upserted(h)).toMatchObject({ status: 'triage', assigneeAgentId: null })
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'doorbell_add_not_visible' }),
      expect.any(String)
    )
  })

  it("imports normally once the sender's add is the latest visible event, or the named label is gone", async () => {
    const visible = harness(issue(['ac/status:ready', 'ac/agent:worker']), levels, [
      ...events(),
      ...labeled('ac/status:ready', 'carol')
    ])
    expect(await visible.importer.import(board, repo, 1, doorbell('carol'))).toBe(true)
    expect(upserted(visible)).toMatchObject({ status: 'ready', assigneeAgentId: 'agent' })
    const gone = harness(issue(['ac/status:ready', 'ac/agent:worker']), levels, events())
    expect(await gone.importer.import(board, repo, 1, doorbell('mallory', 'ac/status:blocked'))).toBe(true)
    expect(upserted(gone)).toMatchObject({ status: 'ready', assigneeAgentId: 'agent' })
  })
})
