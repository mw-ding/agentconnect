// Kanban doorbell (issue #2 spike §3): a body-free `rc/github-graph` poke makes the CP re-read a graph or card.
import type { RcGithubGraph } from '@agentconnect.md/protocol'
import type { GithubInstallationRepo, KanbanBoardRecord, KanbanBoardRepo } from '../persistence/ports.js'
import type { CardGraph, CardStore, KanbanRepoRef } from './card-store.js'

/** Landed-GUID memory bound (flush-at-cap, the redelivery reconciler precedent). */
const MAX_LANDED = 5_000

export interface GraphDoorbellLog {
  debug(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
}

export interface KanbanGraphDoorbellDeps {
  boards: Pick<KanbanBoardRepo, 'listEnabledByRepoId'>
  installations: Pick<GithubInstallationRepo, 'getByInstallationId'>
  store: Pick<CardStore, 'readGraph'>
  /** The re-read graph is applied here; a throw leaves the GUID un-landed so the redelivery sweep re-asks. */
  onGraph?: (
    board: KanbanBoardRecord,
    repo: KanbanRepoRef,
    issueNumber: number,
    graph: CardGraph
  ) => void | Promise<void>
  /** An `issues` status change: no graph read, the card itself is re-read; a throw leaves the GUID un-landed too. */
  onCard?: (board: KanbanBoardRecord, repo: KanbanRepoRef, issueNumber: number) => void | Promise<void>
  log: GraphDoorbellLog
}

export class KanbanGraphDoorbell {
  private readonly landed = new Set<string>()
  private readonly handling = new Set<Promise<void>>()
  private readonly inflight = new Map<string, Promise<void>>()
  /** Keys poked while their read was already running get exactly one trailing re-read. */
  private readonly rerun = new Set<string>()
  private stopped = false

  constructor(private readonly deps: KanbanGraphDoorbellDeps) {}

  /** Fire-and-forget entry: the relay WS handler never awaits GitHub. */
  poke(m: RcGithubGraph): void {
    if (this.stopped) return
    const pending: Promise<void> = this.handle(m)
      .then(() => {
        if (this.landed.size >= MAX_LANDED) this.landed.clear()
        this.landed.add(m.deliveryKey)
      })
      .catch((err: unknown) => {
        this.deps.log.warn({ err, deliveryKey: m.deliveryKey, repoId: m.repoId }, 'kanban graph doorbell failed')
      })
      .finally(() => this.handling.delete(pending))
    this.handling.add(pending)
  }

  /** The GUIDs whose doorbell reached this CP, so the redelivery sweep does not re-ask for them. */
  landedDeliveryKeys(deliveryKeys: readonly string[]): Set<string> {
    return new Set(deliveryKeys.filter((key) => this.landed.has(key)))
  }

  stop(): void {
    this.stopped = true
  }

  /** Await every in-flight re-read (tests and shutdown). */
  async settle(): Promise<void> {
    while (this.handling.size > 0 || this.inflight.size > 0) {
      await Promise.allSettled([...this.handling, ...this.inflight.values()])
    }
  }

  private async handle(m: RcGithubGraph): Promise<void> {
    const boards = await this.deps.boards.listEnabledByRepoId(BigInt(m.repoId))
    if (boards.length === 0) return
    // The verified installation must belong to the board's org (decision 6), and must still be live.
    const installation = await this.deps.installations.getByInstallationId(BigInt(m.installationId))
    if (!installation || installation.revokedAt || installation.suspendedAt) {
      this.deps.log.debug({ installationId: m.installationId }, 'kanban graph doorbell: installation not live')
      return
    }
    if (m.numbers.length === 0) {
      // Cross-repo ids only; the periodic board tick reconciles those.
      this.deps.log.debug({ deliveryKey: m.deliveryKey }, 'kanban graph doorbell: no same-repo issue numbers')
      return
    }
    const reads: Promise<void>[] = []
    for (const board of boards) {
      if (board.orgId !== installation.orgId) continue
      const repo = {
        installationId: installation.installationId,
        repoId: board.repoId,
        repoFullName: board.repoFullName
      }
      for (const issueNumber of m.numbers) {
        reads.push(
          m.event === 'issues'
            ? (async () => this.deps.onCard?.(board, repo, issueNumber))()
            : this.schedule(board, repo, issueNumber)
        )
      }
    }
    // Every read+apply must succeed before the GUID lands; allSettled first so no sibling rejection goes unhandled.
    const results = await Promise.allSettled(reads)
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) throw failed.reason
  }

  private schedule(board: KanbanBoardRecord, repo: KanbanRepoRef, issueNumber: number): Promise<void> {
    const key = `${board.id}#${issueNumber}`
    const running = this.inflight.get(key)
    if (running) {
      // The in-flight promise includes the trailing re-read, so awaiting it covers this poke too.
      this.rerun.add(key)
      return running
    }
    const run = async (): Promise<void> => {
      do {
        this.rerun.delete(key)
        const graph = await this.deps.store.readGraph(repo, issueNumber)
        await this.deps.onGraph?.(board, repo, issueNumber, graph)
      } while (this.rerun.has(key) && !this.stopped)
    }
    const pending: Promise<void> = run()
      .catch((err: unknown) => {
        this.deps.log.warn({ err, boardId: board.id, issueNumber }, 'kanban graph re-read failed')
        throw err
      })
      .finally(() => this.inflight.delete(key))
    this.inflight.set(key, pending)
    return pending
  }
}
