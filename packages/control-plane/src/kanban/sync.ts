// Human edits are attributed from GitHub events; periodic repair projects committed state after failed label writes.
import type { KanbanCardRepo, KanbanLeaseRef } from '../persistence/ports.js'
import type { CardStore, KanbanRepoRef, ManagedEdits } from './card-store.js'
import { isHumanActor } from './card-store.js'
import { parseAgentLabel } from './agent-label.js'
import {
  planLabelReconcile,
  planStatusWrite,
  parseStatusLabels,
  statusLabel,
  type KanbanStatus,
  type LabelPlan
} from './card-state.js'
import { planReassign } from './reassign.js'

export interface SyncCard {
  id: string
  boardId: string
  orgId: string
  issueNumber: number
  status: KanbanStatus
  stateRevision: bigint
  dispatchRevision: bigint
  assigneeAgentId: string | null
  assigneeName?: string | null
  promotionPending: boolean
  labelWritePending: boolean
  syncEventCursor: bigint
  syncAgentCursor: bigint
  lease: KanbanLeaseRef | null
}

export interface KanbanSyncRepo {
  get(boardId: string, issueNumber: number): Promise<SyncCard | null>
  list(boardId: string, limit: number): Promise<number[]>
  apply(
    card: SyncCard,
    plan: LabelPlan,
    cursor: bigint,
    human: boolean,
    agentCursor: bigint
  ): Promise<{ changed: boolean; revoked: KanbanLeaseRef | null } | null>
  ack(card: SyncCard, cursor: bigint, agentCursor?: bigint): Promise<boolean>
}

export interface KanbanSyncDeps {
  repo: KanbanSyncRepo
  cards: Pick<KanbanCardRepo, 'resolveAgentSlug' | 'setAssignee'>
  store: Pick<CardStore, 'readCard' | 'applyPlan' | 'managedEdits' | 'statusSetByHuman'>
  repoRef(boardId: string): Promise<KanbanRepoRef | null>
  revoke(lease: KanbanLeaseRef, cardId: string): Promise<void>
  promote(boardId: string, repo: KanbanRepoRef, issueNumber: number): Promise<void>
  log: { warn(obj: unknown, message: string): void }
}

const BATCH = 25

export class KanbanSync {
  private readonly running = new Map<string, Promise<boolean>>()

  constructor(private readonly deps: KanbanSyncDeps) {}

  // The database orders by oldest completed check so every card, including terminal cards, eventually gets a turn.
  async reconcileBoard(boardId: string): Promise<void> {
    for (const issueNumber of await this.deps.repo.list(boardId, BATCH)) {
      try {
        await this.onCardChanged(boardId, issueNumber)
      } catch (err) {
        this.deps.log.warn({ err, boardId, issueNumber }, 'kanban: drift repair failed')
      }
    }
  }

  onCardChanged(boardId: string, issueNumber: number, humanDoorbell = false): Promise<boolean> {
    const key = `${boardId}:${issueNumber}`
    const previous = this.running.get(key) ?? Promise.resolve(false)
    const run = previous.catch(() => false).then(() => this.reconcile(boardId, issueNumber, humanDoorbell))
    this.running.set(key, run)
    void run
      .finally(() => {
        if (this.running.get(key) === run) this.running.delete(key)
      })
      .catch(() => {})
    return run
  }

  async projectStatus(boardId: string, issueNumber: number, status: KanbanStatus): Promise<void> {
    const card = await this.deps.repo.get(boardId, issueNumber)
    if (!card || card.status !== status || card.promotionPending) return
    const repo = await this.deps.repoRef(boardId)
    if (!repo) return
    const issue = await this.deps.store.readCard(repo, issueNumber)
    if (!issue) return
    const edits = await this.deps.store.managedEdits(repo, issueNumber)
    await this.deps.store.applyPlan(repo, issueNumber, issue, planStatusWrite(status, issue))
    await this.deps.repo.ack(card, BigInt(edits.status?.id ?? 0), BigInt(edits.assignee?.id ?? 0))
  }

  private async authorized(event: ManagedEdits['status']): Promise<boolean> {
    return !!event && isHumanActor(event)
  }

  private async reconcile(boardId: string, issueNumber: number, humanDoorbell: boolean): Promise<boolean> {
    let card = await this.deps.repo.get(boardId, issueNumber)
    if (!card || card.promotionPending) return false
    const repo = await this.deps.repoRef(boardId)
    if (!repo) return false
    const issue = await this.deps.store.readCard(repo, issueNumber)
    if (!issue) return false
    const edits = await this.deps.store.managedEdits(repo, issueNumber)
    const cursor = BigInt(edits.status?.id ?? 0)
    const agentCursor = BigInt(edits.assignee?.id ?? 0)
    const newStatus = !!edits.status && BigInt(edits.status.id) > card.syncEventCursor
    const newAgent = !!edits.assignee && BigInt(edits.assignee.id) > card.syncAgentCursor
    // A periodic retry of a committed transition must not adopt the label that its failed write was replacing.
    let acceptStatus = (!card.labelWritePending || humanDoorbell) && newStatus && (await this.authorized(edits.status))
    let changed = false
    if (newAgent && (await this.authorized(edits.assignee))) {
      const parsed = parseAgentLabel(issue.labels)
      const target =
        parsed.kind === 'agent'
          ? await this.deps.cards.resolveAgentSlug(card.orgId, parsed.slug)
          : parsed.kind === 'none'
            ? null
            : undefined
      // Unknown or ambiguous slugs preserve the current assignee.
      if (target !== undefined && (parsed.kind !== 'agent' || target !== null)) {
        const result = await this.deps.cards.setAssignee({
          cardId: card.id,
          agentId: target,
          expectedDispatchRevision: card.dispatchRevision,
          onLease: 'revoke',
          now: new Date(),
          source: 'label'
        })
        if (!result.ok) return false
        changed = result.changed
        if (result.changed && result.revokedLease) acceptStatus = false
        if (result.revokedLease) {
          const planned = planReassign(
            {
              cardId: card.id,
              status: card.status,
              dispatchRevision: card.dispatchRevision,
              sessionKey: `github:${repo.repoId}#${issueNumber}`,
              lease: result.revokedLease
            },
            { agentId: target ?? 'unassigned', daemonId: '' },
            {
              fromName: card.assigneeName ?? card.assigneeAgentId ?? 'unassigned',
              toName: parsed.kind === 'agent' ? parsed.slug : 'unassigned'
            }
          )
          await this.deps.revoke(result.revokedLease, card.id)
          const comment = planned.steps.find((step) => step.kind === 'post_comment')
          if (comment?.kind === 'post_comment') {
            await this.deps.store.applyPlan(repo, issueNumber, issue, {
              outcome: 'noop',
              status: result.card.status,
              releaseLease: false,
              addLabels: [],
              removeLabels: [],
              comment: comment.body
            })
          }
        }
        card = await this.deps.repo.get(boardId, issueNumber)
        if (!card || card.promotionPending) return changed
      }
    }
    // A close/reopen is a status request only when its own event is newer than every status-label edit.
    const observed =
      acceptStatus && edits.status?.event === 'closed'
        ? {
            ...issue,
            labels: [
              ...issue.labels.filter((label) => !label.startsWith('ac/status:')),
              `ac/status:${issue.stateReason === 'not_planned' ? 'archived' : 'done'}`
            ]
          }
        : issue
    const proposed = planLabelReconcile({ status: card.status, leased: card.lease !== null }, observed)
    if (acceptStatus && proposed.requested && edits.status?.event !== 'closed') {
      if (!(await this.deps.store.statusSetByHuman(repo, issueNumber, proposed.requested))) return changed
    }
    const plan = acceptStatus ? proposed : planStatusWrite(card.status, issue)
    const shape = parseStatusLabels(issue.labels)
    if (!acceptStatus && !plan.comment && (shape.statuses.length > 1 || shape.malformed.length > 0)) {
      plan.comment = `AgentConnect Kanban: a card carries exactly one status label. Restored \`${statusLabel(card.status)}\`.`
    }
    // No new human edit means bots never change DB state; missing/conflicting labels are repaired to the committed status.
    const result = await this.deps.repo.apply(card, plan, cursor, acceptStatus, agentCursor)
    if (!result) return changed
    if (result.revoked) await this.deps.revoke(result.revoked, card.id)
    changed ||= result.changed
    const current = await this.deps.repo.get(boardId, issueNumber)
    if (!current) return changed
    await this.deps.store.applyPlan(repo, issueNumber, issue, {
      ...planStatusWrite(current.status, issue),
      ...(plan.comment ? { comment: plan.comment } : {})
    })
    if (!(await this.deps.repo.ack(current, cursor, agentCursor))) return changed
    if (current.status === 'todo') await this.deps.promote(boardId, repo, issueNumber)
    return changed
  }
}
