// PgKanbanCardRepo upsert, slug resolver, and assignee writes (issue #2 M1) against real Postgres: idempotent and race-safe.
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { attestHumanAuthority } from '../../src/kanban/human-authority.js'
import { cardIdempotencyKey } from '../../src/kanban/card-key.js'
import { PgKanbanCardRepo } from '../../src/persistence/repositories/kanban.repo.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import { KanbanCardUpsertError, type KanbanCardUpsertInput } from '../../src/persistence/ports.js'

const D1 = 'd1111111-1111-4111-8111-111111111111'
const A1 = 'a1111111-1111-4111-8111-111111111111'
const A2 = 'a2222222-2222-4222-8222-222222222222'
const OTHER_ORG_AGENT = 'a3333333-3333-4333-8333-333333333333'
const OTHER_ORG = 'org-kanban-other'
const NOW = new Date('2026-10-15T12:00:00.000Z')

const repo = new PgKanbanCardRepo(prisma)

async function seedBoard(): Promise<string> {
  await seedDaemon(prisma, D1, { sessionEpoch: 7n })
  await seedAgent(prisma, A1, { daemonId: D1, name: 'worker-one' })
  await seedAgent(prisma, A2, { daemonId: D1, name: 'worker-two' })
  const board = await prisma.kanbanBoard.create({
    data: { orgId: DEFAULT_ORG_ID, name: 'eng', repoId: 4242n, repoFullName: 'acme/web' }
  })
  return board.id
}

async function seedOtherOrgAgent(): Promise<void> {
  await prisma.org.create({ data: { id: OTHER_ORG, name: 'Other', slug: 'other-kanban' } })
  await seedAgent(prisma, OTHER_ORG_AGENT, { daemonId: D1, name: 'worker-one', orgId: OTHER_ORG })
}

function issue(boardId: string, n: number, extra: Partial<KanbanCardUpsertInput> = {}): KanbanCardUpsertInput {
  return { boardId, expectedRepoId: 4242n, issueId: BigInt(900_000 + n), issueNumber: n, source: 'import', ...extra }
}

/** The import path's live-verified human writer, which any status past todo requires. */
const WRITER = { humanAuthority: attestHumanAuthority('maintainer', 'write') }

describe('PgKanbanCardRepo.upsertCard (real Postgres)', () => {
  it('creates once in triage by default and returns the same row on every redelivery', async () => {
    const boardId = await seedBoard()
    const first = await repo.upsertCard(issue(boardId, 1, { issueNodeId: 'I_1' }))
    expect(first).toMatchObject({ created: true, matchedBy: 'created', card: { status: 'triage', issueNumber: 1 } })
    const again = await repo.upsertCard(issue(boardId, 1, { status: 'ready', assigneeAgentId: A1, ...WRITER }))
    expect(again).toMatchObject({ created: false, matchedBy: 'issue' })
    // An existing card keeps its status and assignee; upsert never overwrites.
    expect(again.card).toEqual(first.card)
    expect(await prisma.kanbanCard.count({ where: { boardId } })).toBe(1)
    const audit = await prisma.auditEvent.findMany({ where: { kind: 'kanban_card_change' } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      orgId: DEFAULT_ORG_ID,
      details: { boardId, cardId: first.card.id, issueNumber: 1, change: 'created', to: 'triage', source: 'import' }
    })
  })

  it('applies the initial status, assignee and priority on create, and always inherits the board mode', async () => {
    const boardId = await seedBoard()
    const { card } = await repo.upsertCard(
      issue(boardId, 2, { status: 'ready', assigneeAgentId: A1, priority: 5, ...WRITER })
    )
    expect(card).toMatchObject({ status: 'ready', assigneeAgentId: A1, priority: 5, mode: null })
  })

  it('never duplicates under concurrent upserts of one issue', async () => {
    const boardId = await seedBoard()
    const results = await Promise.all(Array.from({ length: 8 }, () => repo.upsertCard(issue(boardId, 3))))
    expect(results.filter((r) => r.created)).toHaveLength(1)
    expect(new Set(results.map((r) => r.card.id)).size).toBe(1)
    expect(await prisma.kanbanCard.count({ where: { boardId } })).toBe(1)
    expect(await prisma.auditEvent.count({ where: { kind: 'kanban_card_change' } })).toBe(1)
  })

  it('returns the card filed under an idempotency key, even for a different issue', async () => {
    const boardId = await seedBoard()
    const key = cardIdempotencyKey({ epic: '100', step: 'build', spec: 'add the API' })
    const first = await repo.upsertCard(issue(boardId, 4, { idempotencyKey: key, source: 'orchestrator' }))
    expect(first).toMatchObject({ created: true, card: { idempotencyKey: key } })
    // A retried create that filed a second issue gets the original card back and can close its duplicate.
    const retry = await repo.upsertCard(issue(boardId, 5, { idempotencyKey: key, source: 'orchestrator' }))
    expect(retry).toMatchObject({
      created: false,
      matchedBy: 'idempotency_key',
      card: { id: first.card.id, issueNumber: 4 }
    })
    expect(await repo.findByIdempotencyKey(boardId, key)).toEqual(first.card)
    expect(await prisma.kanbanCard.count({ where: { boardId } })).toBe(1)
  })

  it('serializes concurrent keyed creates for different issues onto one card', async () => {
    const boardId = await seedBoard()
    const key = cardIdempotencyKey({ epic: '100', step: 'race', spec: 'x' })
    const results = await Promise.all(
      [6, 7, 8, 9].map((n) => repo.upsertCard(issue(boardId, n, { idempotencyKey: key, source: 'orchestrator' })))
    )
    expect(results.filter((r) => r.created)).toHaveLength(1)
    expect(new Set(results.map((r) => r.card.id)).size).toBe(1)
    expect(await prisma.kanbanCard.count({ where: { boardId } })).toBe(1)
  })

  it('attaches a key to an imported card for the same issue', async () => {
    const boardId = await seedBoard()
    const imported = await repo.upsertCard(issue(boardId, 10))
    const key = cardIdempotencyKey({ epic: '1', step: 's', spec: 'p' })
    const adopted = await repo.upsertCard(issue(boardId, 10, { idempotencyKey: key, source: 'orchestrator' }))
    expect(adopted).toMatchObject({
      created: false,
      matchedBy: 'issue',
      card: { id: imported.card.id, idempotencyKey: key }
    })
    expect(await repo.findByIdempotencyKey(boardId, key)).toMatchObject({ id: imported.card.id })
  })

  it('refuses a second key for an issue that already carries one', async () => {
    const boardId = await seedBoard()
    const k1 = cardIdempotencyKey({ epic: '1', step: 'a', spec: 'p' })
    const k2 = cardIdempotencyKey({ epic: '1', step: 'b', spec: 'p' })
    await repo.upsertCard(issue(boardId, 11, { idempotencyKey: k1 }))
    await expect(repo.upsertCard(issue(boardId, 11, { idempotencyKey: k2 }))).rejects.toMatchObject({
      code: 'key_conflict'
    })
    expect(await prisma.kanbanCard.count({ where: { boardId } })).toBe(1)
  })

  it('refuses an unknown board, a running initial status, and an assignee from another org', async () => {
    const boardId = await seedBoard()
    await seedOtherOrgAgent()
    await expect(repo.upsertCard(issue('00000000-0000-4000-8000-000000000000', 12))).rejects.toBeInstanceOf(
      KanbanCardUpsertError
    )
    await expect(repo.upsertCard(issue(boardId, 12, { status: 'running' as never }))).rejects.toMatchObject({
      code: 'invalid_status'
    })
    await expect(repo.upsertCard(issue(boardId, 12, { assigneeAgentId: OTHER_ORG_AGENT }))).rejects.toMatchObject({
      code: 'agent_not_in_org'
    })
    expect(await prisma.kanbanCard.count({ where: { boardId } })).toBe(0)
  })

  it('composes inside an ambient transaction without aborting it on a conflict', async () => {
    const boardId = await seedBoard()
    await repo.upsertCard(issue(boardId, 13))
    const result = await prisma.$transaction(async (tx) => {
      const inner = new PgKanbanCardRepo(tx)
      const again = await inner.upsertCard(issue(boardId, 13))
      // The transaction is still usable after the skipped insert.
      await tx.kanbanCard.count()
      return again
    })
    expect(result.created).toBe(false)
  })
})

describe('PgKanbanCardRepo.resolveAgentSlug (real Postgres)', () => {
  it('maps a slug to the agent of that org only', async () => {
    await seedBoard()
    await seedOtherOrgAgent()
    expect(await repo.resolveAgentSlug(DEFAULT_ORG_ID, 'worker-one')).toBe(A1)
    expect(await repo.resolveAgentSlug(DEFAULT_ORG_ID, 'Worker-One')).toBe(A1)
    expect(await repo.resolveAgentSlug(OTHER_ORG, 'worker-one')).toBe(OTHER_ORG_AGENT)
    expect(await repo.resolveAgentSlug(DEFAULT_ORG_ID, 'nobody')).toBeNull()
    expect(await repo.resolveAgentSlug(OTHER_ORG, 'worker-two')).toBeNull()
  })
})

describe('PgKanbanCardRepo.setAssignee (real Postgres)', () => {
  const dispatch = new PgKanbanDispatchRepo(prisma)

  async function leasedCard(boardId: string) {
    const { card } = await repo.upsertCard(issue(boardId, 20, { status: 'ready', assigneeAgentId: A1, ...WRITER }))
    const [lease] = (await dispatch.claim(boardId, { now: NOW, isDaemonLive: () => true })).leases
    expect(lease).toBeDefined()
    return { card, lease: lease! }
  }

  it('assigns an unleased card, bumps the dispatch generation, and audits it', async () => {
    const boardId = await seedBoard()
    const { card } = await repo.upsertCard(issue(boardId, 21))
    const result = await repo.setAssignee({ cardId: card.id, agentId: A1, now: NOW, source: 'label' })
    expect(result).toMatchObject({ ok: true, changed: true, previousAgentId: null, revokedLease: null })
    if (!result.ok) throw new Error('unreachable')
    expect(result.card).toMatchObject({
      assigneeAgentId: A1,
      status: 'triage',
      dispatchRevision: card.dispatchRevision + 1n,
      stateRevision: card.stateRevision
    })
    const noop = await repo.setAssignee({ cardId: card.id, agentId: A1, now: NOW, source: 'label' })
    expect(noop).toMatchObject({ ok: true, changed: false })
    expect(await prisma.auditEvent.count({ where: { kind: 'kanban_card_change' } })).toBe(2)
  })

  it('refuses a stale dispatch revision, an unknown card, and an agent outside the org', async () => {
    const boardId = await seedBoard()
    await seedOtherOrgAgent()
    const { card } = await repo.upsertCard(issue(boardId, 22))
    await expect(
      repo.setAssignee({ cardId: card.id, agentId: A1, expectedDispatchRevision: 99n, now: NOW, source: 't' })
    ).resolves.toEqual({ ok: false, reason: 'stale' })
    await expect(
      repo.setAssignee({ cardId: '00000000-0000-4000-8000-000000000000', agentId: A1, now: NOW, source: 't' })
    ).resolves.toEqual({ ok: false, reason: 'not_found' })
    await expect(
      repo.setAssignee({ cardId: card.id, agentId: OTHER_ORG_AGENT, now: NOW, source: 't' })
    ).resolves.toEqual({ ok: false, reason: 'agent_not_in_org' })
    expect((await repo.getCard(card.id))?.assigneeAgentId).toBeNull()
  })

  it('refuses to move a leased card by default and leaves the lease alone', async () => {
    const boardId = await seedBoard()
    const { card, lease } = await leasedCard(boardId)
    const result = await repo.setAssignee({ cardId: card.id, agentId: A2, now: NOW, source: 'label' })
    expect(result).toMatchObject({ ok: false, reason: 'leased', lease: { leaseId: lease.leaseId, agentId: A1 } })
    expect(await prisma.kanbanRun.count({ where: { cardId: card.id, endedAt: null } })).toBe(1)
    expect((await repo.getCard(card.id))?.assigneeAgentId).toBe(A1)
  })

  it('kills the lease on revoke: run reclaimed, card back to ready, old holder fenced', async () => {
    const boardId = await seedBoard()
    const { card, lease } = await leasedCard(boardId)
    const before = (await repo.getCard(card.id))!
    expect(before.status).toBe('running')
    const result = await repo.setAssignee({
      cardId: card.id,
      agentId: A2,
      onLease: 'revoke',
      now: NOW,
      source: 'label'
    })
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      previousAgentId: A1,
      revokedLease: { leaseId: lease.leaseId, agentId: A1, daemonId: D1 }
    })
    const after = (await repo.getCard(card.id))!
    expect(after).toMatchObject({
      status: 'ready',
      assigneeAgentId: A2,
      dispatchRevision: before.dispatchRevision + 1n,
      stateRevision: before.stateRevision + 1n
    })
    const run = await prisma.kanbanRun.findUniqueOrThrow({ where: { leaseId: lease.leaseId } })
    expect(run).toMatchObject({ outcome: 'reclaimed', reasonCode: 'reassigned' })
    expect(run.endedAt).not.toBeNull()
    const failures = await prisma.kanbanCard.findUniqueOrThrow({
      where: { id: card.id },
      select: { consecutiveFailures: true }
    })
    expect(failures.consecutiveFailures).toBe(0)
    // The superseded holder's heartbeat is rejected.
    expect(
      await dispatch.heartbeat(
        D1,
        7n,
        [{ leaseId: lease.leaseId, cardId: card.id, dispatchRevision: lease.dispatchRevision }],
        NOW
      )
    ).toEqual([lease.leaseId])
    const audit = await prisma.auditEvent.findFirst({
      where: { kind: 'kanban_card_change', message: { contains: 'assignee' } }
    })
    expect(audit?.details).toMatchObject({
      fromAgentId: A1,
      toAgentId: A2,
      revokedLeaseId: lease.leaseId,
      from: 'running',
      to: 'ready'
    })
  })

  it('keeps a leased card untouched when the assignee does not change', async () => {
    const boardId = await seedBoard()
    const { card, lease } = await leasedCard(boardId)
    const result = await repo.setAssignee({
      cardId: card.id,
      agentId: A1,
      onLease: 'revoke',
      now: NOW,
      source: 'label'
    })
    expect(result).toMatchObject({ ok: true, changed: false, revokedLease: null })
    expect(await prisma.kanbanRun.findUniqueOrThrow({ where: { leaseId: lease.leaseId } })).toMatchObject({
      endedAt: null
    })
  })
})
