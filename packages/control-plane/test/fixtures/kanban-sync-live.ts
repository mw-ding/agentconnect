// Live tests inject only token minting and daemon delivery; issue reads, writes, events and permissions stay on GitHub.
import { expect } from 'vitest'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { OrgId } from '../../src/domain/ids.js'
import { systemClock } from '../../src/domain/clock.js'
import { GithubCardStore } from '../../src/kanban/card-store.js'
import { KanbanDispatcher } from '../../src/kanban/dispatcher.js'
import { KanbanGraphReconciler } from '../../src/kanban/graph-reconciler.js'
import { KanbanGraphDoorbell } from '../../src/kanban/graph-doorbell.js'
import { KanbanSync } from '../../src/kanban/sync.js'
import { PgKanbanBoardRepo, PgKanbanCardRepo } from '../../src/persistence/repositories/kanban.repo.js'
import { PgKanbanDispatchRepo } from '../../src/persistence/repositories/kanban-dispatch.repo.js'
import { PgKanbanSyncRepo } from '../../src/persistence/repositories/kanban-sync.repo.js'
import type { KanbanLeaseRef } from '../../src/persistence/ports.js'
import { prisma } from '../setup.db.js'
import { FULL, REPO_ID, installation, tokens, repoRef } from './kanban-live.js'

export async function liveSync() {
  const board = await prisma.kanbanBoard.create({
    data: { orgId: DEFAULT_ORG_ID, name: 'live sync', repoId: REPO_ID, repoFullName: FULL }
  })
  await prisma.githubInstallation.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      installationId: 1n,
      accountLogin: 'mw-ding',
      accountType: 'User',
      repositorySelection: 'selected'
    }
  })
  const cards = new PgKanbanCardRepo(prisma)
  const store = new GithubCardStore({ tokens })
  const repo = new PgKanbanSyncRepo(prisma)
  const revoked: KanbanLeaseRef[] = []
  const log = {
    debug() {},
    info() {},
    warn(obj: unknown, message?: string) {
      console.warn(message, obj)
    }
  }
  const graph = new KanbanGraphReconciler({ cards, store, log })
  const record = { ...board, orgId: OrgId(board.orgId) }
  const sync = new KanbanSync({
    repo,
    cards,
    store,
    repoRef: async () => repoRef,
    revoke: async (lease) => {
      revoked.push(lease)
    },
    promote: async (_boardId, ref, n) => graph.apply(record, ref, n, await store.readGraph(ref, n)),
    log
  })
  const dispatcher = new KanbanDispatcher({
    repo: new PgKanbanDispatchRepo(prisma),
    installations: { liveByOrgAndAccount: async () => installation },
    store,
    sync,
    send: async () => {
      throw new Error('live sync does not start agents')
    },
    isDaemonLive: () => false,
    clock: systemClock,
    log
  })
  const bell = new KanbanGraphDoorbell({
    boards: new PgKanbanBoardRepo(prisma),
    installations: { getByInstallationId: async () => installation },
    store,
    log,
    onCard: async (b, ref, n, action) => {
      await dispatcher.onCardChanged(b.id, n, 'human')
      if (action === 'closed') await graph.apply(b, ref, n, await store.readGraph(ref, n))
    }
  })
  return {
    board,
    cards,
    store,
    repo,
    sync,
    dispatcher,
    revoked,
    async ring(issueNumber: number, action = 'labeled') {
      bell.poke({
        deliveryKey: crypto.randomUUID(),
        installationId: '1',
        repoId: String(REPO_ID),
        event: 'issues',
        action,
        ids: [],
        numbers: [issueNumber]
      })
      await bell.settle()
    },
    async awaitStatusEvent(issueNumber: number, eventName: string, label?: string) {
      await expect
        .poll(
          async () => {
            const event = (await store.managedEdits(repoRef, issueNumber)).status
            return event?.event === eventName && (!label || event.label?.name === label)
          },
          { timeout: 30_000, interval: 500 }
        )
        .toBe(true)
    }
  }
}
