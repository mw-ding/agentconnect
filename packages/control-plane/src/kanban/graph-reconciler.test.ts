// KanbanGraphReconciler over fakes: pure promotion rule, single label write, idempotency, dependents, lost CAS.
import { describe, expect, it, vi } from 'vitest'
import { OrgId } from '../domain/ids.js'
import type { KanbanBoardRecord, KanbanCardRecord } from '../persistence/ports.js'
import type { KanbanStatus, LabelPlan } from './card-state.js'
import type { CardGraph, CardIssue, CardLink } from './card-store.js'
import { KanbanGraphReconciler, planGraphPromotion, planSynthesis } from './graph-reconciler.js'

const BOARD: KanbanBoardRecord = {
  id: 'b1',
  orgId: OrgId('o'),
  name: 'eng',
  repoId: 42n,
  repoFullName: 'acme/web',
  synthesizerAgentId: null
}
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

describe('planSynthesis', () => {
  const completedSub = link(2, 'closed', 'completed')
  it('promotes a todo epic whose sub-issues all completed', () => {
    expect(
      planSynthesis({ status: 'todo' }, graph({ subIssues: [completedSub, link(3, 'closed', 'completed')] }), 'a1')
    ).toBe('promote')
  })
  it('holds when any sub-issue is open or closed not_planned', () => {
    expect(planSynthesis({ status: 'todo' }, graph({ subIssues: [completedSub, link(3, 'open')] }), 'a1')).toBe('none')
    expect(
      planSynthesis({ status: 'todo' }, graph({ subIssues: [completedSub, link(3, 'closed', 'not_planned')] }), 'a1')
    ).toBe('none')
  })
  it('holds on a truncated graph read', () => {
    expect(planSynthesis({ status: 'todo' }, graph({ subIssues: [completedSub], truncated: true }), 'a1')).toBe('none')
  })
  it('holds when no synthesizer is configured', () => {
    expect(planSynthesis({ status: 'todo' }, graph({ subIssues: [completedSub] }), null)).toBe('none')
  })
  it('holds when the issue is not an epic or not todo', () => {
    expect(planSynthesis({ status: 'todo' }, graph(), 'a1')).toBe('none')
    expect(planSynthesis({ status: 'ready' }, graph({ subIssues: [completedSub] }), 'a1')).toBe('none')
  })
})

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
  initial: Record<number, { status: KanbanStatus; labels: string[]; state?: CardIssue['state'] }>,
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
        leased: false,
        promotionPending: false,
        needsAttention: false
      }
    ])
  )
  const labels = new Map(Object.entries(initial).map(([n, c]) => [Number(n), c.labels]))
  const cards = {
    findByIssueNumber: vi.fn(async (_b: string, n: number) => db.get(n) ?? null),
    // The fake applies the ready CAS and the intent together, as the single DB write does.
    beginPromotion: vi.fn(async (id: string, _rev: bigint, ..._intent: unknown[]) => {
      if (!casResult) return false
      const card = [...db.values()].find((c) => c.id === id)!
      card.status = 'ready'
      card.promotionPending = true
      return true
    }),
    beginSynthesis: vi.fn(async (id: string, _rev: bigint, ..._intent: unknown[]) => {
      if (!casResult) return false
      const card = [...db.values()].find((c) => c.id === id)!
      card.status = 'ready'
      card.promotionPending = true
      return true
    }),
    revertPromotion: vi.fn(async (id: string) => {
      const card = [...db.values()].find((c) => c.id === id)!
      card.status = 'todo'
      card.promotionPending = true
      return true
    }),
    notePromotionPosted: vi.fn(async () => undefined),
    clearPromotionIntent: vi.fn(async (id: string) => {
      const card = [...db.values()].find((c) => c.id === id)!
      card.promotionPending = false
      return true
    })
  }
  const store = {
    readCard: vi.fn(async (_r: unknown, n: number): Promise<CardIssue | null> =>
      labels.has(n)
        ? {
            issueId: BigInt(n),
            nodeId: 'n',
            number: n,
            state: initial[n]!.state ?? 'open',
            stateReason: null,
            labels: labels.get(n)!
          }
        : null
    ),
    readGraph: vi.fn(async (_r: unknown, n: number) => graphs[n] ?? graph()),
    lastEventId: vi.fn(async () => 41),
    applyPlan: vi.fn(
      async (
        _r: unknown,
        n: number,
        _o: unknown,
        plan: LabelPlan,
        onLabelAdded?: (label: string) => void | Promise<void>
      ) => {
        const next = labels.get(n)!.filter((l) => !plan.removeLabels.includes(l))
        labels.set(n, [...next, ...plan.addLabels])
        if (plan.addLabels.includes('ac/status:ready')) await onLabelAdded?.('ac/status:ready')
      }
    )
  }
  const reconciler = new KanbanGraphReconciler({
    agentSlug: async () => 'synthesizer',
    cards,
    store,
    log: { debug: vi.fn() }
  })
  return { reconciler, cards, store, labels, db }
}

describe('KanbanGraphReconciler', () => {
  const todoLabels = ['ac/status:todo', 'ac/agent:eng']

  it('promotes once, swaps only the status label, and is a no-op the second time', async () => {
    const h = make({ 7: { status: 'todo', labels: todoLabels } })
    const g = graph({ blockedBy: [done] })
    await h.reconciler.apply(BOARD, REPO, 7, g)
    expect(h.db.get(7)!.status).toBe('ready')
    expect(h.store.readCard).toHaveBeenCalledOnce()
    expect(h.store.readCard.mock.invocationCallOrder[0]).toBeLessThan(
      h.cards.beginPromotion.mock.invocationCallOrder[0]!
    )
    expect(h.cards.beginPromotion.mock.invocationCallOrder[0]).toBeLessThan(
      h.store.applyPlan.mock.invocationCallOrder[0]!
    )
    // The cursor is read before the intent opens, and the intent before the POST, which is then noted as acknowledged.
    expect(h.store.lastEventId.mock.invocationCallOrder[0]).toBeLessThan(
      h.cards.beginPromotion.mock.invocationCallOrder[0]!
    )
    expect(h.cards.beginPromotion).toHaveBeenCalledWith('c7', 1n, 41n, expect.any(Date))
    expect(h.cards.notePromotionPosted).toHaveBeenCalledWith('c7')
    expect(h.cards.clearPromotionIntent).toHaveBeenCalledWith('c7')
    expect(h.store.applyPlan).toHaveBeenCalledOnce()
    expect(h.store.applyPlan.mock.calls[0]![2]).toBe(await h.store.readCard.mock.results[0]!.value)
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

  it.each<{ labels: string[]; state: CardIssue['state'] }>([
    { labels: ['ac/status:blocked', 'ac/agent:eng'], state: 'open' },
    { labels: ['ac/status:triage'], state: 'open' },
    { labels: ['ac/status:archived'], state: 'closed' },
    { labels: ['ac/status:todo', 'ac/status:blocked'], state: 'open' },
    { labels: ['ac/status:todo'], state: 'closed' },
    { labels: ['ac/agent:eng'], state: 'open' }
  ])('does not promote a DB todo with $labels on an $state issue', async ({ labels, state }) => {
    const h = make({ 7: { status: 'todo', labels, state } })
    await h.reconciler.apply(BOARD, REPO, 7, graph({ blockedBy: [done] }))
    expect(h.cards.beginPromotion).not.toHaveBeenCalled()
    expect(h.store.applyPlan).not.toHaveBeenCalled()
    expect(h.db.get(7)!.status).toBe('todo')
    expect(h.labels.get(7)).toEqual(labels)
  })

  it('does not promote a DB todo when the issue is missing', async () => {
    const h = make({ 7: { status: 'todo', labels: todoLabels } })
    h.store.readCard.mockResolvedValueOnce(null)
    await h.reconciler.apply(BOARD, REPO, 7, graph({ blockedBy: [done] }))
    expect(h.cards.beginPromotion).not.toHaveBeenCalled()
    expect(h.store.applyPlan).not.toHaveBeenCalled()
    expect(h.db.get(7)!.status).toBe('todo')
  })

  it.each(['todo', 'ready'] as const)('leaves a leased %s card and its labels to the dispatcher', async (status) => {
    const h = make({ 7: { status, labels: ['ac/status:todo', 'ac/status:ready'] } })
    h.db.get(7)!.leased = true
    await h.reconciler.apply(BOARD, REPO, 7, graph({ blockedBy: [done] }))
    expect(h.store.readCard).not.toHaveBeenCalled()
    expect(h.cards.beginPromotion).not.toHaveBeenCalled()
    expect(h.store.applyPlan).not.toHaveBeenCalled()
  })

  it('leaves a ready card alone when a human moved its label to blocked', async () => {
    const h = make({ 7: { status: 'ready', labels: ['ac/status:blocked', 'ac/agent:eng'] } })
    await h.reconciler.apply(BOARD, REPO, 7, graph({ blockedBy: [done] }))
    expect(h.cards.beginPromotion).not.toHaveBeenCalled()
    expect(h.store.applyPlan).not.toHaveBeenCalled()
    expect(h.labels.get(7)).toEqual(['ac/status:blocked', 'ac/agent:eng'])
  })

  it('does not re-add ready to a ready card whose only status label is todo', async () => {
    const h = make({ 7: { status: 'ready', labels: ['ac/status:todo'] } })
    await h.reconciler.apply(BOARD, REPO, 7, graph({ blockedBy: [done] }))
    expect(h.store.applyPlan).not.toHaveBeenCalled()
    expect(h.labels.get(7)).toEqual(['ac/status:todo'])
  })

  it('leaves the duplicate after a failed write for attributed dispatcher recovery', async () => {
    const h = make({ 7: { status: 'todo', labels: todoLabels } })
    h.store.applyPlan.mockImplementationOnce(async (_r, n) => {
      h.labels.set(n, [...h.labels.get(n)!, 'ac/status:ready'])
      throw new Error('boom')
    })
    const g = graph({ blockedBy: [done] })
    await expect(h.reconciler.apply(BOARD, REPO, 7, g)).rejects.toThrow('boom')
    expect(h.labels.get(7)).toEqual(['ac/status:todo', 'ac/agent:eng', 'ac/status:ready'])
    await h.reconciler.apply(BOARD, REPO, 7, g)
    expect(h.store.applyPlan).toHaveBeenCalledTimes(1)
    expect(h.db.get(7)!.status).toBe('todo')
    expect(h.labels.get(7)).toEqual(['ac/status:todo', 'ac/agent:eng', 'ac/status:ready'])
  })

  it('undoes the DB promotion when the ready label write fails, and retries only once recovery clears the intent', async () => {
    const h = make({ 7: { status: 'todo', labels: todoLabels } })
    h.store.applyPlan.mockRejectedValueOnce(new Error('label add failed'))
    const g = graph({ blockedBy: [done] })
    await expect(h.reconciler.apply(BOARD, REPO, 7, g)).rejects.toThrow('label add failed')
    expect(h.cards.beginPromotion.mock.calls.map((c) => c.slice(0, 2))).toEqual([['c7', 1n]])
    expect(h.cards.revertPromotion).toHaveBeenCalledWith('c7', 2n, expect.any(Date))
    expect(h.cards.notePromotionPosted).not.toHaveBeenCalled()
    expect(h.db.get(7)!.status).toBe('todo')
    await h.reconciler.apply(BOARD, REPO, 7, g)
    expect(h.cards.beginPromotion).toHaveBeenCalledOnce()
    h.db.get(7)!.promotionPending = false
    await h.reconciler.apply(BOARD, REPO, 7, g)
    expect(h.db.get(7)!.status).toBe('ready')
    expect(h.labels.get(7)).toEqual(['ac/agent:eng', 'ac/status:ready'])
  })

  // Vera's round-5 blockers 2 and 3: neither a flagged card nor an open intent is the reconciler's to (re)start.
  it.each([
    { name: 'awaits a human', flag: 'needsAttention' as const },
    { name: 'has a pending promotion', flag: 'promotionPending' as const }
  ])('opens no intent, reads nothing, and writes nothing for a todo card that $name', async ({ flag }) => {
    const h = make({ 7: { status: 'todo', labels: todoLabels } })
    h.db.get(7)![flag] = true
    await h.reconciler.apply(BOARD, REPO, 7, graph({ blockedBy: [done] }))
    expect(h.store.readCard).not.toHaveBeenCalled()
    expect(h.store.lastEventId).not.toHaveBeenCalled()
    expect(h.cards.beginPromotion).not.toHaveBeenCalled()
    expect(h.store.applyPlan).not.toHaveBeenCalled()
    expect(h.db.get(7)!.status).toBe('todo')
  })

  it('leaves a lone ready label on a todo card to attributed dispatcher recovery, even when unblocked', async () => {
    const h = make({ 7: { status: 'todo', labels: ['ac/status:ready', 'ac/agent:eng'] } })
    await h.reconciler.apply(BOARD, REPO, 7, graph({ blockedBy: [done] }))
    expect(h.cards.beginPromotion).not.toHaveBeenCalled()
    expect(h.store.applyPlan).not.toHaveBeenCalled()
    expect(h.db.get(7)!.status).toBe('todo')
  })

  it('leaves a DB todo with only a ready label alone while its blockers are open', async () => {
    const h = make({ 7: { status: 'todo', labels: ['ac/status:ready'] } })
    await h.reconciler.apply(BOARD, REPO, 7, graph({ blockedBy: [link(5, 'open')] }))
    expect(h.cards.beginPromotion).not.toHaveBeenCalled()
    expect(h.db.get(7)!.status).toBe('todo')
  })

  it('preserves conflicting ready and blocked labels for dispatcher mismatch recovery', async () => {
    const h = make({ 7: { status: 'ready', labels: ['ac/status:ready', 'ac/status:blocked', 'ac/agent:eng'] } })
    await h.reconciler.apply(BOARD, REPO, 7, graph())
    expect(h.store.applyPlan).not.toHaveBeenCalled()
    expect(h.labels.get(7)).toEqual(['ac/status:ready', 'ac/status:blocked', 'ac/agent:eng'])
  })

  it('does not strip todo from a ready card whose promotion intent is still open', async () => {
    const h = make({ 7: { status: 'ready', labels: ['ac/status:todo', 'ac/status:ready'] } })
    h.db.get(7)!.promotionPending = true
    await h.reconciler.apply(BOARD, REPO, 7, graph({ blockedBy: [done] }))
    expect(h.store.applyPlan).not.toHaveBeenCalled()
    expect(h.labels.get(7)).toEqual(['ac/status:todo', 'ac/status:ready'])
  })

  it('does not repair promotion residue on an issue a human closed', async () => {
    const h = make({ 7: { status: 'ready', labels: ['ac/status:todo', 'ac/status:ready'], state: 'closed' } })
    await h.reconciler.apply(BOARD, REPO, 7, graph())
    expect(h.store.applyPlan).not.toHaveBeenCalled()
  })

  it('does not write for a ready card whose only status label is ready', async () => {
    const h = make({ 7: { status: 'ready', labels: ['ac/status:ready', 'ac/agent:eng'] } })
    await h.reconciler.apply(BOARD, REPO, 7, graph())
    expect(h.store.applyPlan).not.toHaveBeenCalled()
  })

  it('skips a dependent whose repo is unknown', async () => {
    const h = make({ 8: { status: 'todo', labels: todoLabels } })
    await h.reconciler.apply(BOARD, REPO, 7, graph({ blocking: [{ ...link(8, 'open'), repoId: null }] }))
    expect(h.store.readGraph).not.toHaveBeenCalled()
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

  it('opens no intent and writes nothing when the pre-POST cursor read fails', async () => {
    const h = make({ 7: { status: 'todo', labels: todoLabels } })
    h.store.lastEventId.mockRejectedValueOnce(new Error('events 503'))
    await expect(h.reconciler.apply(BOARD, REPO, 7, graph({ blockedBy: [done] }))).rejects.toThrow('events 503')
    expect(h.cards.beginPromotion).not.toHaveBeenCalled()
    expect(h.store.applyPlan).not.toHaveBeenCalled()
    expect(h.db.get(7)!.status).toBe('todo')
  })

  it('writes no labels when the CAS is lost', async () => {
    const h = make({ 7: { status: 'todo', labels: todoLabels } }, {}, false)
    await h.reconciler.apply(BOARD, REPO, 7, graph({ blockedBy: [done] }))
    expect(h.store.applyPlan).not.toHaveBeenCalled()
  })

  it('synthesizes a todo epic by assigning the synthesizer and opening the same intent', async () => {
    const board = { ...BOARD, synthesizerAgentId: 'a1' }
    const h = make({ 7: { status: 'todo', labels: todoLabels } })
    await h.reconciler.apply(board, REPO, 7, graph({ subIssues: [link(2, 'closed', 'completed')] }))
    expect(h.cards.beginSynthesis).toHaveBeenCalledWith('c7', 1n, 41n, expect.any(Date), 'a1')
    expect(h.labels.get(7)).toContain('ac/agent:synthesizer')
    expect(h.cards.beginPromotion).not.toHaveBeenCalled()
    expect(h.db.get(7)!.status).toBe('ready')
    expect(h.labels.get(7)).toEqual(['ac/agent:synthesizer', 'ac/status:ready'])
  })

  it('re-evaluates the parent epic when a sub-issue closes', async () => {
    const board = { ...BOARD, synthesizerAgentId: 'a1' }
    const h = make(
      { 9: { status: 'running', labels: ['ac/status:running'] }, 7: { status: 'todo', labels: todoLabels } },
      { 7: graph({ subIssues: [link(9, 'closed', 'completed'), link(10, 'closed', 'completed')] }) }
    )
    await h.reconciler.apply(board, REPO, 9, graph({ parent: link(7, 'open') }))
    expect(h.store.readGraph).toHaveBeenCalledWith(REPO, 7)
    expect(h.db.get(7)!.status).toBe('ready')
    expect(h.cards.beginSynthesis).toHaveBeenCalledWith('c7', 1n, 41n, expect.any(Date), 'a1')
    expect(h.labels.get(7)).toContain('ac/agent:synthesizer')
  })
})
