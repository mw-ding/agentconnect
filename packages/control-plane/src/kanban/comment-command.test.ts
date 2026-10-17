// KanbanCommentCommands over fakes: authz outcomes, one recorded effect per comment, settle-on-redelivery, and stale CAS retry.
import { describe, expect, it, vi } from 'vitest'
import type { KanbanDoorbellCommand } from '@agentconnect.md/protocol'
import { OrgId } from '../domain/ids.js'
import type { RepoPermissionLevel } from '../github/repo-permission.js'
import type {
  KanbanBoardRecord,
  KanbanCardRecord,
  KanbanCommandInput,
  KanbanCommandRecord,
  KanbanCommandRecordResult
} from '../persistence/ports.js'
import { statusLabel, type KanbanStatus, type LabelPlan, type ObservedIssue } from './card-state.js'
import type { CardIssue } from './card-store.js'
import { KanbanCommentCommands } from './comment-command.js'
import { isAttestedHumanAuthority } from './human-authority.js'

const BOARD: KanbanBoardRecord = { id: 'b1', orgId: OrgId('org'), name: 'eng', repoId: 42n, repoFullName: 'acme/web' }
const REPO = { installationId: 1n, repoId: 42n, repoFullName: 'acme/web' }

const cmd = (name: KanbanDoorbellCommand['name'], over: Partial<KanbanDoorbellCommand['sender']> = {}) => ({
  name,
  commentId: '9001',
  sender: { login: 'alice', type: 'User', ...over }
})

function issueFor(status: KanbanStatus): CardIssue {
  const closed = status === 'done' || status === 'archived'
  return {
    issueId: 5n,
    nodeId: 'I_5',
    number: 7,
    labels: [statusLabel(status)],
    state: closed ? 'closed' : 'open',
    stateReason: status === 'done' ? 'completed' : status === 'archived' ? 'not_planned' : null
  }
}

function make(
  opts: {
    status?: KanbanStatus
    leased?: boolean
    level?: RepoPermissionLevel | Error
    staleTimes?: number
    applyFails?: number
  } = {}
) {
  const card: KanbanCardRecord = {
    id: 'c1',
    boardId: BOARD.id,
    issueId: 5n,
    issueNumber: 7,
    status: opts.status ?? 'blocked',
    stateRevision: 3n,
    leased: opts.leased ?? false,
    promotionPending: false,
    needsAttention: false
  }
  const ledger = new Map<bigint, KanbanCommandRecord>()
  const inputs: KanbanCommandInput[] = []
  let stale = opts.staleTimes ?? 0
  let applyFails = opts.applyFails ?? 0
  const cards = {
    findByIssueNumber: vi.fn(async (_b: string, n: number) => (n === 7 ? { ...card } : null)),
    getCommand: vi.fn(async (_b: string, id: bigint) => ledger.get(id) ?? null),
    recordCommand: vi.fn(async (input: KanbanCommandInput): Promise<KanbanCommandRecordResult> => {
      inputs.push(input)
      const existing = ledger.get(input.commentId)
      if (existing) return { kind: 'duplicate', record: existing }
      if (stale > 0) {
        stale -= 1
        card.stateRevision += 1n
        return { kind: 'stale' }
      }
      const record: KanbanCommandRecord = {
        id: `cmd-${input.commentId}`,
        boardId: input.boardId,
        cardId: input.cardId,
        commentId: input.commentId,
        command: input.command,
        actorLogin: input.actorLogin,
        outcome: input.to ? 'applied' : input.refusal!,
        fromStatus: input.from,
        toStatus: input.to ?? null,
        settledAt: null
      }
      ledger.set(input.commentId, record)
      if (input.to) {
        card.status = input.to
        card.stateRevision += 1n
      }
      return { kind: 'recorded', record }
    }),
    settleCommand: vi.fn(async (id: string) => {
      for (const r of ledger.values()) if (r.id === id) r.settledAt = new Date()
    })
  }
  let observed: CardIssue = issueFor(card.status)
  const plans: LabelPlan[] = []
  const store = {
    readCard: vi.fn(async () => observed),
    applyPlan: vi.fn(async (_r: unknown, _n: number, _o: ObservedIssue, plan: LabelPlan) => {
      if (applyFails > 0) {
        applyFails -= 1
        throw new Error('github 502')
      }
      plans.push(plan)
      if (plan.addLabels.length > 0) observed = { ...observed, labels: plan.addLabels, state: 'open' }
    })
  }
  const permission = vi.fn(async () => {
    const level = opts.level ?? 'write'
    if (level instanceof Error) throw level
    return level
  })
  const onApplied = vi.fn()
  const handler = new KanbanCommentCommands({
    cards,
    store,
    permissions: { permission },
    appSlug: 'agentconnect',
    onApplied,
    log: { info: vi.fn(), warn: vi.fn() }
  })
  return { handler, card, cards, store, plans, permission, onApplied, ledger, inputs }
}

describe('KanbanCommentCommands', () => {
  it('applies /kanban unblock: one recorded move with attested authority, the ready labels, a settle, and a poke', async () => {
    const h = make({ status: 'blocked' })
    expect(await h.handler.handle(BOARD, REPO, 7, cmd('unblock'))).toBe('applied')
    expect(h.inputs).toHaveLength(1)
    expect(h.inputs[0]).toMatchObject({ from: 'blocked', to: 'ready', expectedStateRevision: 3n, actorLogin: 'alice' })
    expect(isAttestedHumanAuthority(h.inputs[0]!.humanAuthority)).toBe(true)
    expect(h.plans).toEqual([
      expect.objectContaining({ addLabels: [statusLabel('ready')], removeLabels: [statusLabel('blocked')] })
    ])
    expect(h.plans[0]!.comment).toBeUndefined()
    expect(h.ledger.get(9001n)?.settledAt).toBeInstanceOf(Date)
    expect(h.onApplied).toHaveBeenCalledOnce()
  })

  it('applies /kanban reopen on a done card by reopening the issue', async () => {
    const h = make({ status: 'done' })
    expect(await h.handler.handle(BOARD, REPO, 7, cmd('reopen'))).toBe('applied')
    expect(h.plans[0]?.issueState).toEqual({ state: 'open' })
  })

  it('refuses a command that does not apply with exactly one body-free comment and no move', async () => {
    const h = make({ status: 'running', leased: true })
    expect(await h.handler.handle(BOARD, REPO, 7, cmd('unblock'))).toBe('wrong_status')
    expect(h.card.status).toBe('running')
    expect(h.plans).toHaveLength(1)
    expect(h.plans[0]).toMatchObject({ addLabels: [], removeLabels: [] })
    expect(h.plans[0]!.comment).toContain('`/kanban unblock` was not applied (wrong_status)')
    expect(h.onApplied).not.toHaveBeenCalled()
  })

  it('refuses /kanban ready on a leased card (it cannot be readied while an agent holds it)', async () => {
    // A leased todo card does not occur in practice; this pins the lease rule in the planner path.
    const h = make({ status: 'todo', leased: true })
    expect(await h.handler.handle(BOARD, REPO, 7, cmd('ready'))).toBe('leased')
    expect(h.plans[0]!.comment).toContain('(leased)')
  })

  it.each(['triage', 'read', 'none'] as const)('refuses a %s sender with one no_write comment', async (level) => {
    const h = make({ status: 'blocked', level })
    expect(await h.handler.handle(BOARD, REPO, 7, cmd('unblock'))).toBe('no_write')
    expect(h.card.status).toBe('blocked')
    expect(h.store.readCard).toHaveBeenCalledTimes(1)
    expect(h.plans.map((p) => p.comment)).toEqual([expect.stringContaining('(no_write)')])
  })

  it.each([
    ['this App', { login: 'agentconnect[bot]', type: 'Bot' }],
    ['another bot', { login: 'ci[bot]', type: 'Bot' }],
    ['an organization', { login: 'acme', type: 'Organization' }]
  ])('ignores %s silently, with no lookup, record, or comment (B8)', async (_name, sender) => {
    const h = make({ status: 'blocked' })
    expect(await h.handler.handle(BOARD, REPO, 7, cmd('unblock', sender))).toBe('ignored')
    expect(h.permission).not.toHaveBeenCalled()
    expect(h.cards.recordCommand).not.toHaveBeenCalled()
    expect(h.plans).toEqual([])
  })

  it('throws on a failed permission lookup so the GUID stays unlanded for redelivery', async () => {
    const h = make({ level: new Error('github 502') })
    await expect(h.handler.handle(BOARD, REPO, 7, cmd('unblock'))).rejects.toThrow('github 502')
    expect(h.cards.recordCommand).not.toHaveBeenCalled()
  })

  it('a redelivery of a settled comment does nothing at all', async () => {
    const h = make({ status: 'blocked' })
    await h.handler.handle(BOARD, REPO, 7, cmd('unblock'))
    expect(await h.handler.handle(BOARD, REPO, 7, cmd('unblock'))).toBe('duplicate')
    expect(h.cards.recordCommand).toHaveBeenCalledOnce()
    expect(h.plans).toHaveLength(1)
    expect(h.permission).toHaveBeenCalledOnce()
  })

  it('a label write that failed after the commit is retried by the redelivery, not re-decided', async () => {
    const h = make({ status: 'blocked', applyFails: 1 })
    await expect(h.handler.handle(BOARD, REPO, 7, cmd('unblock'))).rejects.toThrow('github 502')
    expect(h.card.status).toBe('ready')
    expect(h.ledger.get(9001n)?.settledAt).toBeNull()
    expect(await h.handler.handle(BOARD, REPO, 7, cmd('unblock'))).toBe('duplicate')
    expect(h.plans).toEqual([expect.objectContaining({ addLabels: [statusLabel('ready')] })])
    expect(h.ledger.get(9001n)?.settledAt).toBeInstanceOf(Date)
    expect(h.cards.recordCommand).toHaveBeenCalledOnce()
  })

  it('a refusal comment that failed is posted by the redelivery, exactly once', async () => {
    const h = make({ status: 'ready', applyFails: 1 })
    await expect(h.handler.handle(BOARD, REPO, 7, cmd('unblock'))).rejects.toThrow()
    await h.handler.handle(BOARD, REPO, 7, cmd('unblock'))
    await h.handler.handle(BOARD, REPO, 7, cmd('unblock'))
    expect(h.plans.map((p) => p.comment)).toEqual([expect.stringContaining('(wrong_status)')])
  })

  it('re-reads the card after a lost CAS and applies against the fresh revision', async () => {
    const h = make({ status: 'blocked', staleTimes: 1 })
    expect(await h.handler.handle(BOARD, REPO, 7, cmd('unblock'))).toBe('applied')
    expect(h.inputs.map((i) => i.expectedStateRevision)).toEqual([3n, 4n])
  })

  it('throws when every CAS attempt loses, so the GUID stays unlanded', async () => {
    const h = make({ status: 'blocked', staleTimes: 5 })
    await expect(h.handler.handle(BOARD, REPO, 7, cmd('unblock'))).rejects.toThrow(/CAS/)
  })

  it('ignores a comment on an issue that is not a card', async () => {
    const h = make()
    expect(await h.handler.handle(BOARD, REPO, 8, cmd('unblock'))).toBe('not_a_card')
    expect(h.cards.recordCommand).not.toHaveBeenCalled()
  })
})
