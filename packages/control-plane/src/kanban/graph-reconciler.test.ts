// KanbanGraphReconciler over fakes: pure promotion rule, single label write, idempotency, dependents, lost CAS.
import { describe, expect, it, vi } from 'vitest'
import { OrgId } from '../domain/ids.js'
import type { KanbanBoardRecord, KanbanCardRecord } from '../persistence/ports.js'
import type { KanbanStatus } from './card-state.js'
import type { CardGraph, CardIssue, CardLink } from './card-store.js'
import { KanbanGraphReconciler, planGraphPromotion } from './graph-reconciler.js'

const BOARD: KanbanBoardRecord = { id: 'b1', orgId: OrgId('o'), name: 'eng', repoId: 42n, repoFullName: 'acme/web' }
const REPO = { installationId: 1n, repoId: 42n, repoFullName: 'acme/web' }

const link = (number: number, state: 'open' | 'closed', stateReason: string | null = null): CardLink => ({
  issueId: BigInt(number),
  number,
  repoId: 42n,
  state,
  stateReason
})
const graph = (over: Partial<CardGraph> = {}): CardGraph => ({
  parent: null,
  subIssues: [],
  blockedBy: [],
  blocking: [],
  truncated: false,
  ...over
})
const done = link(1, 'closed', 'completed')

describe('planGraphPromotion', () => {
  it('holds while a blocker is open', () => {
    expect(planGraphPromotion('todo', graph({ blockedBy: [done, link(2, 'open')] }))).toBe('none')
  })
  it('holds for a blocker closed as not_planned', () => {
    expect(planGraphPromotion('todo', graph({ blockedBy: [link(2, 'closed', 'not_planned')] }))).toBe('none')
  })
  it('promotes when every blocker completed', () => {
    expect(planGraphPromotion('todo', graph({ blockedBy: [done, link(2, 'closed', 'completed')] }))).toBe('promote')
  })
  it('holds on a truncated graph', () => {
    expect(planGraphPromotion('todo', graph({ blockedBy: [done], truncated: true }))).toBe('none')
  })
  it('leaves a todo with no dependencies to the orchestrator', () => {
    expect(planGraphPromotion('todo', graph())).toBe('none')
  })
  it('never acts on a card that is not todo', () => {
    for (const s of ['ready', 'running', 'blocked', 'done'] as KanbanStatus[]) {
      expect(planGraphPromotion(s, graph({ blockedBy: [done] }))).toBe('none')
    }
  })
})

function make(
  initial: Record<number, { status: KanbanStatus; labels: string[] }>,
  graphs: Record<number, CardGraph> = {},
  casResult = true
) {
  const db = new Map<number, KanbanCardRecord>(
    Object.entries(initial).map(([n, c]) => [
      Number(n),
      {
        id: `c${n}`,
        boardId: 'b1',
        issueId: BigInt(n),
        issueNumber: Number(n),
        status: c.status,
        stateRevision: 1n,
        leased: false
      }
    ])
  )
  const labels = new Map(Object.entries(initial).map(([n, c]) => [Number(n), c.labels]))
  const cards = {
    findByIssueNumber: vi.fn(async (_b: string, n: number) => db.get(n) ?? null),
    casStatus: vi.fn(async (id: string, _rev: bigint, to: KanbanStatus) => {
      if (!casResult) return false
      const card = [...db.values()].find((c) => c.id === id)!
      card.status = to
      return true
    })
  }
  const store = {
    readCard: vi.fn(async (_r: unknown, n: number): Promise<CardIssue | null> =>
      labels.has(n)
        ? { issueId: BigInt(n), nodeId: 'n', number: n, state: 'open', stateReason: null, labels: labels.get(n)! }
        : null
    ),
    readGraph: vi.fn(async (_r: unknown, n: number) => graphs[n] ?? graph()),
    applyPlan: vi.fn(
      async (_r: unknown, n: number, _o: unknown, plan: { addLabels: string[]; removeLabels: string[] }) => {
        const next = labels.get(n)!.filter((l) => !plan.removeLabels.includes(l))
        labels.set(n, [...next, ...plan.addLabels])
      }
    )
  }
  const reconciler = new KanbanGraphReconciler({ cards, store, log: { debug: vi.fn() } })
  return { reconciler, cards, store, labels, db }
}

describe('KanbanGraphReconciler', () => {
  const todoLabels = ['ac/status:todo', 'ac/agent:eng']

  it('promotes once, swaps only the status label, and is a no-op the second time', async () => {
    const h = make({ 7: { status: 'todo', labels: todoLabels } })
    const g = graph({ blockedBy: [done] })
    await h.reconciler.apply(BOARD, REPO, 7, g)
    expect(h.db.get(7)!.status).toBe('ready')
    expect(h.store.applyPlan).toHaveBeenCalledOnce()
    const plan = h.store.applyPlan.mock.calls[0]![3]
    expect(plan).toMatchObject({
      outcome: 'accepted',
      status: 'ready',
      addLabels: ['ac/status:ready'],
      removeLabels: ['ac/status:todo']
    })
    expect(plan.comment).toBeUndefined()
    expect(plan.issueState).toBeUndefined()
    expect(h.labels.get(7)).toEqual(['ac/agent:eng', 'ac/status:ready'])
    await h.reconciler.apply(BOARD, REPO, 7, g)
    expect(h.store.applyPlan).toHaveBeenCalledOnce()
  })

  it('finishes the label write for a ready card whose labels still say todo', async () => {
    const h = make({ 7: { status: 'ready', labels: todoLabels } })
    await h.reconciler.apply(BOARD, REPO, 7, graph({ blockedBy: [done] }))
    expect(h.cards.casStatus).not.toHaveBeenCalled()
    expect(h.store.applyPlan).toHaveBeenCalledOnce()
    expect(h.labels.get(7)).toContain('ac/status:ready')
  })

  it('promotes a dependent named by the blocking list', async () => {
    const h = make(
      { 5: { status: 'running', labels: ['ac/status:running'] }, 7: { status: 'todo', labels: todoLabels } },
      { 7: graph({ blockedBy: [link(5, 'closed', 'completed')] }) }
    )
    await h.reconciler.apply(BOARD, REPO, 5, graph({ blocking: [link(7, 'open')] }))
    expect(h.store.readGraph).toHaveBeenCalledWith(REPO, 7)
    expect(h.db.get(7)!.status).toBe('ready')
    expect(h.db.get(5)!.status).toBe('running')
    expect(h.store.applyPlan).toHaveBeenCalledOnce()
  })

  it('skips cards missing from the board and cross-repo dependents', async () => {
    const h = make({})
    await h.reconciler.apply(BOARD, REPO, 7, graph({ blocking: [{ ...link(8, 'open'), repoId: 99n }] }))
    expect(h.store.readGraph).not.toHaveBeenCalled()
    expect(h.store.applyPlan).not.toHaveBeenCalled()
  })

  it('writes no labels when the CAS is lost', async () => {
    const h = make({ 7: { status: 'todo', labels: todoLabels } }, {}, false)
    await h.reconciler.apply(BOARD, REPO, 7, graph({ blockedBy: [done] }))
    expect(h.store.applyPlan).not.toHaveBeenCalled()
  })
})
