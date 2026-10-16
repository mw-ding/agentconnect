// Kanban graph reconciler (issue #2 M1): promotes todo cards whose blockers all completed, then writes the status label.
import type { KanbanBoardRecord, KanbanCardRepo } from '../persistence/ports.js'
import { STATUS_LABEL_PREFIX, statusLabel, type KanbanStatus, type LabelPlan } from './card-state.js'
import type { CardGraph, CardStore, KanbanRepoRef } from './card-store.js'

export interface GraphReconcilerLog {
  debug(obj: unknown, msg?: string): void
}

export interface KanbanGraphReconcilerDeps {
  cards: KanbanCardRepo
  store: Pick<CardStore, 'readCard' | 'readGraph' | 'applyPlan'>
  log: GraphReconcilerLog
}

export type GraphPromotion = 'promote' | 'none'

/** Pure: a todo card with at least one blocker, all completed, on an untruncated graph moves to ready. */
export function planGraphPromotion(cardStatus: KanbanStatus, graph: CardGraph): GraphPromotion {
  if (cardStatus !== 'todo' || graph.truncated || graph.blockedBy.length === 0) return 'none'
  const done = graph.blockedBy.every((l) => l.state === 'closed' && l.stateReason === 'completed')
  return done ? 'promote' : 'none'
}

export class KanbanGraphReconciler {
  constructor(private readonly deps: KanbanGraphReconcilerDeps) {}

  /** Evaluates the poked issue and its same-repo dependents, since closing a blocker is what unblocks them. */
  async apply(board: KanbanBoardRecord, repo: KanbanRepoRef, issueNumber: number, graph: CardGraph): Promise<void> {
    await this.evaluate(board, repo, issueNumber, graph)
    const seen = new Set([issueNumber])
    for (const dep of graph.blocking) {
      // A null repoId is unknown, not local, so skip it rather than act on a possibly foreign issue.
      if (dep.repoId === null || dep.repoId !== repo.repoId) continue
      if (seen.has(dep.number)) continue
      seen.add(dep.number)
      await this.evaluate(board, repo, dep.number, await this.deps.store.readGraph(repo, dep.number))
    }
  }

  private async evaluate(
    board: KanbanBoardRecord,
    repo: KanbanRepoRef,
    issueNumber: number,
    graph: CardGraph
  ): Promise<void> {
    const card = await this.deps.cards.findByIssueNumber(board.id, issueNumber)
    if (!card) return
    if (card.status === 'todo') {
      if (planGraphPromotion(card.status, graph) !== 'promote') return
      if (!(await this.deps.cards.casStatus(card.id, card.stateRevision, 'ready'))) {
        this.deps.log.debug({ boardId: board.id, issueNumber }, 'kanban: graph promotion lost the CAS')
        return
      }
    } else if (card.status !== 'ready') {
      return
    }
    await this.writeReadyLabels(repo, issueNumber, card.status === 'ready')
  }

  /** Writes the ready label; for an already-ready card only finishes residue of a crashed earlier write. */
  private async writeReadyLabels(repo: KanbanRepoRef, issueNumber: number, residueOnly: boolean): Promise<void> {
    const observed = await this.deps.store.readCard(repo, issueNumber)
    if (!observed) return
    const keep = statusLabel('ready')
    const stale = observed.labels.filter((l) => l.startsWith(STATUS_LABEL_PREFIX) && l !== keep)
    const hasKeep = observed.labels.includes(keep)
    // Add-then-remove can crash with ready plus a stray status label, so repair unless exactly [ready].
    if (residueOnly && hasKeep && stale.length === 0) return
    const plan: LabelPlan = {
      outcome: 'accepted',
      status: 'ready',
      releaseLease: false,
      addLabels: hasKeep ? [] : [keep],
      removeLabels: stale
    }
    await this.deps.store.applyPlan(repo, issueNumber, observed, plan)
  }
}
