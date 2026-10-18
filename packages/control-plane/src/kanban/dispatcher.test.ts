// Kanban dispatcher projection hook (issue #2 M5): the Projects v2 mirror runs after the status label write
// and can never fail the transition it follows — even a throwing hook leaves the label write intact.
import { describe, expect, it, vi } from 'vitest'
import { KanbanDispatcher, type KanbanDispatcherDeps } from './dispatcher.js'
import type { KanbanRepoRef } from './card-store.js'

const REPO: KanbanRepoRef = { installationId: 7n, repoId: 4242n, repoFullName: 'acme/web' }

function dispatcher(over: { project?: KanbanDispatcherDeps['project'] } = {}) {
  const store = {
    readCard: vi.fn(async () => ({ labels: [] as string[], state: 'open' as const, nodeId: 'I_kwDOAbc123' })),
    applyPlan: vi.fn(async () => {})
  }
  // The mock stays in a local so the assertions below never fight the optional production seam.
  const projectAfterLabel = vi.fn(async () => {})
  const withProject = 'project' in over ? over : { project: { projectAfterLabel } }
  const project = withProject.project
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }
  const d = new KanbanDispatcher({
    repo: {},
    installations: {},
    store,
    send: async () => {
      throw new Error('no daemon in this test')
    },
    isDaemonLive: () => false,
    clock: {},
    log,
    project
  } as unknown as KanbanDispatcherDeps)
  const writeStatus = (
    d as unknown as {
      writeStatus(
        card: { issueNumber: number; cardId: string; boardId: string; orgId: string },
        repo: KanbanRepoRef,
        status: 'done',
        observed?: { labels: string[]; state: 'open' }
      ): void
    }
  ).writeStatus.bind(d)
  return { d, store, project, projectAfterLabel, log, writeStatus }
}

describe('dispatcher Projects v2 projection hook', () => {
  it('projects after the label write with the board, status, and issue node', async () => {
    const h = dispatcher()
    h.writeStatus({ issueNumber: 11, cardId: 'card-1', boardId: 'board-1', orgId: 'org-1' }, REPO, 'done')
    await h.d.settle()
    expect(h.store.applyPlan).toHaveBeenCalledTimes(1)
    expect(h.projectAfterLabel).toHaveBeenCalledWith({
      boardId: 'board-1',
      orgId: 'org-1',
      cardId: 'card-1',
      repo: REPO,
      status: 'done',
      issueNodeId: 'I_kwDOAbc123'
    })
  })

  it('a throwing hook still leaves the label transition intact', async () => {
    const throwing = vi.fn(async () => {
      throw new Error('projection blew up [SECRET]')
    })
    const h = dispatcher({ project: { projectAfterLabel: throwing } })
    h.writeStatus({ issueNumber: 11, cardId: 'card-1', boardId: 'board-1', orgId: 'org-1' }, REPO, 'done')
    await h.d.settle()
    expect(h.store.applyPlan).toHaveBeenCalledTimes(1)
    expect(throwing).toHaveBeenCalledTimes(1)
  })

  it('no hook means labels only, with no extra call', async () => {
    const h = dispatcher({ project: undefined })
    expect(h.project).toBeUndefined()
    h.writeStatus({ issueNumber: 11, cardId: 'card-1', boardId: 'board-1', orgId: 'org-1' }, REPO, 'done')
    await h.d.settle()
    expect(h.store.applyPlan).toHaveBeenCalledTimes(1)
  })
})
