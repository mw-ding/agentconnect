// Kanban graph reconciler (issue #2 M1): promotes todo cards whose blockers all completed, then writes the status label.
import { AGENT_LABEL_PREFIX, agentLabel } from './agent-label.js'
import type { KanbanBoardRecord, KanbanCardRepo } from '../persistence/ports.js'
import { isStatusLabel, statusLabel, type KanbanStatus, type LabelPlan } from './card-state.js'
import type { CardGraph, CardIssue, CardLink, CardStore, KanbanRepoRef, LabelWriteObserver } from './card-store.js'
import type { KanbanProjectHook } from './project-writer.js'

export interface GraphReconcilerLog {
  debug(obj: unknown, msg?: string): void
}

export interface KanbanGraphReconcilerDeps {
  // No bare casStatus: a promotion's ready move and its intent land only together, through beginPromotion.
  cards: Pick<
    KanbanCardRepo,
    | 'findByIssueNumber'
    | 'beginPromotion'
    | 'beginSynthesis'
    | 'notePromotionPosted'
    | 'clearPromotionIntent'
    | 'revertPromotion'
  >
  store: Pick<CardStore, 'readCard' | 'readGraph' | 'applyPlan' | 'lastEventId'>
  agentSlug(orgId: string, agentId: string): Promise<string | null>
  log: GraphReconcilerLog
  /** Defaults to the wall clock; stamps when the promotion intent opened, for the recovery age cap. */
  clock?: { now(): number }
  /** Post-commit Projects v2 seam: a settled promotion (ready) or its rollback (todo) is queued there. */
  project?: Pick<KanbanProjectHook, 'onStatusCommitted'>
}

export type GraphPromotion = 'promote' | 'none'

/** Pure: a todo card with at least one blocker, all completed, on an untruncated graph moves to ready. */
export function planGraphPromotion(cardStatus: KanbanStatus, graph: CardGraph): GraphPromotion {
  if (cardStatus !== 'todo' || graph.truncated || graph.blockedBy.length === 0) return 'none'
  const done = graph.blockedBy.every((l) => l.state === 'closed' && l.stateReason === 'completed')
  return done ? 'promote' : 'none'
}

// Synthesis needs a configured agent, a todo epic, and an untruncated graph whose sub-issues and blockers all completed.
export function planSynthesis(
  epic: { status: KanbanStatus },
  graph: CardGraph,
  synthesizerAgentId: string | null
): GraphPromotion {
  if (epic.status !== 'todo' || graph.truncated || graph.subIssues.length === 0 || !synthesizerAgentId) return 'none'
  const completed = (l: CardLink) => l.state === 'closed' && l.stateReason === 'completed'
  return graph.subIssues.every(completed) && graph.blockedBy.every(completed) ? 'promote' : 'none'
}

export class KanbanGraphReconciler {
  constructor(private readonly deps: KanbanGraphReconcilerDeps) {}

  /** Evaluates the poked issue, its same-repo dependents (unblocked by it), and its parent epic (a sub-issue closing may synthesize). */
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
    // A closed sub-issue re-evaluates its parent epic for synthesis, the mirror of a blocker re-evaluating dependents.
    if (graph.parent && graph.parent.repoId === repo.repoId && !seen.has(graph.parent.number)) {
      seen.add(graph.parent.number)
      await this.evaluate(board, repo, graph.parent.number, await this.deps.store.readGraph(repo, graph.parent.number))
    }
  }

  private async evaluate(
    board: KanbanBoardRecord,
    repo: KanbanRepoRef,
    issueNumber: number,
    graph: CardGraph
  ): Promise<void> {
    const card = await this.deps.cards.findByIssueNumber(board.id, issueNumber)
    // An open intent belongs to recovery (restarting it would reset its caps), and a flagged card to a human.
    if (!card || card.leased || card.promotionPending || card.needsAttention) return
    const residueOnly = card.status === 'ready'
    const synthesis = card.status === 'todo' ? planSynthesis(card, graph, board.synthesizerAgentId) : 'none'
    if (card.status === 'todo') {
      // An epic waits for synthesis even when all of its ordinary blockers have completed.
      if (graph.subIssues.length > 0 ? synthesis !== 'promote' : planGraphPromotion(card.status, graph) !== 'promote')
        return
    } else if (card.status !== 'ready') {
      return
    }
    const observed = await this.deps.store.readCard(repo, issueNumber)
    if (!observed || observed.state !== 'open') return
    if (residueOnly) return this.writeReadyLabels(repo, issueNumber, true, observed)
    const statuses = observed.labels.filter((l) => isStatusLabel(l))
    // Existing ready labels, including todo+ready, require the dispatcher's attributed pending-promotion repair.
    if (statuses.length !== 1 || statuses[0] !== statusLabel('todo')) return
    // Only events after this cursor can be our write; it is read last so the window opens just before the POST.
    const slug = synthesis === 'promote' ? await this.deps.agentSlug(board.orgId, board.synthesizerAgentId!) : null
    if (synthesis === 'promote' && !slug) return
    const cursor = await this.deps.store.lastEventId(repo, issueNumber)
    const startedAt = new Date(this.deps.clock?.now() ?? Date.now())
    const began =
      synthesis === 'promote'
        ? await this.deps.cards.beginSynthesis(
            card.id,
            card.stateRevision,
            BigInt(cursor),
            startedAt,
            board.synthesizerAgentId!
          )
        : await this.deps.cards.beginPromotion(card.id, card.stateRevision, BigInt(cursor), startedAt)
    if (!began) {
      this.deps.log.debug({ boardId: board.id, issueNumber }, 'kanban: graph promotion lost the CAS')
      return
    }
    const revision = card.stateRevision + 1n
    try {
      await this.writeReadyLabels(
        repo,
        issueNumber,
        false,
        observed,
        async (label) => {
          // Only an acknowledged POST lets recovery treat an App ready-add in the window as ours.
          if (label === statusLabel('ready')) await this.deps.cards.notePromotionPosted(card.id)
        },
        slug
      )
      if (await this.deps.cards.clearPromotionIntent(card.id)) {
        this.deps.project?.onStatusCommitted({ boardId: board.id, issueNumber, issueNodeId: observed.nodeId })
      } else {
        this.deps.log.debug({ boardId: board.id, issueNumber }, 'kanban: promotion intent clear lost')
      }
    } catch (err) {
      // Whatever landed, recovery judges the cursor window; the intent keeps the card unclaimable until then.
      const revertedAt = new Date(this.deps.clock?.now() ?? Date.now())
      if (await this.deps.cards.revertPromotion(card.id, revision, revertedAt).catch(() => false)) {
        this.deps.project?.onStatusCommitted({ boardId: board.id, issueNumber, issueNodeId: observed.nodeId })
      }
      throw err
    }
  }

  /** Writes the ready label; for an already-ready card only finishes residue of a crashed earlier write. */
  private async writeReadyLabels(
    repo: KanbanRepoRef,
    issueNumber: number,
    residueOnly: boolean,
    observed: CardIssue,
    onLabelAdded?: LabelWriteObserver,
    assigneeSlug?: string | null
  ): Promise<void> {
    const keep = statusLabel('ready')
    const stale = observed.labels.filter((l) => isStatusLabel(l) && l !== keep)
    const hasKeep = observed.labels.includes(keep)
    // Only todo+ready can be promotion residue; preserve other conflicts for dispatcher mismatch recovery.
    if (residueOnly && (!hasKeep || stale.length !== 1 || stale[0] !== statusLabel('todo'))) return
    const assignee = assigneeSlug ? agentLabel(assigneeSlug) : null
    if (assignee)
      stale.push(
        ...observed.labels.filter((label) => label.toLowerCase().startsWith(AGENT_LABEL_PREFIX) && label !== assignee)
      )
    const plan: LabelPlan = {
      outcome: 'accepted',
      status: 'ready',
      releaseLease: false,
      addLabels: [...(assignee && !observed.labels.includes(assignee) ? [assignee] : []), ...(hasKeep ? [] : [keep])],
      removeLabels: stale
    }
    await this.deps.store.applyPlan(repo, issueNumber, observed, plan, onLabelAdded)
  }
}
