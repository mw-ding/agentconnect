import { describe, expect, it } from 'vitest'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { PgKanbanSyncRepo } from '../../src/persistence/repositories/kanban-sync.repo.js'
import { PgKanbanCardRepo } from '../../src/persistence/repositories/kanban.repo.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import { KanbanSync } from '../../src/kanban/sync.js'
import { KanbanImporter } from '../../src/kanban/importer.js'
import { OrgId } from '../../src/domain/ids.js'
import { planLabelReconcile, planStatusWrite, type LabelPlan } from '../../src/kanban/card-state.js'
import type { CardIssue, LabelEvent } from '../../src/kanban/card-store.js'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'

const DAEMON = 'd6666666-6666-4666-8666-666666666666'
const AGENT = 'a6666666-6666-4666-8666-666666666666'
const NEXT = 'a7777777-7777-4777-8777-777777777777'

async function fixture(leased = false) {
  await seedDaemon(prisma, DAEMON)
  await seedAgent(prisma, AGENT, { daemonId: DAEMON })
  await seedAgent(prisma, NEXT, { daemonId: DAEMON })
  const board = await prisma.kanbanBoard.create({
    data: { orgId: DEFAULT_ORG_ID, name: 'sync', repoId: 42n, repoFullName: 'acme/web' }
  })
  const card = await prisma.kanbanCard.create({
    data: {
      boardId: board.id,
      issueId: 1n,
      issueNumber: 1,
      status: leased ? 'running' : 'todo',
      assigneeAgentId: AGENT
    }
  })
  const run = leased
    ? await prisma.kanbanRun.create({
        data: {
          cardId: card.id,
          attempt: 1,
          agentId: AGENT,
          daemonId: DAEMON,
          dispatchRevision: card.dispatchRevision,
          dispatchedAt: new Date(),
          leaseId: crypto.randomUUID()
        }
      })
    : null
  return { board, card, run, repo: new PgKanbanSyncRepo(prisma), cards: new PgKanbanCardRepo(prisma) }
}

describe('Kanban synchronization transactions (Postgres)', () => {
  it('serializes a human transition with one audit and rejects a stale competing read', async () => {
    const f = await fixture()
    const snapshot = (await f.repo.get(f.board.id, 1))!
    const plan = planLabelReconcile({ status: 'todo', leased: false }, { state: 'open', labels: ['ac/status:ready'] })
    const results = await Promise.all([
      f.repo.apply(snapshot, plan, 7n, true, 0n),
      f.repo.apply(snapshot, plan, 7n, true, 0n)
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    const current = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: f.card.id } })
    expect(current).toMatchObject({ status: 'ready', stateRevision: 2n, labelWritePending: false, syncEventCursor: 7n })
    expect(await prisma.auditEvent.count({ where: { kind: 'kanban_card_change' } })).toBe(1)
    const next = (await f.repo.get(f.board.id, 1))!
    expect(await f.repo.ack(snapshot, 7n)).toBe(false)
    expect(await f.repo.ack(next, 7n)).toBe(true)
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: f.card.id } })).labelWritePending).toBe(false)
  })

  it('consumes a refused edit: the cursors advance, status and revisions stay, and no audit row is written', async () => {
    const f = await fixture()
    const snapshot = (await f.repo.get(f.board.id, 1))!
    const plan = planStatusWrite('todo', { state: 'open', labels: ['ac/status:ready'] })
    expect(await f.repo.apply(snapshot, plan, 9n, false, 4n)).toEqual({ changed: false, revoked: null })
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: f.card.id } })).toMatchObject({
      status: 'todo',
      stateRevision: 1n,
      dispatchRevision: 1n,
      labelWritePending: true,
      syncEventCursor: 9n,
      syncAgentCursor: 4n
    })
    expect(await prisma.auditEvent.count({ where: { kind: 'kanban_card_change' } })).toBe(0)
    expect(await f.repo.ack((await f.repo.get(f.board.id, 1))!, 9n, 4n)).toBe(true)
  })

  it.each(['blocked', 'triage', 'archived'] as const)(
    'revokes a lease on a human %s move without counting a failure',
    async (status) => {
      const f = await fixture(true)
      const snapshot = (await f.repo.get(f.board.id, 1))!
      const plan = planLabelReconcile(
        { status: 'running', leased: true },
        { state: 'open', labels: [`ac/status:${status}`] }
      )
      const result = await f.repo.apply(snapshot, plan, 7n, true, 0n)
      expect(result?.revoked?.leaseId).toBe(f.run?.leaseId)
      expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: f.card.id } })).toMatchObject({
        status,
        dispatchRevision: 2n,
        consecutiveFailures: 0
      })
      expect(await prisma.kanbanRun.findUniqueOrThrow({ where: { id: f.run!.id } })).toMatchObject({
        outcome: 'reclaimed',
        reasonCode: 'human_status',
        endedAt: expect.any(Date)
      })
    }
  )

  it('fences an assignment race and preserves independent status/agent event cursors', async () => {
    const f = await fixture(true)
    const snapshot = (await f.repo.get(f.board.id, 1))!
    const result = await f.cards.setAssignee({
      cardId: f.card.id,
      agentId: NEXT,
      onLease: 'revoke',
      source: 'label',
      now: new Date()
    })
    expect(result.ok && result.revokedLease?.leaseId).toBe(f.run?.leaseId)
    const plan = planLabelReconcile(
      { status: 'running', leased: true },
      { state: 'open', labels: ['ac/status:blocked'] }
    )
    expect(await f.repo.apply(snapshot, plan, 7n, true, 12n)).toBe(null)
    const next = (await f.repo.get(f.board.id, 1))!
    expect(next.status).toBe('ready')
    await f.repo.ack(next, 7n, 12n)
    expect(await f.repo.get(f.board.id, 1)).toMatchObject({ syncEventCursor: 7n, syncAgentCursor: 12n })
  })

  it('rotates a bounded scan fairly through terminal, active and todo cards', async () => {
    const f = await fixture()
    await prisma.kanbanCard.createMany({
      data: Array.from({ length: 54 }, (_, i) => ({
        boardId: f.board.id,
        issueId: BigInt(i + 2),
        issueNumber: i + 2,
        status: i % 2 ? ('done' as const) : ('todo' as const)
      }))
    })
    const seen = new Set<number>()
    for (let i = 0; i < 3; i++) {
      const batch = await f.repo.list(f.board.id, 25)
      expect(batch).toHaveLength(25)
      batch.forEach((n) => seen.add(n))
    }
    expect(seen.size).toBe(55)
  })

  it('records the GitHub actor on a label-driven status audit row', async () => {
    const f = await fixture()
    const snapshot = (await f.repo.get(f.board.id, 1))!
    const plan = planLabelReconcile({ status: 'todo', leased: false }, { state: 'open', labels: ['ac/status:ready'] })
    const result = await f.repo.apply(snapshot, plan, 7n, true, 0n, { login: 'bob', id: 42 })
    expect(result?.changed).toBe(true)
    const audit = await prisma.auditEvent.findFirst({ where: { kind: 'kanban_card_change' } })
    expect(audit?.details).toMatchObject({ actorLogin: 'bob', actorGitHubId: 42, source: 'human_label' })
  })

  it('records the GitHub actor on a label-driven reassignment audit row', async () => {
    const f = await fixture(true)
    const result = await f.cards.setAssignee({
      cardId: f.card.id,
      agentId: NEXT,
      onLease: 'revoke',
      source: 'label',
      now: new Date(),
      actorLogin: 'bob',
      actorGitHubId: 42
    })
    expect(result.ok && result.revokedLease?.leaseId).toBe(f.run?.leaseId)
    const audits = await prisma.auditEvent.findMany({ where: { kind: 'kanban_card_change' } })
    expect(audits.some((a) => (a.details as { change?: string }).change === 'assignee')).toBe(true)
    expect(audits.find((a) => (a.details as { change?: string }).change === 'assignee')?.details).toMatchObject({
      change: 'assignee',
      actorLogin: 'bob',
      actorGitHubId: 42
    })
  })

  it('defers an unattributed pass and fails closed to needsAttention after the bound', async () => {
    const f = await fixture()
    const snapshot = (await f.repo.get(f.board.id, 1))!
    const deferred = await f.repo.defer(snapshot, new Date())
    expect(deferred).toMatchObject({ syncDeferralCount: 1 })
    expect(deferred?.syncDeferredAt).toBeInstanceOf(Date)
    // A non-dispatchable card keeps its status: it is only flagged, so nothing moves and nothing is audited.
    expect(await f.repo.failClosed((await f.repo.get(f.board.id, 1))!)).toEqual({ status: 'todo', revoked: null })
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: f.card.id } })).toMatchObject({
      status: 'todo',
      stateRevision: f.card.stateRevision,
      needsAttention: true,
      attentionReason: 'label_attribution_timeout',
      syncDeferredAt: null,
      syncDeferralCount: 0
    })
    expect(await prisma.auditEvent.count({ where: { kind: 'kanban_card_change' } })).toBe(0)
  })

  it('does not restart the deferral clock from a competing stale snapshot', async () => {
    const f = await fixture()
    const snapshot = (await f.repo.get(f.board.id, 1))!
    const first = new Date('2026-10-17T00:00:00Z')
    await f.repo.defer(snapshot, first)
    await f.repo.defer(snapshot, new Date(first.getTime() + 9 * 60_000))
    expect((await f.repo.get(f.board.id, 1))!.syncDeferredAt).toEqual(first)
  })

  it('rejects a stale repeated timeout snapshot even when fail-closed does not change status', async () => {
    const f = await fixture()
    const snapshot = (await f.repo.defer((await f.repo.get(f.board.id, 1))!, new Date()))!
    expect(await f.repo.failClosed(snapshot)).toEqual({ status: 'todo', revoked: null })
    expect(await f.repo.failClosed(snapshot)).toBeNull()
  })

  it('fails a leased running card closed to triage: lease ended, generation bumped, audited, a claim never takes it', async () => {
    const f = await fixture(true)
    const snapshot = (await f.repo.get(f.board.id, 1))!
    await f.repo.defer(snapshot, new Date())
    const failed = await f.repo.failClosed((await f.repo.get(f.board.id, 1))!)
    expect(failed).toEqual({ status: 'triage', revoked: expect.objectContaining({ leaseId: f.run!.leaseId }) })
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: f.card.id } })).toMatchObject({
      status: 'triage',
      stateRevision: f.card.stateRevision + 1n,
      dispatchRevision: f.card.dispatchRevision + 1n,
      labelWritePending: true,
      needsAttention: true,
      attentionReason: 'label_attribution_timeout'
    })
    expect(await prisma.kanbanRun.findUniqueOrThrow({ where: { id: f.run!.id } })).toMatchObject({
      outcome: 'reclaimed',
      reasonCode: 'label_attribution_timeout',
      endedAt: expect.any(Date)
    })
    const [audit] = await prisma.auditEvent.findMany({ where: { kind: 'kanban_card_change' } })
    expect(audit!.details).toMatchObject({
      from: 'running',
      to: 'triage',
      source: 'label_attribution_timeout',
      leaseId: f.run!.leaseId
    })
    // A stale snapshot (the generation moved) does not fail the card closed twice.
    expect(await f.repo.failClosed(snapshot)).toBeNull()
  })

  it('a claim neither takes nor clears a needsAttention card, even one left ready', async () => {
    const f = await fixture()
    await prisma.kanbanCard.update({
      where: { id: f.card.id },
      data: { status: 'ready', needsAttention: true, attentionReason: 'label_attribution_timeout' }
    })
    const claim = () =>
      new PgKanbanDispatchRepo(prisma).claim(f.board.id, { now: new Date(), isDaemonLive: () => true })
    expect(await claim()).toHaveLength(0)
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: f.card.id } })).toMatchObject({
      status: 'ready',
      needsAttention: true,
      attentionReason: 'label_attribution_timeout'
    })
    // The same card without the flag is claimable, so the flag alone is what holds it.
    await prisma.kanbanCard.update({ where: { id: f.card.id }, data: { needsAttention: false } })
    expect(await claim()).toHaveLength(1)
  })

  it('a settled apply clears a prior deferral bound', async () => {
    const f = await fixture()
    let snapshot = (await f.repo.get(f.board.id, 1))!
    await f.repo.defer(snapshot, new Date())
    snapshot = (await f.repo.get(f.board.id, 1))!
    const plan = planLabelReconcile({ status: 'todo', leased: false }, { state: 'open', labels: ['ac/status:ready'] })
    expect(await f.repo.apply(snapshot, plan, 7n, true, 0n)).toBeTruthy()
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: f.card.id } })).toMatchObject({
      syncDeferredAt: null,
      syncDeferralCount: 0
    })
  })
})

// A full KanbanSync over the real PG repo with a fake GitHub store/events: a non-writer's later remove+re-add of the
// card's current status label must revert the card to triage (and revoke its lease), so nothing is left to dispatch.
describe('KanbanSync full pass (non-writer re-add)', () => {
  const bob = { type: 'User', login: 'bob' }
  const mallory = { type: 'User', login: 'mallory' }

  async function syncFixture(status: 'ready' | 'running', leased: boolean) {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'sync-full', repoId: 42n, repoFullName: 'acme/web' }
    })
    const card = await prisma.kanbanCard.create({
      data: { boardId: board.id, issueId: 1n, issueNumber: 1, status, assigneeAgentId: AGENT, syncEventCursor: 100n }
    })
    const run = leased
      ? await prisma.kanbanRun.create({
          data: {
            cardId: card.id,
            attempt: 1,
            agentId: AGENT,
            daemonId: DAEMON,
            dispatchRevision: card.dispatchRevision,
            dispatchedAt: new Date(),
            leaseId: crypto.randomUUID()
          }
        })
      : null
    const label = `ac/status:${status}`
    const issue: CardIssue = { issueId: 1n, nodeId: 'I_1', number: 1, state: 'open', labels: [label] }
    const events: LabelEvent[] = [
      { id: 100, event: 'labeled', label: { name: label }, actor: bob },
      { id: 101, event: 'unlabeled', label: { name: label }, actor: mallory },
      { id: 102, event: 'labeled', label: { name: label }, actor: mallory }
    ]
    const writes: LabelPlan[] = []
    const revoked: unknown[] = []
    const sync = new KanbanSync({
      repo: new PgKanbanSyncRepo(prisma),
      cards: new PgKanbanCardRepo(prisma),
      store: {
        readCard: async () => issue,
        readLabelEvents: async () => events,
        applyPlan: async (_r: unknown, _n: unknown, _o: unknown, plan: LabelPlan) => {
          writes.push(plan)
        }
      },
      permissions: {
        permission: async (_r: unknown, login: string) => (login.toLowerCase() === 'bob' ? 'write' : 'triage')
      },
      appSlug: 'agentconnect',
      repoRef: async () => ({ installationId: 1n, repoId: 42n, repoFullName: 'acme/web' }),
      revoke: async (lease: unknown) => {
        revoked.push(lease)
      },
      promote: async () => {},
      log: { warn: () => {} }
    })
    return { board, card, run, sync, writes, revoked }
  }

  it('reverts a ready card to triage, refuses, and leaves nothing to claim', async () => {
    const f = await syncFixture('ready', false)
    await f.sync.onCardChanged(f.board.id, 1, true)
    const row = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: f.card.id } })
    expect(row.status).toBe('triage')
    expect(row.syncEventCursor).toBe(102n)
    expect(f.writes.at(-1)).toMatchObject({
      status: 'triage',
      addLabels: ['ac/status:triage'],
      removeLabels: ['ac/status:ready'],
      comment: expect.stringContaining('only collaborators with write access')
    })
    expect(
      await new PgKanbanDispatchRepo(prisma).claim(f.board.id, { now: new Date(), isDaemonLive: () => true })
    ).toHaveLength(0)
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { kind: 'kanban_card_change' } })
    expect(audit.details).toMatchObject({ from: 'ready', to: 'triage', source: 'human_label', actorLogin: 'mallory' })
  })

  it('revokes the lease and reclaims the run when a non-writer re-adds a running card', async () => {
    const f = await syncFixture('running', true)
    await f.sync.onCardChanged(f.board.id, 1, true)
    const row = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: f.card.id } })
    expect(row.status).toBe('triage')
    expect(row.dispatchRevision).toBe(2n)
    expect(await prisma.kanbanRun.findUniqueOrThrow({ where: { id: f.run!.id } })).toMatchObject({
      outcome: 'reclaimed',
      reasonCode: 'human_status',
      endedAt: expect.any(Date)
    })
    expect(f.revoked).toHaveLength(1)
    expect(f.writes.at(-1)).toMatchObject({ status: 'triage', removeLabels: ['ac/status:running'] })
  })
})

// The non-writer's removal AND re-add are both invisible to the events API, so the visible history still shows the
// writer's add; only the `labeled` doorbell's sender says who re-added the label.
describe('KanbanSync full pass (invisible non-writer remove+re-add, doorbell sender)', () => {
  const bob = { type: 'User', login: 'bob', id: 1 }
  const mallory = { type: 'User', login: 'mallory', id: 7 }
  const app = { type: 'Bot', login: 'agentconnect[bot]', id: 99 }
  const doorbell = (label: string) => ({
    action: 'labeled',
    sender: { login: 'mallory', id: 7, type: 'User' },
    label
  })

  async function syncFixture(status: 'ready' | 'running', leased: boolean) {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await prisma.agent.update({ where: { id: AGENT }, data: { name: 'worker' } })
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'sync-invisible', repoId: 42n, repoFullName: 'acme/web' }
    })
    const card = await prisma.kanbanCard.create({
      data: {
        boardId: board.id,
        issueId: 1n,
        issueNumber: 1,
        status,
        assigneeAgentId: AGENT,
        syncEventCursor: 100n,
        syncAgentCursor: 99n
      }
    })
    const run = leased
      ? await prisma.kanbanRun.create({
          data: {
            cardId: card.id,
            attempt: 1,
            agentId: AGENT,
            daemonId: DAEMON,
            dispatchRevision: card.dispatchRevision,
            dispatchedAt: new Date(),
            leaseId: crypto.randomUUID()
          }
        })
      : null
    const label = `ac/status:${status}`
    const issue: CardIssue = {
      issueId: 1n,
      nodeId: 'I_1',
      number: 1,
      state: 'open',
      labels: [label, 'ac/agent:worker']
    }
    // Only the writer's adds are visible; mallory's unlabeled+labeled of `label` have not reached the events API.
    const events: LabelEvent[] = [
      { id: 99, event: 'labeled', label: { name: 'ac/agent:worker' }, actor: bob },
      { id: 100, event: 'labeled', label: { name: label }, actor: bob }
    ]
    const writes: LabelPlan[] = []
    const revoked: unknown[] = []
    const sync = new KanbanSync({
      repo: new PgKanbanSyncRepo(prisma),
      cards: new PgKanbanCardRepo(prisma),
      store: {
        readCard: async () => ({ ...issue, labels: [...issue.labels] }),
        readLabelEvents: async () => [...events],
        applyPlan: async (_r: unknown, _n: unknown, _o: unknown, plan: LabelPlan) => {
          writes.push(plan)
          issue.labels = [...issue.labels.filter((l) => !plan.removeLabels.includes(l)), ...plan.addLabels]
        }
      },
      permissions: {
        permission: async (_r: unknown, login: string) =>
          ['bob', 'carol'].includes(login.toLowerCase()) ? 'write' : 'triage'
      },
      appSlug: 'agentconnect',
      repoRef: async () => ({ installationId: 1n, repoId: 42n, repoFullName: 'acme/web' }),
      revoke: async (lease: unknown) => {
        revoked.push(lease)
      },
      promote: async () => {},
      log: { warn: () => {} }
    })
    // The lagged events finally become visible: mallory's remove+re-add, then the App's own revert.
    const catchUp = () => {
      events.push(
        { id: 101, event: 'unlabeled', label: { name: label }, actor: mallory },
        { id: 102, event: 'labeled', label: { name: label }, actor: mallory },
        { id: 103, event: 'unlabeled', label: { name: label }, actor: app },
        { id: 104, event: 'labeled', label: { name: 'ac/status:triage' }, actor: app }
      )
    }
    return { board, card, run, sync, writes, revoked, label, catchUp }
  }

  const claim = (boardId: string) =>
    new PgKanbanDispatchRepo(prisma).claim(boardId, { now: new Date(), isDaemonLive: () => true })

  it('a tick alone cannot see the invisible re-add (the gap the doorbell sender closes)', async () => {
    const f = await syncFixture('ready', false)
    await f.sync.onCardChanged(f.board.id, 1)
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: f.card.id } })).status).toBe('ready')
  })

  it('reverts a ready card to triage on the doorbell, refuses, and stays triage once the events are visible', async () => {
    const f = await syncFixture('ready', false)
    await f.sync.onCardChanged(f.board.id, 1, true, doorbell(f.label))
    const row = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: f.card.id } })
    expect(row).toMatchObject({ status: 'triage', assigneeAgentId: AGENT, needsAttention: false })
    expect(f.writes.at(-1)).toMatchObject({
      status: 'triage',
      addLabels: ['ac/status:triage'],
      removeLabels: ['ac/status:ready'],
      comment: expect.stringContaining('only collaborators with write access')
    })
    expect(await claim(f.board.id)).toHaveLength(0)
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { kind: 'kanban_card_change' } })
    expect(audit.details).toMatchObject({ from: 'ready', to: 'triage', source: 'human_label', actorLogin: 'mallory' })

    f.catchUp()
    const writes = f.writes.length
    await f.sync.onCardChanged(f.board.id, 1)
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: f.card.id } })).status).toBe('triage')
    expect(f.writes.slice(writes).every((w) => w.addLabels.length === 0 && w.removeLabels.length === 0)).toBe(true)
    expect(await claim(f.board.id)).toHaveLength(0)
  })

  it('revokes the lease and reclaims the run when the invisible re-add is on a running card', async () => {
    const f = await syncFixture('running', true)
    await f.sync.onCardChanged(f.board.id, 1, true, doorbell(f.label))
    const row = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: f.card.id } })
    expect(row.status).toBe('triage')
    expect(row.dispatchRevision).toBe(2n)
    expect(await prisma.kanbanRun.findUniqueOrThrow({ where: { id: f.run!.id } })).toMatchObject({
      outcome: 'reclaimed',
      reasonCode: 'human_status',
      endedAt: expect.any(Date)
    })
    expect(f.revoked).toHaveLength(1)
    expect(f.writes.at(-1)).toMatchObject({
      status: 'triage',
      removeLabels: ['ac/status:running'],
      comment: expect.stringContaining('only collaborators with write access')
    })
    f.catchUp()
    await f.sync.onCardChanged(f.board.id, 1)
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: f.card.id } })).status).toBe('triage')
    expect(await claim(f.board.id)).toHaveLength(0)
  })

  it('defers when a live writer sender re-adds the label invisibly', async () => {
    const f = await syncFixture('ready', false)
    const carol = { login: 'carol', id: 3, type: 'User' }
    await f.sync.onCardChanged(f.board.id, 1, true, { ...doorbell(f.label), sender: carol })
    const row = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: f.card.id } })
    expect(row).toMatchObject({ status: 'ready', syncDeferralCount: 1, syncEventCursor: 100n })
    expect(f.writes).toHaveLength(0)
  })
})

// Two KanbanSync replicas over the same Postgres with a shared fake GitHub: replica A commits a lease-revoking
// reassignment while replica B applies a newer human status event. A must re-read GitHub before planning labels, so B's
// newer state (and cursor) win instead of A re-writing the stale pre-reassignment label.
describe('two CP replicas (stale snapshot after reassignment)', () => {
  const bob = { type: 'User', login: 'bob' }

  async function replicas() {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedAgent(prisma, NEXT, { daemonId: DAEMON, name: 'new' })
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'replicas', repoId: 42n, repoFullName: 'acme/web' }
    })
    const card = await prisma.kanbanCard.create({
      data: {
        boardId: board.id,
        issueId: 1n,
        issueNumber: 1,
        status: 'running',
        assigneeAgentId: AGENT,
        syncEventCursor: 10n,
        syncAgentCursor: 10n
      }
    })
    const run = await prisma.kanbanRun.create({
      data: {
        cardId: card.id,
        attempt: 1,
        agentId: AGENT,
        daemonId: DAEMON,
        dispatchRevision: card.dispatchRevision,
        dispatchedAt: new Date(),
        leaseId: crypto.randomUUID()
      }
    })
    const repo = new PgKanbanSyncRepo(prisma)
    const cards = new PgKanbanCardRepo(prisma)
    const state = {
      issue: {
        issueId: 1n,
        nodeId: 'I_1',
        number: 1,
        state: 'open',
        labels: ['ac/status:running', 'ac/agent:new']
      } as CardIssue,
      events: [
        { id: 10, event: 'labeled', label: { name: 'ac/status:running' }, actor: bob },
        { id: 20, event: 'labeled', label: { name: 'ac/agent:new' }, actor: bob }
      ] as LabelEvent[]
    }
    const writes: LabelPlan[] = []
    const store = {
      readCard: async () => state.issue,
      readLabelEvents: async () => state.events,
      applyPlan: async (_r: unknown, _n: unknown, _o: unknown, plan: LabelPlan) => {
        writes.push(plan)
      }
    }
    const ref = { installationId: 1n, repoId: 42n, repoFullName: 'acme/web' }
    const mk = (overrides: Partial<ConstructorParameters<typeof KanbanSync>[0]> = {}) =>
      new KanbanSync({
        repo,
        cards,
        store,
        permissions: { permission: async () => 'write' },
        appSlug: 'agentconnect',
        repoRef: async () => ref,
        revoke: async () => {},
        promote: async () => {},
        log: { warn: () => {} },
        ...overrides
      })
    return { board, card, run, repo, cards, state, writes, mk }
  }

  it('replica B newer status wins over replica A stale snapshot', async () => {
    const f = await replicas()
    const syncB = f.mk({
      store: {
        readCard: async () => f.state.issue,
        readLabelEvents: async () => f.state.events,
        applyPlan: async () => {
          throw new Error('B label write failed')
        }
      }
    })
    // A's setAssignee runs B (a newer human status event) before returning, so A's later re-read sees B's commit.
    let bRan = false
    const syncA = f.mk({
      cards: {
        resolveAgentSlug: f.cards.resolveAgentSlug.bind(f.cards),
        setAssignee: async (input) => {
          const result = await f.cards.setAssignee(input)
          if (!bRan) {
            bRan = true
            f.state.issue = { ...f.state.issue, labels: ['ac/status:blocked', 'ac/agent:new'] }
            f.state.events = [
              { id: 10, event: 'labeled', label: { name: 'ac/status:running' }, actor: bob },
              { id: 20, event: 'labeled', label: { name: 'ac/agent:new' }, actor: bob },
              { id: 30, event: 'unlabeled', label: { name: 'ac/status:running' }, actor: bob },
              { id: 31, event: 'labeled', label: { name: 'ac/status:blocked' }, actor: bob }
            ]
            await expect(syncB.onCardChanged(f.board.id, 1, true)).rejects.toThrow('B label write failed')
          }
          return result
        }
      }
    })
    await syncA.onCardChanged(f.board.id, 1, true)

    const row = await prisma.kanbanCard.findUniqueOrThrow({ where: { id: f.card.id } })
    expect(row.status).toBe('blocked')
    expect(row.syncEventCursor).toBe(31n)
    expect(row.labelWritePending).toBe(false)
    expect(f.writes).toHaveLength(2)
    // A's stale snapshot must not re-write the pre-reassignment status label.
    expect(f.writes.some((w) => w.removeLabels.includes('ac/status:running'))).toBe(false)
  })

  it.each([false, true])('rejects A stale apply after B commits (cursor-only=%s)', async (cursorOnly) => {
    const f = await replicas()
    await prisma.kanbanRun.delete({ where: { id: f.run.id } })
    await prisma.kanbanCard.update({
      where: { id: f.card.id },
      data: { status: 'todo', assigneeAgentId: NEXT }
    })
    f.state.issue = { ...f.state.issue, labels: ['ac/status:blocked', 'ac/agent:new'] }
    f.state.events = [
      { id: 10, event: 'labeled', label: { name: 'ac/status:todo' }, actor: bob },
      { id: 20, event: 'labeled', label: { name: 'ac/agent:new' }, actor: bob },
      { id: 21, event: 'unlabeled', label: { name: 'ac/status:todo' }, actor: bob },
      { id: 22, event: 'labeled', label: { name: 'ac/status:blocked' }, actor: bob }
    ]
    const syncB = f.mk()
    const staleRepo = new PgKanbanSyncRepo(prisma)
    const apply = staleRepo.apply.bind(staleRepo)
    let interleaved = false
    staleRepo.apply = async (...args) => {
      if (!interleaved) {
        interleaved = true
        const status = cursorOnly ? 'todo' : 'ready'
        f.state.issue = { ...f.state.issue, labels: [`ac/status:${status}`, 'ac/agent:new'] }
        f.state.events = [
          ...f.state.events,
          { id: 30, event: 'unlabeled', label: { name: 'ac/status:blocked' }, actor: bob },
          { id: 31, event: 'labeled', label: { name: `ac/status:${status}` }, actor: bob }
        ]
        await syncB.onCardChanged(f.board.id, 1, true)
      }
      return apply(...args)
    }
    await f.mk({ repo: staleRepo }).onCardChanged(f.board.id, 1, true)
    expect(interleaved).toBe(true)
    expect(await f.repo.get(f.board.id, 1)).toMatchObject({
      status: cursorOnly ? 'todo' : 'ready',
      syncEventCursor: 31n,
      stateRevision: cursorOnly ? 1n : 2n
    })
    expect(f.writes).toHaveLength(1)
  })
})

// Vera round 2 (review 5559523967): the blocker attacks through the real KanbanSync over Postgres; failed on 5d610cb1e.
describe('vera-r2: KanbanSync over Postgres', () => {
  const bob = { type: 'User', login: 'bob', id: 1 }
  const mallory = { type: 'User', login: 'mallory', id: 7 }
  const app = { type: 'Bot', login: 'agentconnect[bot]' }

  async function pg(
    card: {
      status: 'todo' | 'done' | 'review' | 'ready' | 'triage'
      syncEventCursor: bigint
      syncAgentCursor?: bigint
    } & Record<string, unknown>,
    labels: string[],
    events: LabelEvent[],
    now: () => Date = () => new Date()
  ) {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedAgent(prisma, NEXT, { daemonId: DAEMON, name: 'new' })
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'vera-r2', repoId: 42n, repoFullName: 'acme/web' }
    })
    const row = await prisma.kanbanCard.create({
      data: { boardId: board.id, issueId: 1n, issueNumber: 1, assigneeAgentId: AGENT, ...card }
    })
    const state = { issue: { issueId: 1n, nodeId: 'I_1', number: 1, state: 'open', labels } as CardIssue, events }
    const writes: LabelPlan[] = []
    const cards = new PgKanbanCardRepo(prisma)
    const deps = {
      repo: new PgKanbanSyncRepo(prisma),
      cards,
      store: {
        readCard: async () => state.issue,
        readLabelEvents: async () => [...state.events],
        applyPlan: async (_r: unknown, _n: unknown, _o: unknown, plan: LabelPlan) => {
          writes.push(plan)
        }
      },
      permissions: {
        permission: async (_r: unknown, login: string) => (login.toLowerCase() === 'bob' ? 'write' : 'triage') as never
      },
      appSlug: 'agentconnect',
      repoRef: async () => ({ installationId: 1n, repoId: 42n, repoFullName: 'acme/web' }),
      revoke: async () => {},
      promote: async () => {},
      log: { warn: () => {} },
      now
    }
    const read = () => prisma.kanbanCard.findUniqueOrThrow({ where: { id: row.id } })
    const claim = () => new PgKanbanDispatchRepo(prisma).claim(board.id, { now: new Date(), isDaemonLive: () => true })
    return { board, row, state, writes, deps, cards, read, claim }
  }

  it("vera-r2: 1a a writer's reopen does not adopt a triage user's ready label (PG)", async () => {
    const f = await pg(
      { status: 'done', syncEventCursor: 100n },
      ['ac/status:ready'],
      [
        { id: 99, event: 'closed', actor: bob },
        { id: 100, event: 'labeled', label: { name: 'ac/status:done' }, actor: bob },
        { id: 101, event: 'unlabeled', label: { name: 'ac/status:done' }, actor: mallory },
        { id: 102, event: 'labeled', label: { name: 'ac/status:ready' }, actor: mallory },
        { id: 103, event: 'reopened', actor: bob }
      ]
    )
    await new KanbanSync(f.deps).onCardChanged(f.board.id, 1, true)
    expect((await f.read()).status).not.toBe('ready')
    expect(await f.claim()).toHaveLength(0)
  })

  it('vera-r2: 1b a status swap during the reassignment is re-judged after the re-read (PG)', async () => {
    const f = await pg(
      { status: 'todo', syncEventCursor: 10n, syncAgentCursor: 10n },
      ['ac/status:blocked', 'ac/agent:new'],
      [
        { id: 10, event: 'labeled', label: { name: 'ac/status:todo' }, actor: bob },
        { id: 20, event: 'unlabeled', label: { name: 'ac/status:todo' }, actor: bob },
        { id: 21, event: 'labeled', label: { name: 'ac/status:blocked' }, actor: bob },
        { id: 22, event: 'labeled', label: { name: 'ac/agent:new' }, actor: bob }
      ]
    )
    let swapped = false
    const sync = new KanbanSync({
      ...f.deps,
      cards: {
        resolveAgentSlug: f.cards.resolveAgentSlug.bind(f.cards),
        setAssignee: async (input) => {
          const result = await f.cards.setAssignee(input)
          if (!swapped) {
            swapped = true
            f.state.issue = { ...f.state.issue, labels: ['ac/status:ready', 'ac/agent:new'] }
            f.state.events.push(
              { id: 30, event: 'unlabeled', label: { name: 'ac/status:blocked' }, actor: mallory },
              { id: 31, event: 'labeled', label: { name: 'ac/status:ready' }, actor: mallory }
            )
          }
          return result
        }
      }
    })
    await sync.onCardChanged(f.board.id, 1, true)
    await sync.onCardChanged(f.board.id, 1, true)
    expect((await f.read()).status).not.toBe('ready')
    expect(await f.claim()).toHaveLength(0)
  })

  it("vera-r2: 2 projectStatus neither overwrites nor acks a writer's edit during a pending CP write (PG)", async () => {
    const f = await pg(
      { status: 'review', syncEventCursor: 10n, labelWritePending: true },
      ['ac/status:ready'],
      [
        { id: 10, event: 'labeled', label: { name: 'ac/status:running' }, actor: bob },
        { id: 20, event: 'unlabeled', label: { name: 'ac/status:running' }, actor: bob },
        { id: 21, event: 'labeled', label: { name: 'ac/status:ready' }, actor: bob }
      ]
    )
    const sync = new KanbanSync(f.deps)
    await sync.projectStatus(f.board.id, 1, 'review')
    expect((await f.read()).syncEventCursor).toBe(10n)
    expect(f.writes.some((w) => w.removeLabels.includes('ac/status:ready'))).toBe(false)
    await sync.onCardChanged(f.board.id, 1, true)
    expect((await f.read()).status).toBe('ready')
  })

  it("an imported writer's ready is consumed: claim, then projectStatus projects running without deferring (PG)", async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON, name: 'worker' })
    const board = await prisma.kanbanBoard.create({
      data: { orgId: DEFAULT_ORG_ID, name: 'import', repoId: 42n, repoFullName: 'acme/web' }
    })
    const state = {
      issue: {
        issueId: 1n,
        nodeId: 'I_1',
        number: 1,
        state: 'open',
        labels: ['ac/status:ready', 'ac/agent:worker'],
        authorLogin: 'bob',
        authorType: 'User',
        authorViaGithubApp: false
      } as CardIssue,
      events: [
        { id: 10, event: 'labeled', label: { name: 'ac/status:ready' }, actor: bob },
        { id: 11, event: 'labeled', label: { name: 'ac/agent:worker' }, actor: bob }
      ] as LabelEvent[]
    }
    const writes: LabelPlan[] = []
    const store = {
      readCard: async () => state.issue,
      readLabelEvents: async () => [...state.events],
      applyPlan: async (_r: unknown, _n: unknown, _o: unknown, plan: LabelPlan) => {
        writes.push(plan)
      }
    }
    const permissions = { permission: async () => 'write' as const }
    const ref = { installationId: 1n, repoId: 42n, repoFullName: 'acme/web' }
    const importer = new KanbanImporter({
      cards: new PgKanbanCardRepo(prisma),
      store,
      permissions,
      appSlug: 'agentconnect'
    })
    expect(await importer.import({ ...board, orgId: OrgId(board.orgId) }, ref, 1, { action: 'opened' })).toBe(true)
    expect(await prisma.kanbanCard.findFirstOrThrow({ where: { boardId: board.id } })).toMatchObject({
      status: 'ready',
      syncEventCursor: 10n
    })
    const leases = await new PgKanbanDispatchRepo(prisma).claim(board.id, { now: new Date(), isDaemonLive: () => true })
    expect(leases).toHaveLength(1)
    const sync = new KanbanSync({
      repo: new PgKanbanSyncRepo(prisma),
      cards: new PgKanbanCardRepo(prisma),
      store,
      permissions,
      appSlug: 'agentconnect',
      repoRef: async () => ref,
      revoke: async () => {},
      promote: async () => {},
      log: { warn: () => {} }
    })
    await sync.projectStatus(board.id, 1, 'running')
    expect(await prisma.kanbanCard.findFirstOrThrow({ where: { boardId: board.id } })).toMatchObject({
      status: 'running',
      labelWritePending: false,
      syncDeferredAt: null,
      syncDeferralCount: 0
    })
    expect(writes.at(-1)).toMatchObject({ addLabels: ['ac/status:running'], removeLabels: ['ac/status:ready'] })
    expect(writes.at(-1)!.comment).toBeUndefined()
  })

  it('retries a failed fail-closed projection, clears pending, and later adopts a writer edit (PG)', async () => {
    const now = new Date()
    const f = await pg(
      { status: 'ready', syncEventCursor: 40n, syncDeferredAt: new Date(now.getTime() - 11 * 60_000) },
      ['ac/status:blocked'],
      [{ id: 40, event: 'labeled', label: { name: 'ac/status:ready' }, actor: bob }],
      () => now
    )
    let failWrite = true
    const sync = new KanbanSync({
      ...f.deps,
      store: {
        ...f.deps.store,
        applyPlan: async (...args) => {
          if (failWrite) throw new Error('GitHub unavailable')
          await f.deps.store.applyPlan(...args)
        }
      }
    })
    await sync.onCardChanged(f.board.id, 1, true)
    expect(await f.read()).toMatchObject({ status: 'triage', needsAttention: true, labelWritePending: true })
    expect(await f.deps.repo.list(f.board.id, 25)).toContain(1)
    failWrite = false
    f.state.events.push(
      { id: 41, event: 'unlabeled', label: { name: 'ac/status:ready' }, actor: mallory },
      { id: 42, event: 'labeled', label: { name: 'ac/status:blocked' }, actor: mallory }
    )
    await sync.reconcileBoard(f.board.id)
    expect(f.writes.at(-1)).toMatchObject({ addLabels: ['ac/status:triage'], removeLabels: ['ac/status:blocked'] })
    expect(f.writes.at(-1)?.comment).not.toContain('held for a human')
    expect(await f.read()).toMatchObject({ status: 'triage', needsAttention: true, labelWritePending: false })
    expect(await f.deps.repo.list(f.board.id, 25)).not.toContain(1)
    f.state.issue.labels = ['ac/status:ready']
    f.state.events.push(
      { id: 43, event: 'unlabeled', label: { name: 'ac/status:blocked' }, actor: app },
      { id: 44, event: 'labeled', label: { name: 'ac/status:triage' }, actor: app },
      { id: 45, event: 'unlabeled', label: { name: 'ac/status:triage' }, actor: bob },
      { id: 46, event: 'labeled', label: { name: 'ac/status:ready' }, actor: bob }
    )
    await sync.onCardChanged(f.board.id, 1, true)
    expect(await f.read()).toMatchObject({
      status: 'ready',
      needsAttention: false,
      labelWritePending: false,
      syncEventCursor: 46n
    })
  })

  it('adopts a fresh writer edit instead of projecting over it during held-card repair (PG)', async () => {
    const f = await pg(
      { status: 'triage', syncEventCursor: 40n, needsAttention: true, labelWritePending: true },
      ['ac/status:ready'],
      [
        { id: 40, event: 'labeled', label: { name: 'ac/status:triage' }, actor: app },
        { id: 41, event: 'unlabeled', label: { name: 'ac/status:triage' }, actor: bob },
        { id: 42, event: 'labeled', label: { name: 'ac/status:ready' }, actor: bob }
      ]
    )
    await new KanbanSync(f.deps).reconcileBoard(f.board.id)
    expect(await f.read()).toMatchObject({
      status: 'ready',
      needsAttention: false,
      labelWritePending: false,
      syncEventCursor: 42n
    })
    expect(f.writes.at(-1)?.removeLabels).not.toContain('ac/status:ready')
  })

  it('acknowledges a successful fail-closed projection without consuming unattributed events (PG)', async () => {
    const now = new Date()
    const f = await pg(
      { status: 'ready', syncEventCursor: 40n, syncDeferredAt: new Date(now.getTime() - 11 * 60_000) },
      ['ac/status:blocked'],
      [{ id: 40, event: 'labeled', label: { name: 'ac/status:ready' }, actor: bob }],
      () => now
    )
    await new KanbanSync(f.deps).onCardChanged(f.board.id, 1, true)
    expect(await f.read()).toMatchObject({
      status: 'triage',
      needsAttention: true,
      labelWritePending: false,
      syncEventCursor: 40n
    })
    expect(f.writes.filter((p) => p.comment)).toHaveLength(1)
  })

  it.each(['defer', 'failClosed'] as const)(
    'a stale %s cannot undo another replica writer re-add (PG)',
    async (stage) => {
      const now = new Date()
      const old = { id: 40, event: 'labeled', label: { name: 'ac/status:ready' }, actor: bob } as LabelEvent
      const f = await pg(
        { status: 'ready', syncEventCursor: 40n, syncDeferredAt: new Date(now.getTime() - 11 * 60_000) },
        ['ac/status:blocked'],
        [old],
        () => now
      )
      const writerIssue = { ...f.state.issue, labels: ['ac/status:ready'] }
      const writerEvents: LabelEvent[] = [
        old,
        { id: 41, event: 'unlabeled', label: { name: 'ac/status:ready' }, actor: bob },
        { id: 42, event: 'labeled', label: { name: 'ac/status:ready' }, actor: bob }
      ]
      const writer = new KanbanSync({
        ...f.deps,
        store: {
          ...f.deps.store,
          readCard: async () => writerIssue,
          readLabelEvents: async () => writerEvents
        }
      })
      const staleRepo = new PgKanbanSyncRepo(prisma)
      let raced = false
      const newerEdit = async () => {
        raced = true
        await writer.onCardChanged(f.board.id, 1, true)
        expect(await f.read()).toMatchObject({ status: 'ready', syncEventCursor: 42n, syncDeferredAt: null })
      }
      if (stage === 'defer') {
        const defer = staleRepo.defer.bind(staleRepo)
        staleRepo.defer = async (...args) => {
          await newerEdit()
          return defer(...args)
        }
      } else {
        const failClosed = staleRepo.failClosed.bind(staleRepo)
        staleRepo.failClosed = async (...args) => {
          await newerEdit()
          return failClosed(...args)
        }
      }
      await new KanbanSync({ ...f.deps, repo: staleRepo }).onCardChanged(f.board.id, 1, true)
      expect(raced).toBe(true)
      expect(await f.read()).toMatchObject({
        status: 'ready',
        syncEventCursor: 42n,
        syncDeferredAt: null,
        needsAttention: false
      })
      expect(f.writes.some((p) => p.status === 'triage')).toBe(false)
    }
  )

  it('vera-r2: 5 the deferral bound fails closed to triage and a claim neither takes it nor clears the flag (PG)', async () => {
    const start = new Date()
    const f = await pg(
      {
        status: 'ready',
        syncEventCursor: 40n,
        syncDeferredAt: new Date(start.getTime() - 11 * 60_000),
        syncDeferralCount: 3
      },
      ['ac/status:blocked'],
      [{ id: 40, event: 'labeled', label: { name: 'ac/status:ready' }, actor: bob }]
    )
    await new KanbanSync(f.deps).onCardChanged(f.board.id, 1, true)
    expect(await f.claim()).toHaveLength(0)
    expect(await f.read()).toMatchObject({ status: 'triage', needsAttention: true })
  })
})
