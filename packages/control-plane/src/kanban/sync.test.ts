import { describe, expect, it, vi } from 'vitest'
import { KanbanSync, type SyncCard, type KanbanSyncDeps } from './sync.js'
import { KANBAN_STATUSES, canTransition, LEASED_HUMAN_STATUSES, planLabelReconcile } from './card-state.js'
import type { CardIssue, LabelEvent } from './card-store.js'
import type { RepoPermissionLevel } from '../github/repo-permission.js'

const target = { installationId: 1n, repoId: 42n, repoFullName: 'acme/web' }
const event = (id = 1, human = true): LabelEvent => ({
  id,
  event: 'labeled',
  actor: { type: human ? 'User' : 'Bot', login: human ? 'alice' : 'app[bot]' }
})

function fixture(overrides: Partial<SyncCard> = {}) {
  let card: SyncCard = {
    id: 'card',
    boardId: 'board',
    orgId: 'org',
    issueNumber: 1,
    status: 'todo',
    stateRevision: 1n,
    dispatchRevision: 1n,
    assigneeAgentId: null,
    promotionPending: false,
    labelWritePending: false,
    syncEventCursor: 0n,
    syncAgentCursor: 0n,
    lease: null,
    ...overrides
  }
  const issue: CardIssue = { issueId: 1n, nodeId: 'I_1', number: 1, state: 'open', labels: ['ac/status:ready'] }
  const deps: KanbanSyncDeps = {
    repo: {
      get: vi.fn(async () => ({ ...card })),
      list: vi.fn(async () => [1]),
      apply: vi.fn(async (_card, plan, cursor) => {
        const changed = card.status !== plan.status
        const revoked = plan.releaseLease ? card.lease : null
        card = {
          ...card,
          status: plan.status,
          stateRevision: card.stateRevision + (changed ? 1n : 0n),
          syncEventCursor: cursor,
          lease: revoked ? null : card.lease
        }
        return { changed, revoked }
      }),
      ack: vi.fn(async () => true)
    },
    cards: {
      resolveAgentSlug: vi.fn(async () => 'next-agent'),
      setAssignee: vi.fn(async () => ({ ok: false as const, reason: 'not_found' as const }))
    },
    store: {
      statusSetByHuman: vi.fn(async () => true),
      readCard: vi.fn(async () => issue),
      applyPlan: vi.fn(async () => {}),
      managedEdits: vi.fn(async () => ({ status: event(), assignee: null, cursor: 1 }))
    },
    permissions: { permission: vi.fn(async (): Promise<RepoPermissionLevel> => 'write') },
    appSlug: 'agentconnect',
    repoRef: vi.fn(async () => target),
    revoke: vi.fn(async () => {}),
    promote: vi.fn(async () => {}),
    log: { warn: vi.fn() }
  }
  return { deps, issue, sync: new KanbanSync(deps), card: () => card }
}

describe('human label synchronization', () => {
  it.each(
    KANBAN_STATUSES.flatMap((from) =>
      KANBAN_STATUSES.flatMap((to) => [false, true].map((leased) => ({ from, to, leased })))
    )
  )('$from → $to, leased=$leased', async ({ from, to, leased }) => {
    const f = fixture({
      status: from,
      lease: leased
        ? { leaseId: 'lease', runId: 'run', agentId: 'worker', daemonId: 'daemon', dispatchRevision: 1n }
        : null
    })
    f.issue.labels = [`ac/status:${to}`]
    await f.sync.onCardChanged('board', 1, true)
    const allowed = from !== to && canTransition(from, to) && (!leased || LEASED_HUMAN_STATUSES.has(to))
    expect(f.card().status).toBe(allowed ? to : from)
    expect(f.deps.revoke).toHaveBeenCalledTimes(allowed && leased ? 1 : 0)
    const expected = planLabelReconcile({ status: from, leased }, f.issue)
    expect(f.deps.store.applyPlan).toHaveBeenCalledWith(
      target,
      1,
      f.issue,
      expect.objectContaining({ status: expected.status, ...(expected.comment ? { comment: expected.comment } : {}) })
    )
  })

  it('repairs conflicting status labels with the fixed explanation', async () => {
    const f = fixture()
    f.issue.labels = ['ac/status:todo', 'ac/status:ready', 'ac/status:blocked']
    await f.sync.onCardChanged('board', 1, true)
    expect(f.card().status).toBe('todo')
    expect(f.deps.store.applyPlan).toHaveBeenCalledWith(
      target,
      1,
      f.issue,
      expect.objectContaining({
        comment: expect.stringContaining('exactly one status label'),
        removeLabels: ['ac/status:ready', 'ac/status:blocked']
      })
    )
  })

  const refusal = 'only collaborators with write access'
  type ActorCase = {
    name: string
    actor: LabelEvent['actor']
    via?: boolean
    level?: RepoPermissionLevel | Error
    verdict: 'accept' | 'refuse' | 'ignore'
  }
  const alice = { type: 'User', login: 'alice' }
  it.each<ActorCase>([
    { name: 'human with write', actor: alice, level: 'write', verdict: 'accept' },
    { name: 'human with maintain', actor: alice, level: 'maintain', verdict: 'accept' },
    { name: 'human with admin', actor: alice, level: 'admin', verdict: 'accept' },
    { name: 'human with triage', actor: alice, level: 'triage', verdict: 'refuse' },
    { name: 'human with read', actor: alice, level: 'read', verdict: 'refuse' },
    { name: 'non-collaborator', actor: alice, level: 'none', verdict: 'refuse' },
    { name: 'permission lookup throws', actor: alice, level: new Error('offline'), verdict: 'refuse' },
    { name: 'deployment App bot', actor: { type: 'Bot', login: 'AgentConnect[bot]' }, verdict: 'ignore' },
    { name: 'other bot', actor: { type: 'Bot', login: 'dependabot[bot]' }, verdict: 'ignore' },
    { name: 'User-typed [bot] login', actor: { type: 'User', login: 'ci[bot]' }, verdict: 'ignore' },
    { name: 'performed_via_github_app', actor: alice, via: true, verdict: 'ignore' },
    { name: 'unknown actor', actor: null, verdict: 'ignore' }
  ])('status edit by $name: $verdict', async ({ actor, via, level, verdict }) => {
    const f = fixture()
    const e: LabelEvent = { id: 1, event: 'labeled', label: { name: 'ac/status:ready' }, actor }
    if (via) e.performed_via_github_app = { id: 1 }
    vi.mocked(f.deps.store.managedEdits).mockResolvedValue({ status: e, assignee: null, cursor: 1 })
    if (level instanceof Error) vi.mocked(f.deps.permissions.permission).mockRejectedValue(level)
    else if (level) vi.mocked(f.deps.permissions.permission).mockResolvedValue(level)
    await f.sync.onCardChanged('board', 1, true)
    expect(f.card().status).toBe(verdict === 'accept' ? 'ready' : 'todo')
    // Bots and Apps never cost a permission lookup; every human edit is checked live.
    expect(f.deps.permissions.permission).toHaveBeenCalledTimes(verdict === 'ignore' ? 0 : 1)
    if (verdict !== 'ignore') expect(f.deps.permissions.permission).toHaveBeenCalledWith(target, 'alice')
    // The edit is consumed either way, so a refused or ignored label is not re-evaluated on every tick.
    expect(f.deps.repo.apply).toHaveBeenCalledWith(expect.anything(), expect.anything(), 1n, verdict === 'accept', 0n)
    const written = vi.mocked(f.deps.store.applyPlan).mock.calls.at(-1)![3]
    if (verdict === 'accept') expect(written).toMatchObject({ addLabels: [], removeLabels: [] })
    else expect(written).toMatchObject({ addLabels: ['ac/status:todo'], removeLabels: ['ac/status:ready'] })
    if (verdict === 'refuse') expect(written.comment).toContain(refusal)
    else expect(written.comment ?? '').not.toContain(refusal)
    expect(f.deps.log.warn).toHaveBeenCalledTimes(level instanceof Error ? 1 : 0)
  })

  it('reopens an issue a read-only author closed', async () => {
    const f = fixture({ status: 'ready' })
    f.issue.state = 'closed'
    f.issue.stateReason = 'completed'
    vi.mocked(f.deps.store.managedEdits).mockResolvedValue({
      status: { id: 1, event: 'closed', actor: alice },
      assignee: null,
      cursor: 1
    })
    vi.mocked(f.deps.permissions.permission).mockResolvedValue('read')
    await f.sync.onCardChanged('board', 1, true)
    expect(f.card().status).toBe('ready')
    expect(vi.mocked(f.deps.store.applyPlan).mock.calls.at(-1)![3]).toMatchObject({
      issueState: { state: 'open' },
      comment: expect.stringContaining(refusal)
    })
  })

  it.each([
    { edit: 'labeled' as const, labels: ['ac/status:todo', 'ac/agent:next'], add: [], remove: ['ac/agent:next'] },
    { edit: 'unlabeled' as const, labels: ['ac/status:todo'], add: ['ac/agent:old'], remove: [] }
  ])('undoes a read-only $edit ac/agent edit without reassigning', async ({ edit, labels, add, remove }) => {
    const f = fixture()
    f.issue.labels = labels
    const name = edit === 'labeled' ? 'ac/agent:next' : 'ac/agent:old'
    vi.mocked(f.deps.store.managedEdits).mockResolvedValue({
      status: null,
      assignee: { id: 2, event: edit, label: { name }, actor: alice },
      cursor: 2
    })
    vi.mocked(f.deps.permissions.permission).mockResolvedValue('triage')
    await f.sync.onCardChanged('board', 1, true)
    expect(f.deps.cards.setAssignee).not.toHaveBeenCalled()
    expect(f.deps.repo.apply).toHaveBeenCalledWith(expect.anything(), expect.anything(), 0n, false, 2n)
    expect(vi.mocked(f.deps.store.applyPlan).mock.calls.at(-1)![3]).toMatchObject({
      addLabels: add,
      removeLabels: remove,
      comment: expect.stringContaining(refusal)
    })
  })

  it('ignores an App ac/agent edit without a lookup, a revert, or a comment', async () => {
    const f = fixture()
    f.issue.labels = ['ac/status:todo', 'ac/agent:next']
    vi.mocked(f.deps.store.managedEdits).mockResolvedValue({
      status: null,
      assignee: {
        id: 2,
        event: 'labeled',
        label: { name: 'ac/agent:next' },
        actor: { type: 'Bot', login: 'agentconnect[bot]' }
      },
      cursor: 2
    })
    await f.sync.onCardChanged('board', 1, true)
    expect(f.deps.permissions.permission).not.toHaveBeenCalled()
    expect(f.deps.cards.setAssignee).not.toHaveBeenCalled()
    expect(vi.mocked(f.deps.store.applyPlan).mock.calls.at(-1)![3]).toMatchObject({ addLabels: [], removeLabels: [] })
    expect(vi.mocked(f.deps.store.applyPlan).mock.calls.at(-1)![3].comment).toBeUndefined()
  })

  it('looks a login up once per reconcile and never reuses a grant across edits', async () => {
    const f = fixture()
    f.issue.labels = ['ac/status:ready', 'ac/agent:next']
    vi.mocked(f.deps.store.managedEdits).mockResolvedValue({
      status: event(1),
      assignee: { id: 2, event: 'labeled', label: { name: 'ac/agent:next' }, actor: { type: 'User', login: 'Alice' } },
      cursor: 2
    })
    await f.sync.onCardChanged('board', 1, true)
    expect(f.deps.permissions.permission).toHaveBeenCalledTimes(1)
    vi.mocked(f.deps.store.managedEdits).mockResolvedValue({ status: event(3), assignee: null, cursor: 3 })
    await f.sync.onCardChanged('board', 1, true)
    expect(f.deps.permissions.permission).toHaveBeenCalledTimes(2)
  })

  it('does not re-evaluate a consumed edit', async () => {
    const f = fixture({ syncEventCursor: 1n })
    await f.sync.onCardChanged('board', 1, true)
    expect(f.card().status).toBe('todo')
    expect(f.deps.permissions.permission).not.toHaveBeenCalled()
  })

  it('projects a pending CP transition instead of adopting its old label on the tick', async () => {
    const f = fixture({ status: 'review', labelWritePending: true })
    await f.sync.reconcileBoard('board')
    expect(f.card().status).toBe('review')
    expect(f.deps.store.applyPlan).toHaveBeenCalledWith(
      target,
      1,
      f.issue,
      expect.objectContaining({ addLabels: ['ac/status:review'], removeLabels: ['ac/status:ready'] })
    )
  })

  it('leaves a failed GitHub write pending and retries it', async () => {
    const f = fixture({ status: 'review', labelWritePending: true })
    vi.mocked(f.deps.store.applyPlan).mockRejectedValueOnce(new Error('offline'))
    await expect(f.sync.onCardChanged('board', 1)).rejects.toThrow('offline')
    expect(f.deps.repo.ack).not.toHaveBeenCalled()
    await f.sync.onCardChanged('board', 1)
    expect(f.deps.repo.ack).toHaveBeenCalledOnce()
  })

  it('does not acknowledge a stale CAS or touch a pending promotion', async () => {
    const f = fixture()
    vi.mocked(f.deps.repo.apply).mockResolvedValue(null)
    await f.sync.onCardChanged('board', 1)
    expect(f.deps.store.applyPlan).not.toHaveBeenCalled()
    const pending = fixture({ promotionPending: true })
    await pending.sync.onCardChanged('board', 1, true)
    expect(pending.deps.store.readCard).not.toHaveBeenCalled()
  })

  it.each([['ac/agent:missing'], ['ac/agent:a', 'ac/agent:b'], ['ac/agent:???']])(
    'preserves an ambiguous or unknown assignee: %j',
    async (...labels) => {
      const f = fixture()
      f.issue.labels = ['ac/status:todo', ...labels]
      vi.mocked(f.deps.cards.resolveAgentSlug).mockResolvedValue(null)
      vi.mocked(f.deps.store.managedEdits).mockResolvedValue({ status: null, assignee: event(), cursor: 1 })
      await f.sync.onCardChanged('board', 1, true)
      expect(f.deps.cards.setAssignee).not.toHaveBeenCalled()
    }
  )

  it('isolates a failed card so the rest of the bounded tick still runs', async () => {
    const f = fixture()
    vi.mocked(f.deps.repo.list).mockResolvedValue([1, 2])
    vi.mocked(f.deps.store.readCard).mockRejectedValueOnce(new Error('offline'))
    await f.sync.reconcileBoard('board')
    expect(f.deps.repo.get).toHaveBeenCalledWith('board', 2)
    expect(f.deps.log.warn).toHaveBeenCalledOnce()
  })
})
