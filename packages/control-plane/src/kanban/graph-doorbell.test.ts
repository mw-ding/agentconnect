// KanbanGraphDoorbell over faked deps: org-fenced re-reads, landed-GUID memory, coalescing, and error isolation.
import { describe, expect, it, vi } from 'vitest'
import type { RcGithubGraph } from '@agentconnect.md/protocol'
import { OrgId } from '../domain/ids.js'
import type { GithubInstallationRecord, KanbanBoardRecord } from '../persistence/ports.js'
import type { CardGraph } from './card-store.js'
import { KanbanGraphDoorbell } from './graph-doorbell.js'

const BOARD: KanbanBoardRecord = {
  id: 'board-1',
  orgId: OrgId('org-a'),
  name: 'eng',
  repoId: 42n,
  repoFullName: 'acme/web'
}
const EMPTY: CardGraph = { parent: null, subIssues: [], blockedBy: [], blocking: [], truncated: false }

const poke = (over: Partial<RcGithubGraph> = {}): RcGithubGraph => ({
  deliveryKey: 'guid-1',
  installationId: '111',
  repoId: '42',
  event: 'issue_dependencies',
  action: 'blocked_by_added',
  ids: ['9001', '9002'],
  numbers: [7, 8],
  ...over
})

function installation(over: Partial<GithubInstallationRecord> = {}): GithubInstallationRecord {
  return {
    id: 'row-1',
    orgId: OrgId('org-a'),
    installationId: 111n,
    accountLogin: 'acme',
    accountType: 'Organization',
    repositorySelection: 'selected',
    suspendedAt: null,
    revokedAt: null,
    createdAt: new Date(0),
    ...over
  }
}

function make(
  opts: {
    boards?: KanbanBoardRecord[]
    installation?: GithubInstallationRecord | null
    readGraph?: (repo: unknown, n: number) => Promise<CardGraph>
    onGraph?: () => void | Promise<void>
    onCard?: () => void | Promise<void>
  } = {}
) {
  const readGraph = vi.fn(opts.readGraph ?? (async () => EMPTY))
  const onGraph = vi.fn()
  const onCard = vi.fn(opts.onCard ?? (() => {}))
  const log = { debug: vi.fn(), warn: vi.fn() }
  const doorbell = new KanbanGraphDoorbell({
    boards: { listEnabledByRepoId: vi.fn(async () => opts.boards ?? [BOARD]) },
    installations: {
      getByInstallationId: vi.fn(async () => (opts.installation === undefined ? installation() : opts.installation))
    },
    store: { readGraph },
    onGraph: opts.onGraph ?? onGraph,
    onCard,
    log
  })
  return { doorbell, readGraph, onGraph, onCard, log }
}

describe('KanbanGraphDoorbell', () => {
  it('re-reads the graph of every same-repo number named by the poke', async () => {
    const h = make()
    h.doorbell.poke(poke())
    await h.doorbell.settle()
    const repo = { installationId: 111n, repoId: 42n, repoFullName: 'acme/web' }
    expect(h.readGraph.mock.calls).toEqual([
      [repo, 7],
      [repo, 8]
    ])
    expect(h.onGraph).toHaveBeenCalledWith(BOARD, repo, 7, EMPTY)
    expect(h.onGraph).toHaveBeenCalledWith(BOARD, repo, 8, EMPTY)
  })

  it('hands an issues status poke to onCard without reading the graph', async () => {
    const h = make()
    h.doorbell.poke(poke({ event: 'issues', action: 'labeled', ids: ['9001'], numbers: [7] }))
    await h.doorbell.settle()
    expect(h.readGraph).not.toHaveBeenCalled()
    expect(h.onGraph).not.toHaveBeenCalled()
    expect(h.onCard).toHaveBeenCalledWith(BOARD, { installationId: 111n, repoId: 42n, repoFullName: 'acme/web' }, 7)
    expect(h.doorbell.landedDeliveryKeys(['guid-1'])).toEqual(new Set(['guid-1']))
  })

  it('does not land an issues poke whose card handling failed', async () => {
    const h = make({
      onCard: () => {
        throw new Error('db down')
      }
    })
    h.doorbell.poke(poke({ event: 'issues', action: 'labeled', ids: ['9001'], numbers: [7] }))
    await h.doorbell.settle()
    expect(h.doorbell.landedDeliveryKeys(['guid-1'])).toEqual(new Set())
    expect(h.log.warn).toHaveBeenCalled()
  })

  it('records the GUID as landed even when no board watches the repo', async () => {
    const h = make({ boards: [] })
    h.doorbell.poke(poke())
    await h.doorbell.settle()
    expect(h.readGraph).not.toHaveBeenCalled()
    expect(h.doorbell.landedDeliveryKeys(['guid-1', 'guid-2'])).toEqual(new Set(['guid-1']))
  })

  it("skips a board whose org does not own the delivery's installation", async () => {
    const h = make({ boards: [{ ...BOARD, orgId: OrgId('org-b') }] })
    h.doorbell.poke(poke())
    await h.doorbell.settle()
    expect(h.readGraph).not.toHaveBeenCalled()
  })

  it('stays silent for an unknown, revoked, or suspended installation', async () => {
    for (const record of [null, installation({ revokedAt: new Date(1) }), installation({ suspendedAt: new Date(1) })]) {
      const h = make({ installation: record })
      h.doorbell.poke(poke())
      await h.doorbell.settle()
      expect(h.readGraph).not.toHaveBeenCalled()
    }
  })

  it('leaves cross-repo-only pokes to the board tick', async () => {
    const h = make()
    h.doorbell.poke(poke({ numbers: [] }))
    await h.doorbell.settle()
    expect(h.readGraph).not.toHaveBeenCalled()
  })

  it('coalesces a storm on one card into the running read plus one trailing re-read', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const h = make({
      readGraph: async () => {
        await gate
        return EMPTY
      }
    })
    for (let i = 0; i < 5; i++) h.doorbell.poke(poke({ deliveryKey: `guid-${i}`, numbers: [7] }))
    await vi.waitFor(() => expect(h.readGraph).toHaveBeenCalledTimes(1))
    release()
    await h.doorbell.settle()
    expect(h.readGraph).toHaveBeenCalledTimes(2)
  })

  it('logs and survives a failing GitHub read', async () => {
    const h = make({
      readGraph: async () => {
        throw new Error('github 502')
      }
    })
    h.doorbell.poke(poke({ numbers: [7] }))
    await h.doorbell.settle()
    expect(h.log.warn).toHaveBeenCalledTimes(2) // per-key read failure + poke failure
    h.doorbell.poke(poke({ deliveryKey: 'guid-2', numbers: [7] }))
    await h.doorbell.settle()
    expect(h.readGraph).toHaveBeenCalledTimes(2)
  })

  it('marks a GUID landed only after handling succeeds, so a redelivery is processed', async () => {
    const h = make()
    const listEnabled = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue([BOARD])
    const doorbell = new KanbanGraphDoorbell({
      boards: { listEnabledByRepoId: listEnabled },
      installations: { getByInstallationId: vi.fn(async () => installation()) },
      store: { readGraph: h.readGraph },
      onGraph: h.onGraph,
      log: h.log
    })
    doorbell.poke(poke({ numbers: [7] }))
    await doorbell.settle()
    expect(doorbell.landedDeliveryKeys(['guid-1'])).toEqual(new Set())
    expect(h.readGraph).not.toHaveBeenCalled()
    doorbell.poke(poke({ numbers: [7] }))
    await doorbell.settle()
    expect(h.readGraph).toHaveBeenCalledTimes(1)
    expect(doorbell.landedDeliveryKeys(['guid-1'])).toEqual(new Set(['guid-1']))
  })

  it('does not land a GUID whose graph read failed', async () => {
    const h = make({
      readGraph: async () => {
        throw new Error('github 502')
      }
    })
    h.doorbell.poke(poke({ numbers: [7] }))
    await h.doorbell.settle()
    expect(h.doorbell.landedDeliveryKeys(['guid-1'])).toEqual(new Set())
  })

  it('does not land a GUID whose apply failed', async () => {
    const h = make({
      onGraph: async () => {
        throw new Error('apply failed')
      }
    })
    h.doorbell.poke(poke({ numbers: [7, 8] }))
    await h.doorbell.settle()
    expect(h.doorbell.landedDeliveryKeys(['guid-1'])).toEqual(new Set())
  })

  it('lands a GUID only after onGraph resolved', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const h = make({ onGraph: () => gate })
    h.doorbell.poke(poke({ numbers: [7] }))
    await vi.waitFor(() => expect(h.readGraph).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(h.doorbell.landedDeliveryKeys(['guid-1'])).toEqual(new Set())
    release()
    await h.doorbell.settle()
    expect(h.doorbell.landedDeliveryKeys(['guid-1'])).toEqual(new Set(['guid-1']))
  })

  it('makes a poke coalesced into an in-flight read wait for that read', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const h = make({ onGraph: () => gate })
    h.doorbell.poke(poke({ deliveryKey: 'a', numbers: [7] }))
    await vi.waitFor(() => expect(h.readGraph).toHaveBeenCalledTimes(1))
    h.doorbell.poke(poke({ deliveryKey: 'b', numbers: [7] }))
    await new Promise((r) => setTimeout(r, 5))
    expect(h.doorbell.landedDeliveryKeys(['a', 'b'])).toEqual(new Set())
    release()
    await h.doorbell.settle()
    expect(h.doorbell.landedDeliveryKeys(['a', 'b'])).toEqual(new Set(['a', 'b']))
  })
})
