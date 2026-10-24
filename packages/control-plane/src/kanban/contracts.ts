// PR completion contracts (TRD 4.7): pure; when a `review` card's linked pull request finishes it, sends it to triage, or waits.
import type { KanbanStatus } from './card-state.js'
import type { KanbanCompletionContract } from './run-accounting.js'

/** The linked PR as GitHub reports it right now (a live read, never a webhook's word). */
export interface LivePullRequest {
  number: number
  state: 'open' | 'closed'
  merged: boolean
  headSha: string
  authorLogin: string | null
  authorType: string | null
  headRef: string | null
  headRepoId: bigint | null
  baseRef: string | null
  defaultBranch: string | null
  createdAt: Date | null
  mergedByLogin: string | null
}

/** One check run on a commit, body-free: its lifecycle and result only. */
export interface CheckRunFacts {
  status: string
  conclusion: string | null
}

export type ChecksVerdict = 'green' | 'pending' | 'failed' | 'none'

// Neutral and skipped tolerate optional jobs, but a green head still requires at least one success.
const PASSING: ReadonlySet<string> = new Set(['success', 'neutral', 'skipped'])

/** A failure anywhere wins (no flapping on a later green), then anything unfinished; no runs at all is not green. */
export function checksVerdict(runs: readonly CheckRunFacts[]): ChecksVerdict {
  if (runs.length === 0) return 'none'
  if (runs.some((r) => r.status === 'completed' && !PASSING.has(r.conclusion ?? ''))) return 'failed'
  if (runs.some((r) => r.status !== 'completed')) return 'pending'
  return runs.some((r) => r.conclusion === 'success') ? 'green' : 'pending'
}

export interface ContractInput {
  status: KanbanStatus
  binding?: {
    appSlug: string | undefined
    repoId: bigint
    issueNumber: number
    /** The card's work episode start; a PR created before it belongs to earlier work. */
    workEpisodeStartedAt: Date | null
    // Only live E2E constructors supply this; production has no config or environment override.
    overrideForTests?: { authorLogin: string; authorType: string; defaultBranch: string }
  }
  contract: KanbanCompletionContract
  verifierAgentId: string | null
  verifiedAt: Date | null
  linkedPrNumber: number | null
  /** Null when the PR could not be found (deleted, transferred, or not a PR). */
  pr: LivePullRequest | null
  /** The verdict for `pr.headSha`, read live; only `pr_checks_green` needs it. */
  checks?: { headSha: string; verdict: ChecksVerdict; actionsUnreadable?: boolean }
}

export type ContractWait =
  | 'not_review'
  | 'no_pr_contract'
  | 'no_linked_pr'
  | 'pr_missing'
  | 'pr_unbound'
  | 'pr_open'
  | 'merged_by_app'
  | 'awaiting_verifier'
  | 'checks_unread'
  | 'stale_sha'
  | 'checks_pending'
  | 'checks_failed'
  | 'actions_read_missing'
  | 'no_checks'

export type ContractDecision =
  { kind: 'done' } | { kind: 'triage'; reason: 'pr_closed_unmerged' } | { kind: 'wait'; reason: ContractWait }

// Only a bound PR may complete or triage a card; completion also needs any configured verifier approval.
export function planContract(input: ContractInput): ContractDecision {
  const wait = (reason: ContractWait): ContractDecision => ({ kind: 'wait', reason })
  if (input.status !== 'review') return wait('not_review')
  if (input.contract === 'close') return wait('no_pr_contract')
  const unbound = bindingWait(input)
  if (unbound) return wait(unbound)
  const pr = input.pr!
  const binding = input.binding!
  if (pr.state === 'closed' && !pr.merged) return { kind: 'triage', reason: 'pr_closed_unmerged' }
  const verified = input.verifierAgentId === null || input.verifiedAt !== null
  if (input.contract === 'pr_merged') {
    if (!pr.merged) return wait('pr_open')
    // The worker's own token can merge on an unprotected base, so with no verifier an App-bot merge proves nothing.
    const appBot = binding.appSlug ? `${binding.appSlug}[bot]`.toLowerCase() : null
    if (input.verifierAgentId === null && appBot !== null && pr.mergedByLogin?.toLowerCase() === appBot)
      return wait('merged_by_app')
    return verified ? { kind: 'done' } : wait('awaiting_verifier')
  }
  const checks = input.checks
  if (!checks) return wait('checks_unread')
  if (checks.headSha !== pr.headSha) return wait('stale_sha')
  // Without actions:read, same-named jobs of different workflows cannot be told apart, so the head is never green.
  if (checks.actionsUnreadable && checks.verdict !== 'failed') return wait('actions_read_missing')
  if (checks.verdict === 'pending') return wait('checks_pending')
  if (checks.verdict === 'failed') return wait('checks_failed')
  if (checks.verdict === 'none') return wait('no_checks')
  return verified ? { kind: 'done' } : wait('awaiting_verifier')
}

/** Whether the linked PR is this card's episode PR, whatever the card's status: the wait that says why not, else null. */
export function bindingWait(
  input: Pick<ContractInput, 'binding' | 'linkedPrNumber' | 'pr'>
): 'no_linked_pr' | 'pr_missing' | 'pr_unbound' | null {
  if (input.linkedPrNumber === null) return 'no_linked_pr'
  const pr = input.pr
  if (!pr || pr.number !== input.linkedPrNumber) return 'pr_missing'
  const binding = input.binding
  const expected = binding?.overrideForTests ?? {
    authorLogin: binding?.appSlug ? `${binding.appSlug}[bot]` : null,
    authorType: 'Bot',
    defaultBranch: pr.defaultBranch
  }
  if (
    !binding ||
    !expected.authorLogin ||
    !expected.defaultBranch ||
    !binding.workEpisodeStartedAt ||
    !pr.createdAt ||
    pr.authorLogin?.toLowerCase() !== expected.authorLogin.toLowerCase() ||
    pr.authorType !== expected.authorType ||
    pr.headRef !== `ac/card-${binding.issueNumber}` ||
    pr.headRepoId !== binding.repoId ||
    pr.baseRef !== expected.defaultBranch ||
    !Number.isFinite(pr.createdAt.getTime()) ||
    !Number.isFinite(binding.workEpisodeStartedAt.getTime()) ||
    pr.createdAt.getTime() < binding.workEpisodeStartedAt.getTime()
  )
    return 'pr_unbound'
  return null
}

/** Body-free note for a card whose linked PR closed unmerged: it names only the PR number, labels, and the reason code. */
export function prClosedUnmergedComment(prNumber: number): string {
  return (
    `AgentConnect Kanban: linked pull request #${prNumber} was closed without merging, so this card moved to ` +
    '`ac/status:triage` (pr_closed_unmerged). Set another status to continue.'
  )
}

/** Waits no event will end on their own: each sets needsAttention and posts one comment per (card, reason, PR). */
export const FLAGGED_WAITS: ReadonlySet<ContractWait> = new Set(['pr_unbound', 'actions_read_missing', 'merged_by_app'])

const FLAG_HINTS: Partial<Record<ContractWait, string>> = {
  pr_unbound:
    'is not bound to this card (it must be opened by the AgentConnect App on `ac/card-<issue>` in this repository, ' +
    "against the default branch, after this card's work started)",
  actions_read_missing:
    'has GitHub Actions checks, but the App cannot read workflow runs (`actions:read`), so its checks cannot be judged',
  merged_by_app: 'was merged by the AgentConnect App itself and this board has no verifier, so the merge is not proof'
}

/** Body-free note for a contract that needs a human: the PR number, a fixed reason, and the reason code only. */
export function contractAttentionComment(
  reason: ContractWait,
  prNumber: number,
  status: KanbanStatus = 'review'
): string {
  return (
    `AgentConnect Kanban: linked pull request #${prNumber} ${FLAG_HINTS[reason] ?? 'cannot complete this card'}, ` +
    `so this card stays in \`ac/status:${status}\` and needs attention (${reason}). Move the card to continue.`
  )
}
