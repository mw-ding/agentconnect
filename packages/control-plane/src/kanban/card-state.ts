// Kanban card state machine (issue #2 D5): pure; human label edits are inputs, and our own echoes no-op by state comparison.

export const KANBAN_STATUSES = ['triage', 'todo', 'ready', 'running', 'blocked', 'review', 'done', 'archived'] as const
export type KanbanStatus = (typeof KANBAN_STATUSES)[number]

export const STATUS_LABEL_PREFIX = 'ac/status:'

export function isStatusLabel(label: string): boolean {
  return label.toLowerCase().startsWith(STATUS_LABEL_PREFIX)
}

/** Statuses a human may still move a leased card to; every other edit reverts until the lease ends. */
export const LEASED_HUMAN_STATUSES: ReadonlySet<KanbanStatus> = new Set(['blocked', 'triage', 'archived'])

/** Exhaustive transition table: from → the statuses it may move to (self-moves are no-ops, never listed). */
export const KANBAN_TRANSITIONS: Readonly<Record<KanbanStatus, readonly KanbanStatus[]>> = {
  triage: ['todo', 'ready', 'blocked', 'archived'],
  todo: ['ready', 'blocked', 'triage', 'archived'],
  ready: ['running', 'todo', 'blocked', 'triage', 'archived'],
  running: ['review', 'done', 'blocked', 'ready', 'triage', 'archived'],
  blocked: ['todo', 'ready', 'triage', 'archived'],
  review: ['done', 'ready', 'blocked', 'triage', 'archived'],
  done: ['ready', 'triage'],
  archived: ['triage']
}

export function isKanbanStatus(value: string): value is KanbanStatus {
  return (KANBAN_STATUSES as readonly string[]).includes(value)
}

export function statusLabel(status: KanbanStatus): string {
  return `${STATUS_LABEL_PREFIX}${status}`
}

export function canTransition(from: KanbanStatus, to: KanbanStatus): boolean {
  return KANBAN_TRANSITIONS[from].includes(to)
}

/** The GitHub issue state a status implies. */
export function issueStateFor(status: KanbanStatus): { state: 'open' } | { state: 'closed'; reason: IssueCloseReason } {
  if (status === 'done') return { state: 'closed', reason: 'completed' }
  if (status === 'archived') return { state: 'closed', reason: 'not_planned' }
  return { state: 'open' }
}

export type IssueCloseReason = 'completed' | 'not_planned'

export interface CardSnapshot {
  /** The CP's current status for the card. */
  status: KanbanStatus
  /** A live run lease (worker or verifier) holds the card. */
  leased: boolean
}

export interface ObservedIssue {
  /** Every label currently on the issue, as GitHub reports it. */
  labels: readonly string[]
  state: 'open' | 'closed'
  stateReason?: string | null
}

export type LabelPlanOutcome =
  'noop' | 'accepted' | 'drift_repaired' | 'reverted_leased' | 'reverted_illegal' | 'restored_missing'

export interface LabelPlan {
  outcome: LabelPlanOutcome
  /** The status after the plan applies; equals the snapshot status unless accepted or drift-repaired. */
  status: KanbanStatus
  /** An accepted edit moved a leased card, so the caller must revoke the lease (never transfer it). */
  releaseLease: boolean
  /** The status a human edit asked for, when one was detected. */
  requested?: KanbanStatus
  addLabels: string[]
  removeLabels: string[]
  /** Desired issue-state change, only when observed state differs. */
  issueState?: { state: 'open' } | { state: 'closed'; reason: IssueCloseReason }
  /** Body-free CP comment explaining a repair or revert; absent on silent outcomes. */
  comment?: string
}

/** Split an issue's labels into recognized statuses and malformed `ac/status:*` labels. */
export function parseStatusLabels(labels: readonly string[]): { statuses: KanbanStatus[]; malformed: string[] } {
  const statuses: KanbanStatus[] = []
  const malformed: string[] = []
  for (const label of labels) {
    if (!isStatusLabel(label)) continue
    const value = label.slice(STATUS_LABEL_PREFIX.length)
    if (label === label.toLowerCase() && isKanbanStatus(value)) {
      if (!statuses.includes(value)) statuses.push(value)
    } else malformed.push(label)
  }
  return { statuses, malformed }
}

// Conflicting human status labels must be reconciled before another worker is admitted.
export function isDispatchableIssue(issue: ObservedIssue): boolean {
  const { statuses, malformed } = parseStatusLabels(issue.labels)
  return (
    issue.state === 'open' &&
    malformed.length === 0 &&
    statuses.length > 0 &&
    statuses.every((s) => s === 'ready' || s === 'running')
  )
}

/** A todo+ready pair is a promotion whose todo removal has not landed yet; M1 resolves it to ready. */
export function isPromotionResidue(issue: ObservedIssue): boolean {
  const { statuses, malformed } = parseStatusLabels(issue.labels)
  return (
    issue.state === 'open' &&
    malformed.length === 0 &&
    statuses.length === 2 &&
    statuses.includes('ready') &&
    statuses.includes('todo')
  )
}

/** A verify run dispatches only while the issue still reads `review` (a human's earlier move stands). */
export function isReviewDispatchableIssue(issue: ObservedIssue): boolean {
  const { statuses, malformed } = parseStatusLabels(issue.labels)
  return issue.state === 'open' && malformed.length === 0 && statuses.length === 1 && statuses[0] === 'review'
}

export type RecoveryPlan =
  { kind: 'none' } | { kind: 'move'; to: KanbanStatus } | { kind: 'illegal'; requested: KanbanStatus }

/** Recovery reads one open, unambiguous status label as a request to move a mismatch-parked card. */
export function planRecovery(from: KanbanStatus, observed: ObservedIssue | null): RecoveryPlan {
  if (!observed || observed.state !== 'open') return { kind: 'none' }
  const { statuses, malformed } = parseStatusLabels(observed.labels)
  if (malformed.length > 0 || statuses.length !== 1) return { kind: 'none' }
  const requested = statuses[0]!
  if (requested === from || requested === 'running') return { kind: 'none' }
  return canTransition(from, requested) ? { kind: 'move', to: requested } : { kind: 'illegal', requested }
}

// A mismatch releases the lease into the observed status without modifying GitHub.
export function observedCardStatus(issue: ObservedIssue | null): KanbanStatus {
  if (!issue) return 'triage'
  if (issue.state === 'closed') return issue.stateReason === 'not_planned' ? 'archived' : 'done'
  const { statuses, malformed } = parseStatusLabels(issue.labels)
  return statuses.length === 1 && malformed.length === 0 ? statuses[0]! : 'triage'
}

/** Why a requested status is refused for this card, or undefined when it may apply. */
export function refuseRequest(card: CardSnapshot, requested: KanbanStatus): 'leased' | 'illegal' | undefined {
  if (card.leased && !LEASED_HUMAN_STATUSES.has(requested)) return 'leased'
  return canTransition(card.status, requested) ? undefined : 'illegal'
}

/** Reconcile observed labels to exactly one status label: one new label is a request; several are drift. */
export function planLabelReconcile(card: CardSnapshot, observed: ObservedIssue): LabelPlan {
  const { statuses, malformed } = parseStatusLabels(observed.labels)
  const requests = statuses.filter((s) => s !== card.status)
  const drift = statuses.length > 1 || malformed.length > 0

  let outcome: LabelPlanOutcome
  let status = card.status
  let requested: KanbanStatus | undefined
  if (statuses.length === 0 && malformed.length === 0) {
    outcome = 'restored_missing'
  } else if (requests.length === 0) {
    outcome = drift ? 'drift_repaired' : 'noop'
  } else if (requests.length > 1) {
    outcome = 'drift_repaired'
  } else {
    requested = requests[0]!
    const refusal = refuseRequest(card, requested)
    if (refusal === undefined) {
      status = requested
      outcome = drift ? 'drift_repaired' : 'accepted'
    } else {
      outcome = refusal === 'leased' ? 'reverted_leased' : 'reverted_illegal'
    }
  }

  const keep = statusLabel(status)
  const removeLabels = observed.labels.filter((l) => isStatusLabel(l) && l !== keep)
  const addLabels = observed.labels.includes(keep) ? [] : [keep]
  const desired = issueStateFor(status)
  const issueState = issueStateDiffers(desired, observed) ? desired : undefined
  const releaseLease = card.leased && status !== card.status
  const plan: LabelPlan = {
    outcome,
    status,
    releaseLease,
    addLabels,
    removeLabels,
    ...(issueState ? { issueState } : {})
  }
  if (requested) plan.requested = requested
  const comment = renderPlanComment(card, plan, statuses, malformed)
  if (comment) plan.comment = comment
  return plan
}

/** The label plan for a transition the CP itself made (dispatch, run end, reap): silent, never read as a human request. */
export function planStatusWrite(status: KanbanStatus, observed: ObservedIssue): LabelPlan {
  const keep = statusLabel(status)
  const removeLabels = observed.labels.filter((l) => isStatusLabel(l) && l !== keep)
  const addLabels = observed.labels.includes(keep) ? [] : [keep]
  const desired = issueStateFor(status)
  const issueState = issueStateDiffers(desired, observed) ? desired : undefined
  const changed = addLabels.length > 0 || removeLabels.length > 0 || issueState !== undefined
  return {
    outcome: changed ? 'accepted' : 'noop',
    status,
    releaseLease: false,
    addLabels,
    removeLabels,
    ...(issueState ? { issueState } : {})
  }
}

function issueStateDiffers(
  desired: { state: 'open' } | { state: 'closed'; reason: IssueCloseReason },
  observed: ObservedIssue
): boolean {
  if (desired.state !== observed.state) return true
  return desired.state === 'closed' && (observed.stateReason ?? null) !== desired.reason
}

/** Fixed-template revert of an edit by a GitHub user without live write access; it names only the kept status. */
export function permissionRefusalComment(status: KanbanStatus): string {
  return (
    `AgentConnect Kanban: only collaborators with write access can change a card's status or agent, ` +
    `so this edit was reverted. Kept \`${statusLabel(status)}\`.`
  )
}

/** Fixed-template comment text: it names only statuses and labels, never issue content. */
function renderPlanComment(
  card: CardSnapshot,
  plan: LabelPlan,
  statuses: readonly KanbanStatus[],
  malformed: readonly string[]
): string | undefined {
  const label = (s: KanbanStatus) => `\`${statusLabel(s)}\``
  switch (plan.outcome) {
    case 'noop':
    case 'accepted':
      return undefined
    case 'restored_missing':
      return `AgentConnect Kanban: this card had no status label, so ${label(card.status)} was restored.`
    case 'drift_repaired': {
      const seen = [...statuses.map(label), ...malformed.map((l) => `\`${l}\``)].join(', ')
      return `AgentConnect Kanban: a card carries exactly one status label. Found ${seen}; kept ${label(plan.status)}.`
    }
    case 'reverted_leased':
      return (
        `AgentConnect Kanban: this card is leased to a running agent, so only ` +
        `${[...LEASED_HUMAN_STATUSES].map(label).join(', ')} are accepted until the lease ends. ` +
        `Reverted ${label(plan.requested!)} to ${label(card.status)}.`
      )
    case 'reverted_illegal':
      return (
        `AgentConnect Kanban: ${label(card.status)} cannot move to ${label(plan.requested!)}. ` +
        `Allowed next statuses: ${KANBAN_TRANSITIONS[card.status].map(label).join(', ')}.`
      )
  }
}
