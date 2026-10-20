import { describe, expect, it, vi } from 'vitest'
import { KanbanSync, type SyncCard, type KanbanSyncDeps } from './sync.js'
import { KANBAN_STATUSES, canTransition, LEASED_HUMAN_STATUSES, planLabelReconcile } from './card-state.js'
import { KanbanEventHistoryBoundError, type CardIssue, type LabelEvent } from './card-store.js'
import type { RepoPermissionLevel } from '../github/repo-permission.js'

const target = { installationId: 1n, repoId: 42n, repoFullName: 'acme/web' }
const alice: LabelEvent['actor'] = { type: 'User', login: 'alice' }
const app: LabelEvent['actor'] = { type: 'Bot', login: 'agentconnect[bot]' }
const labelEvent = (
  id: number,
  event: 'labeled' | 'unlabeled',
  name: string,
  actor: LabelEvent['actor']
): LabelEvent => ({
  id,
  event,
  label: { name },
  actor
})
const stateEvent = (id: number, event: 'closed' | 'reopened', actor: LabelEvent['actor']): LabelEvent => ({
  id,
  event,
  actor
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
    syncDeferredAt: null,
    syncDeferralCount: 0,
    needsAttention: false,
    lease: null,
    ...overrides
  }
  const issue: CardIssue = { issueId: 1n, nodeId: 'I_1', number: 1, state: 'open', labels: ['ac/status:ready'] }
  const events: LabelEvent[] = [labelEvent(1, 'labeled', 'ac/status:ready', alice)]
  const deps: KanbanSyncDeps = {
    repo: {
      get: vi.fn(async () => ({ ...card })),
      list: vi.fn(async () => [1]),
      apply: vi.fn(async (_c, plan, cursor, _human, agentCursor) => {
        const changed = card.status !== plan.status
        const revoked = plan.releaseLease ? card.lease : null
        card = {
          ...card,
          status: plan.status,
          stateRevision: card.stateRevision + (changed ? 1n : 0n),
          syncEventCursor: cursor > card.syncEventCursor ? cursor : card.syncEventCursor,
          syncAgentCursor: agentCursor > card.syncAgentCursor ? agentCursor : card.syncAgentCursor,
          syncDeferredAt: null,
          syncDeferralCount: 0,
          lease: revoked ? null : card.lease
        }
        return { changed, revoked }
      }),
      ack: vi.fn(async (_c, cursor, agentCursor = 0n) => {
        card = {
          ...card,
          syncEventCursor: cursor > card.syncEventCursor ? cursor : card.syncEventCursor,
          syncAgentCursor: agentCursor > card.syncAgentCursor ? agentCursor : card.syncAgentCursor,
          labelWritePending: false
        }
        return true
      }),
      defer: vi.fn(async (_c, now) => {
        card = { ...card, syncDeferralCount: card.syncDeferralCount + 1, syncDeferredAt: card.syncDeferredAt ?? now }
        return { ...card }
      }),
      failClosed: vi.fn(async (_c) => {
        const status = card.status === 'ready' || card.status === 'running' ? 'triage' : card.status
        const revoked = card.lease
        card = { ...card, status, needsAttention: true, syncDeferredAt: null, syncDeferralCount: 0, lease: null }
        return { status, revoked }
      })
    },
    cards: {
      resolveAgentSlug: vi.fn(async () => 'next-agent'),
      setAssignee: vi.fn(async () => ({ ok: false as const, reason: 'not_found' as const }))
    },
    store: {
      readCard: vi.fn(async () => issue),
      applyPlan: vi.fn(async () => {}),
      readLabelEvents: vi.fn(async () => events)
    },
    permissions: { permission: vi.fn(async (): Promise<RepoPermissionLevel> => 'write') },
    appSlug: 'agentconnect',
    repoRef: vi.fn(async () => target),
    revoke: vi.fn(async () => {}),
    promote: vi.fn(async () => {}),
    log: { warn: vi.fn() }
  }
  return { deps, issue, events, sync: new KanbanSync(deps), card: () => card }
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
    f.events.splice(0, f.events.length, labelEvent(1, 'labeled', `ac/status:${to}`, alice))
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
    f.events.splice(
      0,
      f.events.length,
      labelEvent(1, 'labeled', 'ac/status:todo', alice),
      labelEvent(2, 'labeled', 'ac/status:ready', alice),
      labelEvent(3, 'labeled', 'ac/status:blocked', alice)
    )
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
    f.events.splice(0, f.events.length, e)
    if (level instanceof Error) vi.mocked(f.deps.permissions.permission).mockRejectedValue(level)
    else if (level) vi.mocked(f.deps.permissions.permission).mockResolvedValue(level)
    await f.sync.onCardChanged('board', 1, true)
    expect(f.card().status).toBe(verdict === 'accept' ? 'ready' : 'todo')
    // Bots and Apps never cost a permission lookup; every human edit is checked live.
    expect(f.deps.permissions.permission).toHaveBeenCalledTimes(verdict === 'ignore' ? 0 : 1)
    if (verdict !== 'ignore') expect(f.deps.permissions.permission).toHaveBeenCalledWith(target, 'alice')
    // The edit is consumed either way, so a refused or ignored label is not re-evaluated on every tick.
    const applyCall = vi.mocked(f.deps.repo.apply).mock.calls.at(-1)!
    expect(applyCall[2]).toBe(1n)
    expect(applyCall[3]).toBe(verdict === 'accept')
    expect(applyCall[4]).toBe(0n)
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
    f.issue.labels = ['ac/status:ready']
    f.events.splice(
      0,
      f.events.length,
      labelEvent(1, 'labeled', 'ac/status:ready', alice),
      stateEvent(2, 'closed', alice)
    )
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
    f.events.splice(0, f.events.length, labelEvent(1, 'labeled', 'ac/status:todo', alice), {
      id: 2,
      event: edit,
      label: { name },
      actor: alice
    })
    vi.mocked(f.deps.permissions.permission).mockResolvedValue('triage')
    await f.sync.onCardChanged('board', 1, true)
    expect(f.deps.cards.setAssignee).not.toHaveBeenCalled()
    // A refused agent edit is undone before its cursor advances.
    const applyCall = vi.mocked(f.deps.repo.apply).mock.calls.at(-1)!
    expect(applyCall[2]).toBe(1n)
    expect(applyCall[3]).toBe(false)
    expect(applyCall[4]).toBe(0n)
    expect(f.deps.repo.ack).toHaveBeenCalledWith(expect.anything(), 1n, 2n)
    expect(vi.mocked(f.deps.store.applyPlan).mock.calls.at(-1)![3]).toMatchObject({
      addLabels: add,
      removeLabels: remove,
      comment: expect.stringContaining(refusal)
    })
  })

  it('ignores an App ac/agent edit without a lookup, a revert, or a comment', async () => {
    const f = fixture()
    f.issue.labels = ['ac/status:todo', 'ac/agent:next']
    f.events.splice(0, f.events.length, labelEvent(1, 'labeled', 'ac/status:todo', alice), {
      id: 2,
      event: 'labeled',
      label: { name: 'ac/agent:next' },
      actor: { type: 'Bot', login: 'agentconnect[bot]' }
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
    f.events.splice(0, f.events.length, labelEvent(1, 'labeled', 'ac/status:ready', alice), {
      id: 2,
      event: 'labeled',
      label: { name: 'ac/agent:next' },
      actor: { type: 'User', login: 'Alice' }
    })
    await f.sync.onCardChanged('board', 1, true)
    expect(f.deps.permissions.permission).toHaveBeenCalledTimes(1)
    f.events.splice(0, f.events.length, labelEvent(3, 'labeled', 'ac/status:ready', alice), {
      id: 2,
      event: 'labeled',
      label: { name: 'ac/agent:next' },
      actor: { type: 'User', login: 'Alice' }
    })
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
    const f = fixture({ status: 'review', labelWritePending: true, syncEventCursor: 1n })
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
    const f = fixture({ status: 'review', labelWritePending: true, syncEventCursor: 1n })
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
      f.events.splice(
        0,
        f.events.length,
        labelEvent(1, 'labeled', 'ac/status:todo', alice),
        ...labels.map((label, i) => ({ id: i + 2, event: 'labeled' as const, label: { name: label }, actor: alice }))
      )
      vi.mocked(f.deps.cards.resolveAgentSlug).mockResolvedValue(null)
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

// Vera's probes, as regression tests: each fails on fd92d2e19 and passes after the per-label attribution fix.
describe('lagging-event attribution regression', () => {
  const bob = { type: 'User', login: 'bob' }
  const mallory = { type: 'User', login: 'mallory' }
  const perms: Record<string, RepoPermissionLevel> = { bob: 'write', mallory: 'triage' }
  const permissions = vi.fn(async (_r: unknown, login: string) => perms[login.toLowerCase()] ?? 'none')

  it('a: does not adopt a non-writer ready edit hidden behind a writer visible edit, then reverts on reveal', async () => {
    const f = fixture({ status: 'todo', syncEventCursor: 51n })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/status:ready']
    f.events.splice(
      0,
      f.events.length,
      labelEvent(50, 'labeled', 'ac/status:ready', mallory),
      labelEvent(51, 'unlabeled', 'ac/status:ready', app),
      labelEvent(101, 'labeled', 'ac/status:blocked', bob),
      labelEvent(102, 'unlabeled', 'ac/status:todo', bob)
    )
    await f.sync.onCardChanged('board', 1, true)
    expect(f.card().status).toBe('todo')
    expect(f.deps.repo.apply).not.toHaveBeenCalled()
    expect(f.deps.repo.defer).toHaveBeenCalled()
    // Reveal mallory's swap: the pass now attributes the live ready to a non-writer and reverts.
    f.events.push(
      labelEvent(103, 'unlabeled', 'ac/status:blocked', mallory),
      labelEvent(104, 'labeled', 'ac/status:ready', mallory)
    )
    await f.sync.reconcileBoard('board')
    expect(f.card().status).toBe('todo')
    expect(vi.mocked(f.deps.store.applyPlan).mock.calls.at(-1)![3]).toMatchObject({
      removeLabels: ['ac/status:ready'],
      comment: expect.stringContaining('only collaborators with write access')
    })
    expect(vi.mocked(f.deps.permissions.permission)).toHaveBeenCalledWith(target, 'mallory')
  })

  it('b: the drift reconciler tick hits the same defer-then-revert path (no webhook sender)', async () => {
    const f = fixture({ status: 'todo', syncEventCursor: 51n })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/status:ready']
    f.events.splice(
      0,
      f.events.length,
      labelEvent(50, 'labeled', 'ac/status:ready', mallory),
      labelEvent(51, 'unlabeled', 'ac/status:ready', app),
      labelEvent(101, 'labeled', 'ac/status:blocked', bob),
      labelEvent(102, 'unlabeled', 'ac/status:todo', bob)
    )
    await f.sync.reconcileBoard('board')
    expect(f.card().status).toBe('todo')
    expect(f.deps.repo.apply).not.toHaveBeenCalled()
  })

  it('c: writer lag is not lost — a doorbell before its event is visible defers, then adopts once visible', async () => {
    const f = fixture({ status: 'todo', syncEventCursor: 40n })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/status:ready']
    f.events.splice(0, f.events.length, labelEvent(40, 'labeled', 'ac/status:todo', bob))
    await f.sync.onCardChanged('board', 1, true)
    expect(f.card().status).toBe('todo')
    expect(f.deps.repo.defer).toHaveBeenCalled()
    expect(f.deps.store.applyPlan).not.toHaveBeenCalled()
    // Bob's events become visible; the writer's edit is now adopted, not lost.
    f.events.push(labelEvent(60, 'labeled', 'ac/status:ready', bob), labelEvent(61, 'unlabeled', 'ac/status:todo', bob))
    await f.sync.onCardChanged('board', 1, true)
    expect(f.card().status).toBe('ready')
  })

  it('d: projectStatus runs a full reconcile so an unprocessed ac/agent edit is applied, not swallowed', async () => {
    const f = fixture({ status: 'running', labelWritePending: true, syncEventCursor: 10n, syncAgentCursor: 10n })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/status:running', 'ac/agent:new']
    f.events.splice(
      0,
      f.events.length,
      labelEvent(10, 'labeled', 'ac/status:running', bob),
      labelEvent(20, 'labeled', 'ac/agent:new', bob)
    )
    const setAssignee = vi.mocked(f.deps.cards.setAssignee)
    setAssignee.mockImplementation(async ({ agentId }) => {
      const changed = f.card().assigneeAgentId !== agentId
      const prev = f.card().assigneeAgentId
      if (changed) {
        f.card().assigneeAgentId = agentId
        f.card().dispatchRevision = f.card().dispatchRevision + 1n
      }
      return { ok: true as const, changed, card: {} as never, previousAgentId: prev, revokedLease: null }
    })
    await f.sync.projectStatus('board', 1, 'running')
    await f.sync.onCardChanged('board', 1, true)
    expect(setAssignee).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'next-agent' }))
    expect(f.card().syncAgentCursor).toBe(20n)
  })

  it('e: after a reassignment sync re-reads before writing labels instead of applying a stale snapshot', async () => {
    const f = fixture({
      status: 'running',
      lease: { leaseId: 'lease', runId: 'run', agentId: 'worker', daemonId: 'daemon', dispatchRevision: 1n }
    })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/status:running', 'ac/agent:new']
    f.events.splice(
      0,
      f.events.length,
      labelEvent(10, 'labeled', 'ac/status:running', bob),
      labelEvent(20, 'labeled', 'ac/agent:new', bob)
    )
    const setAssignee = vi.mocked(f.deps.cards.setAssignee)
    setAssignee.mockImplementation(async ({ agentId }) => {
      const changed = f.card().assigneeAgentId !== agentId
      const prev = f.card().assigneeAgentId
      if (changed) {
        f.card().assigneeAgentId = agentId
        f.card().dispatchRevision = f.card().dispatchRevision + 1n
      }
      return { ok: true as const, changed, card: {} as never, previousAgentId: prev, revokedLease: null }
    })
    const readsBefore = vi.mocked(f.deps.store.readCard).mock.calls.length
    await f.sync.onCardChanged('board', 1, true)
    // The reassignment re-reads the card and the issue before planning any label write.
    expect(vi.mocked(f.deps.store.readCard).mock.calls.length).toBeGreaterThan(readsBefore)
    expect(f.card().assigneeAgentId).toBe('next-agent')
  })
})

// A non-writer re-authoring a card's current status label must revert it: the label the card relies on is no longer
// a live writer's, so the card is pushed to triage, its lease is revoked, and nothing is left to dispatch.
describe('non-writer re-add of the current status label', () => {
  const bob = { type: 'User', login: 'bob' }
  const mallory = { type: 'User', login: 'mallory' }
  const perms: Record<string, RepoPermissionLevel> = { bob: 'write', mallory: 'triage' }
  const permissions = vi.fn(async (_r: unknown, login: string) => perms[login.toLowerCase()] ?? 'none')

  it('reverts a ready card to triage when a non-writer remove+re-adds the label', async () => {
    const f = fixture({ status: 'ready', syncEventCursor: 100n })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/status:ready']
    f.events.splice(
      0,
      f.events.length,
      labelEvent(100, 'labeled', 'ac/status:ready', bob),
      labelEvent(101, 'unlabeled', 'ac/status:ready', mallory),
      labelEvent(102, 'labeled', 'ac/status:ready', mallory)
    )
    await f.sync.onCardChanged('board', 1, true)
    expect(f.card().status).toBe('triage')
    expect(vi.mocked(f.deps.permissions.permission)).toHaveBeenCalledWith(target, 'mallory')
    expect(vi.mocked(f.deps.store.applyPlan).mock.calls.at(-1)![3]).toMatchObject({
      status: 'triage',
      addLabels: ['ac/status:triage'],
      removeLabels: ['ac/status:ready'],
      comment: expect.stringContaining('only collaborators with write access')
    })
  })

  it('revokes the lease when a non-writer re-adds a running card', async () => {
    const f = fixture({
      status: 'running',
      syncEventCursor: 100n,
      lease: { leaseId: 'lease', runId: 'run', agentId: 'worker', daemonId: 'daemon', dispatchRevision: 1n }
    })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/status:running']
    f.events.splice(
      0,
      f.events.length,
      labelEvent(100, 'labeled', 'ac/status:running', bob),
      labelEvent(101, 'unlabeled', 'ac/status:running', mallory),
      labelEvent(102, 'labeled', 'ac/status:running', mallory)
    )
    await f.sync.onCardChanged('board', 1, true)
    expect(f.card().status).toBe('triage')
    expect(f.deps.revoke).toHaveBeenCalledWith(expect.objectContaining({ leaseId: 'lease' }), 'card')
    expect(vi.mocked(f.deps.store.applyPlan).mock.calls.at(-1)![3]).toMatchObject({
      addLabels: ['ac/status:triage'],
      removeLabels: ['ac/status:running']
    })
  })

  it('leaves a non-dispatchable card alone when a non-writer re-adds its label', async () => {
    const f = fixture({ status: 'done', syncEventCursor: 100n })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/status:done']
    f.events.splice(
      0,
      f.events.length,
      labelEvent(100, 'labeled', 'ac/status:done', bob),
      labelEvent(101, 'unlabeled', 'ac/status:done', mallory),
      labelEvent(102, 'labeled', 'ac/status:done', mallory)
    )
    await f.sync.onCardChanged('board', 1, true)
    expect(f.card().status).toBe('done')
    expect(f.deps.revoke).not.toHaveBeenCalled()
    expect(vi.mocked(f.deps.store.applyPlan).mock.calls.at(-1)![3]).not.toMatchObject({ status: 'triage' })
  })
})

// The webhook names the sender of a `labeled` edit the events API does not show yet; the visible history alone would
// still attribute the live label to the writer's older add.
describe('labeled doorbell sender against an invisible remove+re-add', () => {
  const bob = { type: 'User', login: 'bob', id: 1 }
  const mallory = { type: 'User', login: 'mallory', id: 7 }
  const perms: Record<string, RepoPermissionLevel> = { bob: 'write', carol: 'write', mallory: 'triage' }
  const permissions = vi.fn(async (_r: unknown, login: string) => perms[login.toLowerCase()] ?? 'none')
  const lease = { leaseId: 'lease', runId: 'run', agentId: 'worker', daemonId: 'daemon', dispatchRevision: 1n }
  const doorbell = (login: string, id: number, label = 'ac/status:ready') => ({
    action: 'labeled',
    sender: { login, id, type: 'User' },
    label
  })

  function invisible(status: 'ready' | 'running' | 'done', overrides: Partial<SyncCard> = {}) {
    const f = fixture({ status, syncEventCursor: 100n, syncAgentCursor: 99n, ...overrides })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = [`ac/status:${status}`, 'ac/agent:worker']
    f.events.splice(
      0,
      f.events.length,
      labelEvent(99, 'labeled', 'ac/agent:worker', bob),
      labelEvent(100, 'labeled', `ac/status:${status}`, bob)
    )
    return f
  }

  it('reverts a ready card to triage with a refusal comment and audits the sender', async () => {
    const f = invisible('ready')
    await f.sync.onCardChanged('board', 1, true, doorbell('mallory', 7))
    expect(f.card().status).toBe('triage')
    expect(vi.mocked(f.deps.repo.apply).mock.calls[0]![5]).toEqual({ login: 'mallory', id: 7 })
    expect(vi.mocked(f.deps.store.applyPlan).mock.calls.at(-1)![3]).toMatchObject({
      status: 'triage',
      addLabels: ['ac/status:triage'],
      removeLabels: ['ac/status:ready'],
      comment: expect.stringContaining('only collaborators with write access')
    })
    expect(f.deps.repo.defer).not.toHaveBeenCalled()
  })

  it('revokes the lease of a running card', async () => {
    const f = invisible('running', { lease })
    await f.sync.onCardChanged('board', 1, true, doorbell('mallory', 7, 'ac/status:running'))
    expect(f.card().status).toBe('triage')
    expect(f.deps.revoke).toHaveBeenCalledWith(expect.objectContaining({ leaseId: 'lease' }), 'card')
  })

  it('refuses even when only the removal is visible (no lag deferral leaves the card claimable)', async () => {
    const f = invisible('ready')
    f.events.push(labelEvent(101, 'unlabeled', 'ac/status:ready', mallory))
    await f.sync.onCardChanged('board', 1, true, doorbell('mallory', 7))
    expect(f.card().status).toBe('triage')
    expect(f.deps.repo.defer).not.toHaveBeenCalled()
  })

  it("defers a live writer's invisible re-add instead of adopting or reverting", async () => {
    const f = invisible('ready')
    await f.sync.onCardChanged('board', 1, true, doorbell('carol', 3))
    expect(f.card()).toMatchObject({ status: 'ready', syncDeferralCount: 1 })
    expect(f.deps.repo.apply).not.toHaveBeenCalled()
    expect(f.deps.store.applyPlan).not.toHaveBeenCalled()
  })

  it("defers a non-writer's invisible re-add of an ac/agent label or a non-dispatchable status label", async () => {
    const agent = invisible('ready')
    await agent.sync.onCardChanged('board', 1, true, doorbell('mallory', 7, 'ac/agent:worker'))
    expect(agent.card()).toMatchObject({ status: 'ready', syncDeferralCount: 1 })
    const done = invisible('done')
    await done.sync.onCardChanged('board', 1, true, doorbell('mallory', 7, 'ac/status:done'))
    expect(done.card()).toMatchObject({ status: 'done', syncDeferralCount: 1 })
    expect(done.deps.revoke).not.toHaveBeenCalled()
  })

  it("takes the normal path once the sender's add is the latest visible event, or the label is gone", async () => {
    const visible = invisible('ready')
    visible.events.push(
      labelEvent(101, 'unlabeled', 'ac/status:ready', { type: 'User', login: 'carol', id: 3 }),
      labelEvent(102, 'labeled', 'ac/status:ready', { type: 'User', login: 'carol', id: 3 })
    )
    await visible.sync.onCardChanged('board', 1, true, doorbell('carol', 3))
    expect(visible.card()).toMatchObject({ status: 'ready', syncDeferralCount: 0, syncEventCursor: 102n })
    const gone = invisible('ready')
    await gone.sync.onCardChanged('board', 1, true, doorbell('mallory', 7, 'ac/status:blocked'))
    expect(gone.card()).toMatchObject({ status: 'ready', syncDeferralCount: 0 })
  })
})

// Vera round 2 (review 5559523967): each case reproduces an attack against 5d610cb1e and failed there.
describe('vera-r2: attribution holes', () => {
  const bob = { type: 'User', login: 'bob', id: 1 }
  const mallory = { type: 'User', login: 'mallory', id: 7 }
  const perms: Record<string, RepoPermissionLevel> = { bob: 'write', mallory: 'triage' }
  const permissions = vi.fn(async (_r: unknown, login: string) => perms[login.toLowerCase()] ?? 'none')
  const lease = { leaseId: 'lease', runId: 'run', agentId: 'worker', daemonId: 'daemon', dispatchRevision: 1n }
  const lookedUp = (f: ReturnType<typeof fixture>, login: string) =>
    vi.mocked(f.deps.permissions.permission).mock.calls.some(([, l]) => l === login)

  it("vera-r2: 1a a writer's reopen does not adopt a triage user's ready label", async () => {
    const f = fixture({ status: 'done', syncEventCursor: 100n })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/status:ready']
    f.events.splice(
      0,
      f.events.length,
      stateEvent(99, 'closed', bob),
      labelEvent(100, 'labeled', 'ac/status:done', bob),
      labelEvent(101, 'unlabeled', 'ac/status:done', mallory),
      labelEvent(102, 'labeled', 'ac/status:ready', mallory),
      stateEvent(103, 'reopened', bob)
    )
    await f.sync.onCardChanged('board', 1, true)
    expect(f.card().status).not.toBe('ready')
    expect(lookedUp(f, 'mallory')).toBe(true)
    // Mallory's label is refused on its own add: reverted with the refusal comment, and the audit names her.
    expect(vi.mocked(f.deps.repo.apply).mock.calls.at(-1)![5]).toEqual({ login: 'mallory', id: 7 })
    expect(vi.mocked(f.deps.store.applyPlan).mock.calls.at(-1)![3]).toMatchObject({
      removeLabels: ['ac/status:ready'],
      comment: expect.stringContaining('only collaborators with write access')
    })
  })

  it("vera-r2: 1a a writer's reopen adopts a writer's own live status label", async () => {
    const f = fixture({ status: 'done', syncEventCursor: 100n })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/status:ready']
    f.events.splice(
      0,
      f.events.length,
      stateEvent(99, 'closed', bob),
      labelEvent(100, 'labeled', 'ac/status:done', bob),
      labelEvent(101, 'unlabeled', 'ac/status:done', bob),
      labelEvent(102, 'labeled', 'ac/status:ready', bob),
      stateEvent(103, 'reopened', bob)
    )
    await f.sync.onCardChanged('board', 1, true)
    expect(f.card()).toMatchObject({ status: 'ready', syncEventCursor: 103n })
  })

  it("vera-r2: 1a a writer's reopen never adopts a live label a non-writer added before the cursor", async () => {
    const f = fixture({ status: 'done', syncEventCursor: 100n })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/status:ready', 'ac/agent:x']
    f.events.splice(
      0,
      f.events.length,
      labelEvent(98, 'labeled', 'ac/status:ready', mallory),
      labelEvent(99, 'labeled', 'ac/agent:x', bob),
      stateEvent(103, 'reopened', bob)
    )
    // The reopen judges the label it would adopt even below the cursor: mallory's add is refused, not adopted on bob's reopen.
    await f.sync.onCardChanged('board', 1, true)
    expect(f.card().status).toBe('done')
    expect(lookedUp(f, 'mallory')).toBe(true)
  })

  it('vera-r2: 1b the re-read after a reassignment re-judges a status swap made meanwhile', async () => {
    const f = fixture({ status: 'todo', syncEventCursor: 10n, syncAgentCursor: 10n })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/status:blocked', 'ac/agent:new']
    f.events.splice(
      0,
      f.events.length,
      labelEvent(10, 'labeled', 'ac/status:todo', bob),
      labelEvent(20, 'unlabeled', 'ac/status:todo', bob),
      labelEvent(21, 'labeled', 'ac/status:blocked', bob),
      labelEvent(22, 'labeled', 'ac/agent:new', bob)
    )
    vi.mocked(f.deps.cards.setAssignee).mockImplementation(async ({ agentId }) => {
      const prev = f.card().assigneeAgentId
      f.card().assigneeAgentId = agentId
      f.card().dispatchRevision = f.card().dispatchRevision + 1n
      // While setAssignee runs, mallory swaps blocked → ready; the swap is already visible to the re-read.
      f.issue.labels = ['ac/status:ready', 'ac/agent:new']
      f.events.push(
        labelEvent(30, 'unlabeled', 'ac/status:blocked', mallory),
        labelEvent(31, 'labeled', 'ac/status:ready', mallory)
      )
      return { ok: true as const, changed: true, card: {} as never, previousAgentId: prev, revokedLease: null }
    })
    await f.sync.onCardChanged('board', 1, true)
    await f.sync.onCardChanged('board', 1, true)
    expect(f.card().status).not.toBe('ready')
    expect(lookedUp(f, 'mallory')).toBe(true)
  })

  it('vera-r2: 1b the re-read never acks a newer ac/agent edit it did not judge', async () => {
    const f = fixture({ status: 'todo', syncEventCursor: 10n, syncAgentCursor: 10n })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/status:todo', 'ac/agent:new']
    f.events.splice(
      0,
      f.events.length,
      labelEvent(10, 'labeled', 'ac/status:todo', bob),
      labelEvent(22, 'labeled', 'ac/agent:new', bob)
    )
    let first = true
    vi.mocked(f.deps.cards.setAssignee).mockImplementation(async ({ agentId }) => {
      const prev = f.card().assigneeAgentId
      f.card().assigneeAgentId = agentId
      if (first) {
        first = false
        // Mallory swaps the agent label while the first reassignment runs.
        f.issue.labels = ['ac/status:todo', 'ac/agent:other']
        f.events.push(
          labelEvent(30, 'unlabeled', 'ac/agent:new', mallory),
          labelEvent(31, 'labeled', 'ac/agent:other', mallory)
        )
      }
      return { ok: true as const, changed: true, card: {} as never, previousAgentId: prev, revokedLease: null }
    })
    await f.sync.onCardChanged('board', 1, true)
    // Either the cursor stops before mallory's edit, or mallory's edit was judged (and refused).
    expect(f.card().syncAgentCursor <= 22n || lookedUp(f, 'mallory')).toBe(true)
  })

  it("vera-r2: 2 projectStatus defers a writer's edit made while the CP label write is pending", async () => {
    const f = fixture({ status: 'review', labelWritePending: true, syncEventCursor: 10n })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/status:ready']
    f.events.splice(
      0,
      f.events.length,
      labelEvent(10, 'labeled', 'ac/status:running', bob),
      labelEvent(20, 'unlabeled', 'ac/status:running', bob),
      labelEvent(21, 'labeled', 'ac/status:ready', bob)
    )
    await f.sync.projectStatus('board', 1, 'review')
    // Not overwritten, not acked: the cursor stays and no write forces `review` over bob's `ready`.
    expect(f.card().syncEventCursor).toBe(10n)
    for (const call of vi.mocked(f.deps.store.applyPlan).mock.calls) {
      expect(call[3].removeLabels).not.toContain('ac/status:ready')
    }
    // The writer's doorbell then adopts the edit.
    await f.sync.onCardChanged('board', 1, true)
    expect(f.card().status).toBe('ready')
  })

  it("vera-r2: 4 a stale non-writer doorbell does not undo a writer's newer remove+re-add", async () => {
    const f = fixture({ status: 'running', syncEventCursor: 104n, lease })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/status:running']
    const at = (minute: number) => `2026-10-17T00:0${minute}:00Z`
    f.events.splice(
      0,
      f.events.length,
      { ...labelEvent(100, 'labeled', 'ac/status:running', bob), created_at: at(0) },
      { ...labelEvent(101, 'unlabeled', 'ac/status:running', mallory), created_at: at(1) },
      { ...labelEvent(102, 'labeled', 'ac/status:running', mallory), created_at: at(1) },
      { ...labelEvent(103, 'unlabeled', 'ac/status:running', bob), created_at: at(2) },
      { ...labelEvent(104, 'labeled', 'ac/status:running', bob), created_at: at(2) }
    )
    // Mallory's doorbell, late or redelivered, carries her edit's time; bob's re-add is visibly newer.
    await f.sync.onCardChanged('board', 1, true, {
      action: 'labeled',
      sender: { login: 'mallory', id: 7, type: 'User' },
      label: 'ac/status:running',
      at: '2026-10-17T00:01:00.000Z'
    })
    expect(f.card().status).toBe('running')
    expect(f.deps.revoke).not.toHaveBeenCalled()
  })

  it('vera-r2: 4 a non-writer doorbell newer than every visible event is still refused', async () => {
    const f = fixture({ status: 'running', syncEventCursor: 104n, lease })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/status:running']
    f.events.splice(
      0,
      f.events.length,
      { ...labelEvent(102, 'labeled', 'ac/status:running', mallory), created_at: '2026-10-17T00:01:00Z' },
      { ...labelEvent(103, 'unlabeled', 'ac/status:running', bob), created_at: '2026-10-17T00:02:00Z' },
      { ...labelEvent(104, 'labeled', 'ac/status:running', bob), created_at: '2026-10-17T00:02:00Z' }
    )
    // Mallory's invisible remove+re-add after bob's: her older visible add must not make this doorbell look stale.
    for (const stamp of ['2026-10-17T00:03:00.000Z', '2026-10-17T00:02:04.000Z', undefined]) {
      const g = fixture({ status: 'running', syncEventCursor: 104n, lease })
      vi.mocked(g.deps.permissions.permission).mockImplementation(permissions)
      g.issue.labels = f.issue.labels
      g.events.splice(0, g.events.length, ...f.events)
      await g.sync.onCardChanged('board', 1, true, {
        action: 'labeled',
        sender: { login: 'mallory', id: 7, type: 'User' },
        label: 'ac/status:running',
        ...(stamp ? { at: stamp } : {})
      })
      expect(g.card().status).toBe('triage')
      expect(g.deps.revoke).toHaveBeenCalledWith(expect.objectContaining({ leaseId: 'lease' }), 'card')
    }
  })

  it('does not ack an unrelated assignee edit while refusing an invisible doorbell add', async () => {
    const f = fixture({ status: 'ready', syncEventCursor: 10n, syncAgentCursor: 10n })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/status:ready', 'ac/agent:new']
    f.events.splice(
      0,
      f.events.length,
      labelEvent(10, 'labeled', 'ac/status:ready', bob),
      labelEvent(20, 'labeled', 'ac/agent:new', bob),
      stateEvent(21, 'closed', bob)
    )
    await f.sync.onCardChanged('board', 1, true, {
      action: 'labeled',
      sender: { login: 'mallory', id: 7, type: 'User' },
      label: 'ac/status:ready'
    })
    expect(f.card().status).toBe('triage')
    expect(f.card().syncEventCursor).toBe(10n)
    expect(f.card().syncAgentCursor).toBe(10n)
    expect(f.deps.cards.setAssignee).not.toHaveBeenCalled()
    expect(f.deps.permissions.permission).not.toHaveBeenCalledWith(expect.anything(), 'bob')
    f.issue.labels = ['ac/status:triage', 'ac/agent:new']
    f.events.push(
      labelEvent(22, 'unlabeled', 'ac/status:ready', app),
      labelEvent(23, 'labeled', 'ac/status:triage', app)
    )
    await f.sync.onCardChanged('board', 1, true)
    expect(f.deps.cards.setAssignee).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'next-agent' }))
  })

  it('a superseded non-writer doorbell still refuses the newer non-writer label add', async () => {
    const f = fixture({ status: 'running', syncEventCursor: 10n, lease })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/status:running']
    f.events.splice(
      0,
      f.events.length,
      labelEvent(10, 'labeled', 'ac/status:running', bob),
      { ...labelEvent(20, 'unlabeled', 'ac/status:running', mallory), created_at: '2026-10-17T00:02:00Z' },
      {
        ...labelEvent(21, 'labeled', 'ac/status:running', mallory),
        actor: { type: 'User', login: 'eve', id: 8 },
        created_at: '2026-10-17T00:02:00Z'
      }
    )
    await f.sync.onCardChanged('board', 1, true, {
      action: 'labeled',
      sender: { login: 'mallory', id: 7, type: 'User' },
      label: 'ac/status:running',
      at: '2026-10-17T00:01:00Z'
    })
    expect(lookedUp(f, 'eve')).toBe(true)
    expect(f.card().status).toBe('triage')
    expect(f.deps.revoke).toHaveBeenCalledWith(lease, 'card')
  })

  it('a revoking reassignment consumes only its original snapshot, not a newer writer status edit', async () => {
    const f = fixture({ status: 'running', syncEventCursor: 10n, syncAgentCursor: 10n, lease })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/status:running', 'ac/agent:new']
    f.events.splice(
      0,
      f.events.length,
      labelEvent(10, 'labeled', 'ac/status:running', bob),
      labelEvent(20, 'labeled', 'ac/agent:new', bob)
    )
    vi.mocked(f.deps.cards.setAssignee).mockImplementation(async ({ agentId }) => {
      const previousAgentId = f.card().assigneeAgentId
      Object.assign(f.card(), {
        status: 'ready',
        assigneeAgentId: agentId,
        lease: null,
        stateRevision: 2n,
        dispatchRevision: 2n
      })
      f.issue.labels = ['ac/status:blocked', 'ac/agent:new']
      f.events.push(
        labelEvent(30, 'unlabeled', 'ac/status:running', bob),
        labelEvent(31, 'labeled', 'ac/status:blocked', bob)
      )
      return {
        ok: true as const,
        changed: true,
        card: { status: 'ready' } as never,
        previousAgentId,
        revokedLease: lease
      }
    })
    await f.sync.onCardChanged('board', 1, true)
    expect(f.card()).toMatchObject({ status: 'blocked', syncEventCursor: 31n })
    expect(f.deps.revoke).toHaveBeenCalledOnce()
  })

  it('vera-r2: 5 the deferral bound fails closed to triage, not the kept dispatchable status', async () => {
    const start = new Date('2026-10-17T00:00:00Z')
    const f = fixture({ status: 'ready', syncEventCursor: 40n, syncDeferredAt: start, syncDeferralCount: 3 })
    f.deps.now = () => new Date(start.getTime() + 11 * 60_000)
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/status:blocked']
    f.events.splice(0, f.events.length, labelEvent(40, 'labeled', 'ac/status:ready', bob))
    await f.sync.onCardChanged('board', 1, true)
    expect(f.deps.repo.failClosed).toHaveBeenCalled()
    expect(f.card()).toMatchObject({ status: 'triage', needsAttention: true })
    expect(vi.mocked(f.deps.store.applyPlan).mock.calls.at(-1)![3]).toMatchObject({
      status: 'triage',
      addLabels: ['ac/status:triage'],
      removeLabels: ['ac/status:blocked'],
      comment: expect.stringContaining('held for a human at `ac/status:triage`')
    })
  })

  it('vera-r2: 6 the fail-closed comment is posted once, not again on later doorbells', async () => {
    const start = new Date('2026-10-17T00:00:00Z')
    let now = new Date(start.getTime() + 11 * 60_000)
    const f = fixture({ status: 'blocked', syncEventCursor: 40n, syncDeferredAt: start, syncDeferralCount: 3 })
    f.deps.now = () => now
    vi.mocked(f.deps.repo.failClosed).mockImplementation(async (c) => {
      Object.assign(f.card(), { needsAttention: true, syncDeferredAt: null, syncDeferralCount: 0 })
      return { status: c.status, revoked: null }
    })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/status:todo']
    f.events.splice(0, f.events.length, labelEvent(40, 'labeled', 'ac/status:blocked', bob))
    await f.sync.onCardChanged('board', 1, true)
    now = new Date(now.getTime() + 11 * 60_000)
    await f.sync.onCardChanged('board', 1, true)
    now = new Date(now.getTime() + 11 * 60_000)
    await f.sync.onCardChanged('board', 1, true)
    const comments = vi.mocked(f.deps.store.applyPlan).mock.calls.filter(([, , , plan]) => !!plan.comment)
    expect(comments).toHaveLength(1)
  })

  it('vera-r2: 7 an event history past the page bound defers and escalates instead of throwing every pass', async () => {
    const start = new Date('2026-10-17T00:00:00Z')
    let now = start
    const f = fixture({ status: 'ready', syncEventCursor: 40n })
    f.deps.now = () => now
    vi.mocked(f.deps.store.readLabelEvents).mockRejectedValue(new KanbanEventHistoryBoundError())
    await f.sync.onCardChanged('board', 1, true).catch(() => {})
    expect(f.deps.repo.defer).toHaveBeenCalled()
    now = new Date(start.getTime() + 11 * 60_000)
    await f.sync.onCardChanged('board', 1, true).catch(() => {})
    expect(f.deps.repo.failClosed).toHaveBeenCalled()
    expect(f.card()).toMatchObject({ status: 'triage', needsAttention: true })
  })
})

// Vera round 3 (vera-194-r3-review 🔴1): a revoking reassignment must not silently drop a writer's
// status change made in the SAME snapshot. Each case failed on 24ebb8670 (card ended `ready`, cursor 22).
describe('vera-r3: same-snapshot writer status survives a revoking reassignment', () => {
  const bob = { type: 'User', login: 'bob', id: 1 }
  const mallory = { type: 'User', login: 'mallory', id: 7 }
  const perms: Record<string, RepoPermissionLevel> = { bob: 'write', mallory: 'triage' }
  const permissions = vi.fn(async (_r: unknown, login: string) => perms[login.toLowerCase()] ?? 'none')
  const lease = { leaseId: 'lease', runId: 'run', agentId: 'worker', daemonId: 'daemon', dispatchRevision: 1n }
  const lookedUp = (f: ReturnType<typeof fixture>, login: string) =>
    vi.mocked(f.deps.permissions.permission).mock.calls.some(([, l]) => l === login)

  it.each(['blocked', 'triage', 'archived'] as const)(
    'vera-r3: same-edit writer %s is adopted with cursor 22, lease revoked once, no ready projection',
    async (status) => {
      const f = fixture({ status: 'running', syncEventCursor: 10n, syncAgentCursor: 10n, lease })
      vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
      f.issue.labels = ['ac/agent:new', `ac/status:${status}`]
      f.events.splice(
        0,
        f.events.length,
        labelEvent(10, 'labeled', 'ac/status:running', bob),
        labelEvent(20, 'labeled', 'ac/agent:new', bob),
        labelEvent(21, 'unlabeled', 'ac/status:running', bob),
        labelEvent(22, 'labeled', `ac/status:${status}`, bob)
      )
      vi.mocked(f.deps.cards.setAssignee).mockImplementation(async ({ agentId }) => {
        const previousAgentId = f.card().assigneeAgentId
        Object.assign(f.card(), {
          status: 'ready',
          assigneeAgentId: agentId,
          lease: null,
          stateRevision: 2n,
          dispatchRevision: 2n
        })
        return {
          ok: true as const,
          changed: true,
          card: { status: 'ready' } as never,
          previousAgentId,
          revokedLease: lease
        }
      })
      await f.sync.onCardChanged('board', 1, true)
      expect(f.card()).toMatchObject({ status, syncEventCursor: 22n, lease: null })
      expect(f.card().status).not.toBe('ready')
      expect(f.deps.revoke).toHaveBeenCalledOnce()
      expect(f.deps.revoke).toHaveBeenCalledWith(expect.objectContaining({ leaseId: 'lease' }), 'card')
      expect(f.deps.cards.setAssignee).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'next-agent' }))
      for (const call of vi.mocked(f.deps.store.applyPlan).mock.calls) {
        expect(call[3].addLabels).not.toContain('ac/status:ready')
        expect(call[3].removeLabels).not.toContain(`ac/status:${status}`)
      }
      expect(vi.mocked(f.deps.repo.apply).mock.calls.at(-1)![5]).toEqual({ login: 'bob', id: 1 })
      expect(lookedUp(f, 'bob')).toBe(true)
    }
  )

  it('vera-r3: same-snapshot non-writer blocked is refused, never adopted', async () => {
    const f = fixture({ status: 'running', syncEventCursor: 10n, syncAgentCursor: 10n, lease })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/agent:new', 'ac/status:blocked']
    f.events.splice(
      0,
      f.events.length,
      labelEvent(10, 'labeled', 'ac/status:running', bob),
      labelEvent(20, 'labeled', 'ac/agent:new', bob),
      labelEvent(21, 'unlabeled', 'ac/status:running', mallory),
      labelEvent(22, 'labeled', 'ac/status:blocked', mallory)
    )
    vi.mocked(f.deps.cards.setAssignee).mockImplementation(async ({ agentId }) => {
      const previousAgentId = f.card().assigneeAgentId
      Object.assign(f.card(), {
        status: 'ready',
        assigneeAgentId: agentId,
        lease: null,
        stateRevision: 2n,
        dispatchRevision: 2n
      })
      return {
        ok: true as const,
        changed: true,
        card: { status: 'ready' } as never,
        previousAgentId,
        revokedLease: lease
      }
    })
    await f.sync.onCardChanged('board', 1, true)
    expect(f.card().status).not.toBe('blocked')
    expect(f.card()).toMatchObject({ status: 'ready', syncEventCursor: 22n })
    expect(f.deps.revoke).toHaveBeenCalledOnce()
    expect(lookedUp(f, 'mallory')).toBe(true)
    expect(vi.mocked(f.deps.repo.apply).mock.calls.at(-1)![5]).toEqual({ login: 'mallory', id: 7 })
    expect(vi.mocked(f.deps.store.applyPlan).mock.calls.at(-1)![3]).toMatchObject({
      removeLabels: ['ac/status:blocked'],
      comment: expect.stringContaining('only collaborators with write access')
    })
  })
})

// Vera round 3 re-run pin (vera-194-r3-review 🟢): the swap made during setAssignee must be judged
// inside the SAME onCardChanged call. Removing the post-reassignment re-run leaves it unjudged.
describe('vera-r3: 1b re-run pin', () => {
  const bob = { type: 'User', login: 'bob' }
  const mallory = { type: 'User', login: 'mallory' }
  const perms: Record<string, RepoPermissionLevel> = { bob: 'write', mallory: 'triage' }
  const permissions = vi.fn(async (_r: unknown, login: string) => perms[login.toLowerCase()] ?? 'none')
  const lookedUp = (f: ReturnType<typeof fixture>, login: string) =>
    vi.mocked(f.deps.permissions.permission).mock.calls.some(([, l]) => l === login)

  it('vera-r3: 1b re-run judges a status swap made during setAssignee in the same reconcile', async () => {
    const f = fixture({ status: 'todo', syncEventCursor: 10n, syncAgentCursor: 10n })
    vi.mocked(f.deps.permissions.permission).mockImplementation(permissions)
    f.issue.labels = ['ac/status:blocked', 'ac/agent:new']
    f.events.splice(
      0,
      f.events.length,
      labelEvent(10, 'labeled', 'ac/status:todo', bob),
      labelEvent(20, 'unlabeled', 'ac/status:todo', bob),
      labelEvent(21, 'labeled', 'ac/status:blocked', bob),
      labelEvent(22, 'labeled', 'ac/agent:new', bob)
    )
    vi.mocked(f.deps.cards.setAssignee).mockImplementation(async ({ agentId }) => {
      const prev = f.card().assigneeAgentId
      f.card().assigneeAgentId = agentId
      f.card().dispatchRevision = f.card().dispatchRevision + 1n
      f.issue.labels = ['ac/status:ready', 'ac/agent:new']
      f.events.push(
        labelEvent(30, 'unlabeled', 'ac/status:blocked', mallory),
        labelEvent(31, 'labeled', 'ac/status:ready', mallory)
      )
      return { ok: true as const, changed: true, card: {} as never, previousAgentId: prev, revokedLease: null }
    })
    const readsBefore = vi.mocked(f.deps.store.readCard).mock.calls.length
    await f.sync.onCardChanged('board', 1, true)
    expect(f.card().status).not.toBe('ready')
    expect(lookedUp(f, 'mallory')).toBe(true)
    expect(f.card().syncEventCursor).toBe(31n)
    expect(vi.mocked(f.deps.store.readCard).mock.calls.length).toBeGreaterThan(readsBefore + 1)
    expect(vi.mocked(f.deps.store.applyPlan).mock.calls.at(-1)![3]).toMatchObject({
      removeLabels: expect.arrayContaining(['ac/status:ready']),
      comment: expect.stringContaining('only collaborators with write access')
    })
  })
})

// A close event must survive the same reassignment restart as a status-label edit.
describe('vera-r4: same-snapshot close survives reassignment', () => {
  const bob = { type: 'User', login: 'bob', id: 1 }
  const lease = { leaseId: 'lease', runId: 'run', agentId: 'worker', daemonId: 'daemon', dispatchRevision: 1n }

  it.each(
    (['not_planned', 'completed'] as const).flatMap((reason) =>
      (['agent-then-close', 'close-then-agent'] as const).map((order) => ({ reason, order }))
    )
  )('vera-r4: reassign + close $reason ($order)', async ({ reason, order }) => {
    const f = fixture({ status: 'running', syncEventCursor: 10n, syncAgentCursor: 10n, lease })
    f.issue.state = 'closed'
    f.issue.stateReason = reason
    f.issue.labels = ['ac/agent:new', 'ac/status:running']
    const agentFirst = order === 'agent-then-close'
    f.events.splice(
      0,
      f.events.length,
      labelEvent(10, 'labeled', 'ac/status:running', bob),
      ...(agentFirst
        ? [labelEvent(20, 'labeled', 'ac/agent:new', bob), stateEvent(21, 'closed', bob)]
        : [stateEvent(20, 'closed', bob), labelEvent(21, 'labeled', 'ac/agent:new', bob)])
    )
    vi.mocked(f.deps.cards.setAssignee).mockImplementation(async ({ agentId }) => {
      const previousAgentId = f.card().assigneeAgentId
      Object.assign(f.card(), {
        status: 'ready',
        assigneeAgentId: agentId,
        lease: null,
        stateRevision: 2n,
        dispatchRevision: 2n,
        labelWritePending: true
      })
      return {
        ok: true as const,
        changed: true,
        card: { status: 'ready' } as never,
        previousAgentId,
        revokedLease: lease
      }
    })
    await f.sync.onCardChanged('board', 1, true)
    const plan = vi.mocked(f.deps.store.applyPlan).mock.calls.at(-1)![3]
    if (reason === 'not_planned') {
      expect(f.card().status).toBe('archived')
      expect(plan).toMatchObject({ addLabels: ['ac/status:archived'], removeLabels: ['ac/status:running'] })
      expect(plan.issueState).toBeUndefined()
      expect(plan.comment).toBeUndefined()
    } else {
      expect(plan.comment).toContain('`ac/status:ready` cannot move to `ac/status:done`')
      expect(f.card().status).toBe('ready')
      expect(plan).toMatchObject({
        issueState: { state: 'open' },
        addLabels: ['ac/status:ready'],
        removeLabels: ['ac/status:running']
      })
    }
    expect(f.card()).toMatchObject({
      syncEventCursor: agentFirst ? 21n : 20n,
      syncAgentCursor: agentFirst ? 20n : 21n,
      labelWritePending: false,
      lease: null
    })
    expect(f.deps.revoke).toHaveBeenCalledOnce()
    expect(f.deps.repo.defer).not.toHaveBeenCalled()
    expect(vi.mocked(f.deps.repo.apply).mock.calls.at(-1)![5]).toEqual({ login: 'bob', id: 1 })
  })
})

describe('vera-474 B2: KanbanSync status commits reach the projection seam', () => {
  it('vera-474: B2 a human label adoption through KanbanSync projects the committed status', async () => {
    const f = fixture()
    const project = { onStatusCommitted: vi.fn() }
    const sync = new KanbanSync({ ...f.deps, project } as KanbanSyncDeps)
    await sync.onCardChanged('board', 1, true)
    expect(f.card().status).toBe('ready')
    expect(project.onStatusCommitted).toHaveBeenCalledTimes(1)
    expect(project.onStatusCommitted).toHaveBeenCalledWith({ boardId: 'board', issueNumber: 1 })
  })

  it('vera-474: B2 a #194 reconcile that fails a card closed projects its new status', async () => {
    const f = fixture({ status: 'ready', syncDeferredAt: new Date(Date.now() - 11 * 60_000), syncDeferralCount: 3 })
    // The visible events cannot reproduce the live label, so the pass defers past the bound and fails closed.
    f.events.splice(0, f.events.length)
    const project = { onStatusCommitted: vi.fn() }
    const sync = new KanbanSync({ ...f.deps, project } as KanbanSyncDeps)
    await sync.reconcileBoard('board')
    expect(f.card().status).toBe('triage')
    expect(project.onStatusCommitted).toHaveBeenCalledWith({ boardId: 'board', issueNumber: 1 })
  })

  it('vera-474: B2 a pass that commits no change projects nothing', async () => {
    const f = fixture({ status: 'ready' })
    const project = { onStatusCommitted: vi.fn() }
    const sync = new KanbanSync({ ...f.deps, project } as KanbanSyncDeps)
    await sync.onCardChanged('board', 1, true)
    expect(f.card().status).toBe('ready')
    expect(project.onStatusCommitted).not.toHaveBeenCalled()
  })
})

describe('sync post-commit projection under downstream failures', () => {
  const lease = { leaseId: 'lease', runId: 'run', agentId: 'worker', daemonId: 'daemon', dispatchRevision: 1n }

  it.each(['label write', 'revoke', 'ack', 'promote'] as const)(
    'vera-474r2: a committed status projects exactly once when %s rejects, including retries',
    async (failure) => {
      const from = failure === 'revoke' ? 'running' : failure === 'promote' ? 'triage' : 'todo'
      const to = failure === 'revoke' ? 'blocked' : failure === 'promote' ? 'todo' : 'ready'
      const f = fixture({ status: from, lease: failure === 'revoke' ? lease : null })
      f.issue.labels = [`ac/status:${to}`]
      f.events.splice(0, f.events.length, labelEvent(1, 'labeled', `ac/status:${to}`, alice))
      const projected: string[] = []
      const project = { onStatusCommitted: vi.fn(() => projected.push(f.card().status)) }
      const sync = new KanbanSync({ ...f.deps, project })
      const error = new Error(`${failure} failed`)
      if (failure === 'label write') vi.mocked(f.deps.store.applyPlan).mockRejectedValueOnce(error)
      if (failure === 'revoke') vi.mocked(f.deps.revoke).mockRejectedValueOnce(error)
      if (failure === 'ack') vi.mocked(f.deps.repo.ack).mockRejectedValueOnce(error)
      if (failure === 'promote') vi.mocked(f.deps.promote).mockRejectedValueOnce(error)
      await expect(sync.onCardChanged('board', 1, true)).rejects.toThrow(error)
      expect(f.card().status).toBe(to)
      const afterFailure = [...projected]
      await sync.onCardChanged('board', 1, true)
      await sync.reconcileBoard('board')
      expect(afterFailure).toEqual([to])
      expect(projected).toEqual([to])
      expect(project.onStatusCommitted).toHaveBeenCalledExactlyOnceWith({ boardId: 'board', issueNumber: 1 })
    }
  )

  it.each(['revoke', 'comment'] as const)(
    'vera-474r2: a reassignment restart projects before its %s rejects',
    async (failure) => {
      const f = fixture({ status: 'running', assigneeAgentId: 'worker', lease })
      f.issue.labels = ['ac/status:running', 'ac/agent:next']
      f.events.splice(
        0,
        f.events.length,
        labelEvent(1, 'labeled', 'ac/status:running', app),
        labelEvent(2, 'labeled', 'ac/agent:next', alice)
      )
      vi.mocked(f.deps.cards.setAssignee).mockImplementation(async ({ agentId }) => {
        Object.assign(f.card(), { status: 'ready', assigneeAgentId: agentId, lease: null, syncAgentCursor: 2n })
        return {
          ok: true,
          changed: true,
          card: { status: 'ready' } as never,
          previousAgentId: 'worker',
          revokedLease: lease
        }
      })
      const projected: string[] = []
      const project = { onStatusCommitted: vi.fn(() => projected.push(f.card().status)) }
      const sync = new KanbanSync({ ...f.deps, project })
      const error = new Error(`${failure} failed`)
      if (failure === 'revoke') vi.mocked(f.deps.revoke).mockRejectedValueOnce(error)
      else vi.mocked(f.deps.store.applyPlan).mockRejectedValueOnce(error)
      await expect(sync.onCardChanged('board', 1, true)).rejects.toThrow(error)
      expect(f.card().status).toBe('ready')
      const afterFailure = [...projected]
      await sync.onCardChanged('board', 1, true)
      await sync.reconcileBoard('board')
      expect(afterFailure).toEqual(['ready'])
      expect(projected).toEqual(['ready'])
      expect(project.onStatusCommitted).toHaveBeenCalledTimes(1)
    }
  )

  it('vera-474r2: fail-closed projects triage before lease revocation rejects', async () => {
    const f = fixture({ status: 'running', lease, syncDeferredAt: new Date(Date.now() - 11 * 60_000) })
    f.events.splice(0, f.events.length)
    vi.mocked(f.deps.revoke).mockRejectedValueOnce(new Error('revoke failed'))
    const projected: string[] = []
    const project = { onStatusCommitted: vi.fn(() => projected.push(f.card().status)) }
    const sync = new KanbanSync({ ...f.deps, project })
    await expect(sync.onCardChanged('board', 1, true)).rejects.toThrow('revoke failed')
    expect(f.card().status).toBe('triage')
    expect(projected).toEqual(['triage'])
    await sync.onCardChanged('board', 1, true)
    await sync.reconcileBoard('board')
    expect(project.onStatusCommitted).toHaveBeenCalledTimes(1)
  })

  it('vera-474r2: assignment-only commits never project a status', async () => {
    const f = fixture({ status: 'ready', assigneeAgentId: 'worker' })
    f.issue.labels = [...f.issue.labels, 'ac/agent:next']
    f.events.push(labelEvent(2, 'labeled', 'ac/agent:next', alice))
    vi.mocked(f.deps.cards.setAssignee).mockImplementation(async ({ agentId }) => {
      Object.assign(f.card(), { assigneeAgentId: agentId, syncAgentCursor: 2n })
      return {
        ok: true,
        changed: true,
        card: { status: 'ready' } as never,
        previousAgentId: 'worker',
        revokedLease: null
      }
    })
    const project = { onStatusCommitted: vi.fn() }
    await new KanbanSync({ ...f.deps, project }).onCardChanged('board', 1, true)
    expect(f.card().status).toBe('ready')
    expect(project.onStatusCommitted).not.toHaveBeenCalled()
  })

  it.each(['unchanged', 'lost CAS', 'rejected commit'] as const)(
    'vera-474r2: %s followed by failed I/O queues no projection',
    async (outcome) => {
      const f = fixture({ status: outcome === 'unchanged' ? 'ready' : 'todo' })
      if (outcome === 'lost CAS') vi.mocked(f.deps.repo.apply).mockResolvedValueOnce(null)
      if (outcome === 'rejected commit') vi.mocked(f.deps.repo.apply).mockRejectedValueOnce(new Error('DB failed'))
      vi.mocked(f.deps.store.applyPlan).mockRejectedValueOnce(new Error('label failed'))
      const project = { onStatusCommitted: vi.fn() }
      await new KanbanSync({ ...f.deps, project }).onCardChanged('board', 1, true).catch(() => {})
      expect(f.card().status).toBe(outcome === 'unchanged' ? 'ready' : 'todo')
      expect(project.onStatusCommitted).not.toHaveBeenCalled()
    }
  )
})
describe('vera-414-merge2: a review timeout uses the existing daemon revoke path', () => {
  it('vera-414-merge2: revokes before projection and acknowledges the new dispatch revision', async () => {
    const start = new Date('2026-10-17T00:00:00Z')
    const lease = {
      leaseId: 'verify-lease',
      runId: 'verify-run',
      agentId: 'verifier',
      daemonId: 'daemon',
      dispatchRevision: 7n
    }
    const f = fixture({ status: 'review', dispatchRevision: 7n, lease, syncDeferredAt: start })
    f.deps.now = () => new Date(start.getTime() + 11 * 60_000)
    f.issue.labels = ['ac/status:blocked']
    f.events.length = 0
    await f.sync.onCardChanged('board', 1, true)
    expect(f.deps.revoke).toHaveBeenCalledExactlyOnceWith(lease, 'card')
    expect(vi.mocked(f.deps.revoke).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(f.deps.store.applyPlan).mock.invocationCallOrder[0]!
    )
    expect(f.deps.repo.ack).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'review', stateRevision: 1n, dispatchRevision: 8n }),
      0n,
      0n
    )
    expect(f.card()).toMatchObject({ status: 'review', needsAttention: true, lease: null })
    expect(f.deps.promote).not.toHaveBeenCalled()
  })
})
