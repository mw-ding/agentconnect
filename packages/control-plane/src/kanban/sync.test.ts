import { describe, expect, it, vi } from 'vitest'
import { KanbanSync, type SyncCard, type KanbanSyncDeps } from './sync.js'
import { KANBAN_STATUSES, canTransition, LEASED_HUMAN_STATUSES, planLabelReconcile } from './card-state.js'
import type { CardIssue, LabelEvent } from './card-store.js'
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
        card = { ...card, needsAttention: true }
        return true
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
