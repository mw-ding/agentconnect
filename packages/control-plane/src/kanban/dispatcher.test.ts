// Dispatcher projection seam (issue #2 M5): committed status changes queue the Projects v2 mirror apart from labels.
import { describe, expect, it, vi } from 'vitest'
import { KanbanDispatcher, type KanbanDispatcherDeps } from './dispatcher.js'
import type { KanbanRepoRef } from './card-store.js'
import { kanbanProjectHook } from './project-writer.js'
import type { KanbanClaimedLease, KanbanRecoveryDue } from '../persistence/ports.js'

const REPO: KanbanRepoRef = { installationId: 7n, repoId: 4242n, repoFullName: 'acme/web' }
const NOW = new Date('2026-10-18T00:00:00Z')
const BOARD_REF = { boardId: 'board-1', orgId: 'org-1', repoId: 4242n, repoFullName: 'acme/web' }

function dispatcher(
  over: { project?: KanbanDispatcherDeps['project'] | null; sync?: KanbanDispatcherDeps['sync'] } = {}
) {
  const store = {
    readCard: vi.fn(async () => ({ labels: ['ac/status:todo'], state: 'open' as const, nodeId: 'I_kwDOAbc123' })),
    applyPlan: vi.fn(async () => {}),
    statusSetByHuman: vi.fn(async () => true),
    // #415: the human label's adder must hold live write access before a parked card moves.
    readLabelEvents: vi.fn(async () => [
      { id: 1, event: 'labeled', label: { name: 'ac/status:todo' }, actor: { login: 'alice', type: 'User' } }
    ]),
    promotionVerdict: vi.fn(async () => 'accept' as const),
    readGraph: vi.fn(async () => ({
      parent: null,
      subIssues: [],
      blockedBy: [{ issueId: 1n, number: 1, repoId: 4242n, state: 'closed' as const, stateReason: 'completed' }],
      blocking: [],
      truncated: false
    }))
  }
  const repo = {
    now: vi.fn(async () => NOW),
    getBoardRef: vi.fn(async () => BOARD_REF),
    getParkedStatus: vi.fn(async () => 'triage' as const),
    ingestStatus: vi.fn(async () => ({ moved: true })),
    settlePromotion: vi.fn(async () => true),
    escalatePromotion: vi.fn(async () => true),
    endRun: vi.fn(async () => ({
      accepted: true as const,
      card: { ...BOARD_REF, cardId: 'card-1', issueNumber: 11, from: 'running' as const, to: 'done' as const },
      plan: {}
    }))
  }
  const installations = {
    liveByOrgAndAccount: vi.fn(async () => ({ installationId: 7n, revokedAt: null, suspendedAt: null }))
  }
  const onStatusCommitted = vi.fn()
  const project = over.project === null ? undefined : (over.project ?? { onStatusCommitted })
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }
  const d = new KanbanDispatcher({
    repo,
    installations,
    store,
    send: async () => {
      throw new Error('no daemon in this test')
    },
    isDaemonLive: () => false,
    clock: {},
    log,
    humanAuthz: { appSlug: 'agentconnect', permissions: { permission: async () => 'write' as const } },
    ...(project ? { project } : {}),
    ...(over.sync ? { sync: over.sync } : {})
  } as unknown as KanbanDispatcherDeps)
  const writeStatus = (
    d as unknown as {
      writeStatus(
        card: { issueNumber: number; cardId: string; boardId: string },
        repo: KanbanRepoRef,
        status: 'running' | 'done',
        observed?: { labels: string[]; state: 'open'; nodeId?: string }
      ): void
    }
  ).writeStatus.bind(d)
  const internals = d as unknown as {
    recoverPromotion(boardId: string, card: KanbanRecoveryDue): Promise<{ moved: boolean }>
    escalatePromotion(boardId: string, card: KanbanRecoveryDue, reason: 'unresolved'): Promise<{ moved: boolean }>
    dispatchLease(lease: KanbanClaimedLease): Promise<void>
  }
  return { d, store, repo, onStatusCommitted, log, writeStatus, internals }
}

const CARD = { issueNumber: 11, cardId: 'card-1', boardId: 'board-1' }
const PENDING: KanbanRecoveryDue = {
  cardId: 'card-1',
  issueNumber: 11,
  promotion: true,
  promotionEventCursor: 5n,
  promotionPostAccepted: true,
  promotionStartedAt: NOW,
  promotionWatchUntil: null,
  promotionChecks: 0,
  recoveryCheckAt: null
}

describe('dispatcher Projects v2 projection seam', () => {
  it('queues the projection with the board, issue and observed node when a status commits', async () => {
    const h = dispatcher()
    h.writeStatus(CARD, REPO, 'done', { labels: [], state: 'open', nodeId: 'I_kwDOAbc123' })
    await h.d.settle()
    expect(h.store.applyPlan).toHaveBeenCalledTimes(1)
    expect(h.onStatusCommitted).toHaveBeenCalledWith({
      boardId: 'board-1',
      issueNumber: 11,
      issueNodeId: 'I_kwDOAbc123'
    })
  })

  it('a throwing hook still leaves the label transition intact', async () => {
    const throwing = vi.fn(() => {
      throw new Error('projection blew up [SECRET]')
    })
    const h = dispatcher({ project: { onStatusCommitted: throwing } as unknown as KanbanDispatcherDeps['project'] })
    expect(() => h.writeStatus(CARD, REPO, 'done')).not.toThrow()
    await h.d.settle()
    expect(h.store.applyPlan).toHaveBeenCalledTimes(1)
    expect(throwing).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(h.log.warn.mock.calls)).not.toContain('[SECRET]')
  })

  it('no hook means labels only, with no extra call', async () => {
    const h = dispatcher({ project: null })
    h.writeStatus(CARD, REPO, 'done')
    await h.d.settle()
    expect(h.store.applyPlan).toHaveBeenCalledTimes(1)
    expect(h.onStatusCommitted).not.toHaveBeenCalled()
  })

  // #194 routes status writes through KanbanSync in production; the projection must still follow them.
  it('queues the projection on the #194 sync path too, falling back to the stored issue node', async () => {
    const sync = { projectStatus: vi.fn(async () => {}), onCardChanged: vi.fn(), reconcileBoard: vi.fn() }
    const h = dispatcher({ sync: sync as unknown as KanbanDispatcherDeps['sync'] })
    h.writeStatus(CARD, REPO, 'done')
    await h.d.settle()
    expect(sync.projectStatus).toHaveBeenCalledWith('board-1', 11, 'done')
    expect(h.store.applyPlan).not.toHaveBeenCalled()
    expect(h.onStatusCommitted).toHaveBeenCalledWith({ boardId: 'board-1', issueNumber: 11 })
  })

  it('vera-474: B2 human recovery through ingestStatus projects the committed status', async () => {
    const h = dispatcher()
    expect(await h.d.ingestCard('board-1', 11)).toBe(true)
    expect(h.repo.ingestStatus).toHaveBeenCalledWith('board-1', 11, 'triage', 'todo')
    expect(h.onStatusCommitted).toHaveBeenCalledWith({
      boardId: 'board-1',
      issueNumber: 11,
      issueNodeId: 'I_kwDOAbc123'
    })
  })

  it('vera-474: B2 a refused human recovery commits nothing and projects nothing', async () => {
    const h = dispatcher()
    h.repo.ingestStatus.mockResolvedValueOnce({ moved: false })
    expect(await h.d.ingestCard('board-1', 11)).toBe(false)
    expect(h.onStatusCommitted).not.toHaveBeenCalled()
  })

  it('vera-474: B2 an adopted half-landed graph promotion projects ready', async () => {
    const h = dispatcher()
    h.store.readCard.mockResolvedValueOnce({ labels: ['ac/status:ready'], state: 'open', nodeId: 'I_1' })
    expect(await h.internals.recoverPromotion('board-1', PENDING)).toMatchObject({ moved: true })
    expect(h.repo.settlePromotion).toHaveBeenCalledWith('card-1', true)
    expect(h.onStatusCommitted).toHaveBeenCalledWith({ boardId: 'board-1', issueNumber: 11, issueNodeId: 'I_1' })
  })

  it('vera-474: B2 a cleared promotion projects its todo status', async () => {
    const h = dispatcher()
    h.store.readCard.mockResolvedValueOnce({ labels: ['ac/status:todo'], state: 'open', nodeId: 'I_1' })
    await h.internals.recoverPromotion('board-1', PENDING)
    expect(h.repo.settlePromotion).toHaveBeenCalledWith('card-1', false)
    expect(h.onStatusCommitted).toHaveBeenCalledWith({ boardId: 'board-1', issueNumber: 11, issueNodeId: 'I_1' })
  })

  it('vera-474: B2 an escalated promotion projects its todo status', async () => {
    const h = dispatcher()
    await h.internals.escalatePromotion('board-1', PENDING, 'unresolved')
    expect(h.repo.escalatePromotion).toHaveBeenCalledWith('card-1', 'unresolved')
    expect(h.onStatusCommitted).toHaveBeenCalledWith({ boardId: 'board-1', issueNumber: 11 })
  })

  it('vera-474: B2 a dispatch that finds GitHub moved the card projects the released status', async () => {
    const h = dispatcher()
    h.store.readCard.mockResolvedValueOnce({ labels: ['ac/status:done'], state: 'closed', nodeId: 'I_1' } as never)
    await h.internals.dispatchLease({
      ...BOARD_REF,
      mode: 'read',
      runId: 'run-1',
      leaseId: 'lease-1',
      cardId: 'card-1',
      issueNumber: 11,
      agentId: 'agent-1',
      daemonId: 'daemon-1',
      daemonEpoch: 1n
    } as KanbanClaimedLease)
    expect(h.repo.endRun).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: 'github_state_mismatch' }))
    expect(h.onStatusCommitted).toHaveBeenCalledWith({ boardId: 'board-1', issueNumber: 11, issueNodeId: 'I_1' })
  })

  it('vera-474: a hanging projection never delays the next label write for that card', async () => {
    const card = {
      id: 'card-1',
      boardId: 'board-1',
      issueNodeId: 'I_1',
      projectItemId: null,
      projectItemProjectId: null,
      status: 'running'
    }
    const writer = { project: vi.fn(() => new Promise<null>(() => {})) }
    const hook = kanbanProjectHook({
      boards: { getForOrg: vi.fn(async () => ({ projectNodeId: 'PVT_1', statusFieldId: 'F_1' })) } as never,
      cards: {
        findByIssueNumber: vi.fn(async () => ({ id: 'card-1' })),
        getCard: vi.fn(async () => card),
        setProjectItemId: vi.fn(async () => {})
      } as never,
      writer,
      boardRepo: vi.fn(async () => ({ orgId: 'org-1', repo: REPO }))
    } as Parameters<typeof kanbanProjectHook>[0])
    const h = dispatcher({ project: hook as unknown as KanbanDispatcherDeps['project'] })
    const orgCard = { ...CARD, orgId: 'org-1' }
    h.writeStatus(orgCard, REPO, 'running')
    h.writeStatus(orgCard, REPO, 'done')
    await Promise.race([h.d.settle(), new Promise((resolve) => setTimeout(resolve, 500))])
    expect(writer.project).toHaveBeenCalledTimes(1)
    expect(h.store.applyPlan).toHaveBeenCalledTimes(2)
  })
})
