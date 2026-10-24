// PR completion contracts (TRD 4.7): doorbells, the verifier's approval, and the 60s sweep all judge a review card the same way.
import type { KanbanDoorbellCheckSuite, KanbanDoorbellPullRequest } from '@agentconnect.md/protocol'
import type { KanbanBoardRecord, KanbanContractCard, KanbanContractRepo } from '../persistence/ports.js'
import { planStatusWrite, type LabelPlan } from './card-state.js'
import type { CardStore, KanbanRepoRef } from './card-store.js'
import {
  checksVerdict,
  contractAttentionComment,
  FLAGGED_WAITS,
  planContract,
  prClosedUnmergedComment,
  type ContractDecision,
  type ContractWait
} from './contracts.js'
import type { PrReader } from './pr-reader.js'
import type { KanbanProjectHook } from './project-writer.js'

/** Review cards re-judged per board per sweep; a cursor walks the rest on later ticks. */
const SWEEP_BATCH = 25

export type ContractOutcome = ContractDecision['kind'] | 'stale_doorbell' | 'lost_race'

export interface KanbanPrContractsDeps {
  repo: KanbanContractRepo
  prs: Pick<PrReader, 'readPullRequest' | 'readCheckRuns'>
  appSlug?: string
  // The live E2E uses PAT-authored PRs targeting a disposable base instead of touching the default branch.
  bindingOverrideForTests?: { authorLogin: string; authorType: string; defaultBranch: string }
  store: Pick<CardStore, 'readCard' | 'applyPlan'>
  /** The dispatcher's per-card status-write queue, held across the settle so its GitHub write is ordered with the controls'. */
  gate?: { holdStatusWrite(cardId: string): (write?: () => Promise<void>) => Promise<void> }
  /** The board's live installation (never a webhook's word); null when it is gone or suspended. */
  repoRef(boardId: string): Promise<KanbanRepoRef | null>
  /** A contract moved the card: wake the board and its notifier. */
  onSettled?: (card: KanbanContractCard, to: 'done' | 'triage') => void | Promise<void>
  /** Every committed status change is projected to the board's GitHub Project. */
  project?: Pick<KanbanProjectHook, 'onStatusCommitted'>
  log: { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void }
}

export class KanbanPrContracts {
  private readonly cursors = new Map<string, number>()

  constructor(private readonly deps: KanbanPrContractsDeps) {}

  /** A closed pull request: judge every review card linked to it; a throw leaves the GUID un-landed. */
  async onPullRequest(board: KanbanBoardRecord, repo: KanbanRepoRef, pr: KanbanDoorbellPullRequest): Promise<void> {
    for (const card of await this.deps.repo.listContractCards(board.id, { prNumbers: [pr.number] })) {
      await this.evaluate(card, repo)
    }
  }

  /** A completed check suite: only `pr_checks_green` cards care, and only when the suite ran on the PR's current head. */
  async onCheckSuite(board: KanbanBoardRecord, repo: KanbanRepoRef, suite: KanbanDoorbellCheckSuite): Promise<void> {
    if (suite.prNumbers.length === 0) return
    for (const card of await this.deps.repo.listContractCards(board.id, { prNumbers: suite.prNumbers })) {
      if (card.completionContract !== 'pr_checks_green') continue
      await this.evaluate(card, repo, suite.headSha)
    }
  }

  /** The verifier approved after the PR already finished: re-judge once now rather than wait for another event. */
  async onVerified(cardId: string): Promise<ContractOutcome | null> {
    const card = await this.deps.repo.getContractCard(cardId)
    if (!card) return null
    const repo = await this.deps.repoRef(card.boardId)
    return repo ? this.evaluate(card, repo) : null
  }

  /** The 60s tick's backstop for missed doorbells: a bounded batch per board, resuming after the last card it judged. */
  async sweep(boardId: string): Promise<void> {
    const after = this.cursors.get(boardId) ?? 0
    const cards = await this.deps.repo.listContractCards(boardId, { afterIssueNumber: after, limit: SWEEP_BATCH })
    if (cards.length < SWEEP_BATCH) this.cursors.delete(boardId)
    else this.cursors.set(boardId, cards.at(-1)!.issueNumber)
    if (cards.length === 0) return
    const repo = await this.deps.repoRef(boardId)
    if (!repo) return
    for (const card of cards) {
      try {
        await this.evaluate(card, repo)
      } catch (err) {
        this.deps.log.warn({ err, boardId, issueNumber: card.issueNumber }, 'kanban: contract sweep read failed')
      }
    }
  }

  private async evaluate(
    card: KanbanContractCard,
    repo: KanbanRepoRef,
    doorbellSha?: string
  ): Promise<ContractOutcome> {
    if (card.linkedPrNumber === null) return 'wait'
    const pr = await this.deps.prs.readPullRequest(repo, card.linkedPrNumber)
    const input: Parameters<typeof planContract>[0] = {
      status: card.status,
      binding: {
        appSlug: this.deps.appSlug,
        repoId: repo.repoId,
        issueNumber: card.issueNumber,
        workEpisodeStartedAt: card.workEpisodeStartedAt,
        ...(this.deps.bindingOverrideForTests ? { overrideForTests: this.deps.bindingOverrideForTests } : {})
      },
      contract: card.completionContract,
      verifierAgentId: card.verifierAgentId,
      verifiedAt: card.verifiedAt,
      linkedPrNumber: card.linkedPrNumber,
      pr
    }
    let decision = planContract(input)
    if (pr && decision.kind === 'wait' && decision.reason === 'checks_unread') {
      // A suite that finished on an older head says nothing about the PR as it stands now.
      if (doorbellSha !== undefined && doorbellSha !== pr.headSha) return 'stale_doorbell'
      const read = await this.deps.prs.readCheckRuns(repo, pr.headSha)
      const verdict = checksVerdict(read.runs)
      // An unread page could hold a failure, so a truncated list is at best pending.
      decision = planContract({
        ...input,
        checks: {
          headSha: pr.headSha,
          verdict: read.complete || verdict === 'failed' ? verdict : 'pending',
          ...(read.actionsUnreadable ? { actionsUnreadable: true } : {})
        }
      })
    }
    if (decision.kind === 'wait' && FLAGGED_WAITS.has(decision.reason)) {
      await this.flag(card, repo, decision.reason)
      return 'wait'
    }
    if (decision.kind === 'wait') {
      this.deps.log.info(
        {
          boardId: card.boardId,
          issueNumber: card.issueNumber,
          prNumber: card.linkedPrNumber,
          reason: decision.reason
        },
        'kanban: PR contract waiting'
      )
      return 'wait'
    }
    const to = decision.kind
    const release = this.deps.gate?.holdStatusWrite(card.cardId) ?? ((write) => write?.() ?? Promise.resolve())
    let moved = false
    try {
      moved = await this.deps.repo.settleContract({
        cardId: card.cardId,
        expectedStateRevision: card.stateRevision,
        expectedConfigRevision: card.configRevision,
        to,
        reason: to === 'done' ? card.completionContract : decision.reason,
        prNumber: card.linkedPrNumber
      })
      if (moved) {
        this.deps.project?.onStatusCommitted({ boardId: card.boardId, issueNumber: card.issueNumber })
        this.deps.log.info(
          { boardId: card.boardId, issueNumber: card.issueNumber, to, prNumber: card.linkedPrNumber },
          'kanban: PR contract moved a card'
        )
      }
    } finally {
      await release(moved ? () => this.writeIssue(card, repo, to) : undefined)
    }
    if (!moved) return 'lost_race'
    await this.deps.onSettled?.(card, to)
    return to
  }

  // A stuck contract is raised once per (card, reason, PR): the CAS winner alone posts the one body-free comment.
  private async flag(card: KanbanContractCard, repo: KanbanRepoRef, reason: ContractWait): Promise<void> {
    const prNumber = card.linkedPrNumber!
    if (card.needsAttention || card.contractFlags.includes(`${reason}#${prNumber}`)) return
    const flagged = await this.deps.repo.flagContract({
      cardId: card.cardId,
      expectedStateRevision: card.stateRevision,
      reason,
      prNumber
    })
    if (!flagged) return
    this.deps.log.info(
      { boardId: card.boardId, issueNumber: card.issueNumber, prNumber, reason },
      'kanban: PR contract needs attention'
    )
    try {
      const issue = await this.deps.store.readCard(repo, card.issueNumber)
      const plan: LabelPlan = {
        outcome: 'noop',
        status: 'review',
        releaseLease: false,
        addLabels: [],
        removeLabels: [],
        comment: contractAttentionComment(reason, prNumber)
      }
      await this.deps.store.applyPlan(repo, card.issueNumber, issue ?? { labels: [], state: 'open' }, plan)
    } catch (err) {
      this.deps.log.warn({ err, cardId: card.cardId, reason }, 'kanban: contract attention comment failed')
    }
  }

  // Best-effort after the commit, like every CP status write; a skip or restart since the settle drops it.
  private async writeIssue(card: KanbanContractCard, repo: KanbanRepoRef, to: 'done' | 'triage'): Promise<void> {
    try {
      const issue = await this.deps.store.readCard(repo, card.issueNumber)
      if (!issue) return
      if (!(await this.deps.repo.isLatestControl(card.cardId, card.controlVersion))) {
        this.deps.log.warn({ cardId: card.cardId, to }, 'kanban: dropped a contract write a newer control superseded')
        return
      }
      const plan: LabelPlan = planStatusWrite(to, issue)
      if (to === 'triage') plan.comment = prClosedUnmergedComment(card.linkedPrNumber!)
      await this.deps.store.applyPlan(repo, card.issueNumber, issue, plan)
    } catch (err) {
      this.deps.log.warn({ err, cardId: card.cardId, to }, 'kanban: contract label write failed')
    }
  }
}
