import { describe, expect, it, vi } from 'vitest'
import { KanbanSync, type SyncCard, type KanbanSyncDeps } from './sync.js'
import { KANBAN_STATUSES, canTransition, LEASED_HUMAN_STATUSES, planLabelReconcile } from './card-state.js'
import type { CardIssue, LabelEvent } from './card-store.js'

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
    permissions: { permission: vi.fn(async () => 'write') },
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

  it.each(['bot', 'app', 'unknown', 'read', 'permission_error', 'consumed'])(
    'does not adopt a %s edit',
    async (kind) => {
      const f = fixture({ syncEventCursor: kind === 'consumed' ? 1n : 0n })
      const e = event(1, kind !== 'bot')
      if (kind === 'app') e.performed_via_github_app = { id: 1 }
      if (kind === 'unknown') e.actor = null
      vi.mocked(f.deps.store.managedEdits).mockResolvedValue({ status: e, assignee: null, cursor: 1 })
      if (kind === 'read') vi.mocked(f.deps.permissions.permission).mockResolvedValue('read')
      if (kind === 'permission_error') vi.mocked(f.deps.permissions.permission).mockRejectedValue(new Error('offline'))
      await f.sync.onCardChanged('board', 1, true)
      expect(f.card().status).toBe('todo')
    }
  )

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
