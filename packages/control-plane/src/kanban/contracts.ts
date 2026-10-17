// PR completion contracts (TRD 4.7): pure; when a `review` card's linked pull request finishes it, sends it to triage, or waits.
import type { KanbanStatus } from './card-state.js'
import type { KanbanCompletionContract } from './run-accounting.js'

/** The linked PR as GitHub reports it right now (a live read, never a webhook's word). */
export interface LivePullRequest {
  number: number
  state: 'open' | 'closed'
  merged: boolean
  headSha: string
}

/** One check run on a commit, body-free: its lifecycle and result only. */
export interface CheckRunFacts {
  status: string
  conclusion: string | null
}

export type ChecksVerdict = 'green' | 'pending' | 'failed' | 'none'

/** Conclusions that count as passing; everything else that completed (failure, cancelled, timed_out, …) fails. */
const PASSING: ReadonlySet<string> = new Set(['success', 'neutral', 'skipped'])

/** A failure anywhere wins (no flapping on a later green), then anything unfinished; no runs at all is not green. */
export function checksVerdict(runs: readonly CheckRunFacts[]): ChecksVerdict {
  if (runs.length === 0) return 'none'
  if (runs.some((r) => r.status === 'completed' && !PASSING.has(r.conclusion ?? ''))) return 'failed'
  if (runs.some((r) => r.status !== 'completed')) return 'pending'
  return 'green'
}

export interface ContractInput {
  status: KanbanStatus
  contract: KanbanCompletionContract
  verifierAgentId: string | null
  verifiedAt: Date | null
  linkedPrNumber: number | null
  /** Null when the PR could not be found (deleted, transferred, or not a PR). */
  pr: LivePullRequest | null
  /** The verdict for `pr.headSha`, read live; only `pr_checks_green` needs it. */
  checks?: { headSha: string; verdict: ChecksVerdict }
}

export type ContractWait =
  | 'not_review'
  | 'no_pr_contract'
  | 'no_linked_pr'
  | 'pr_missing'
  | 'pr_open'
  | 'awaiting_verifier'
  | 'checks_unread'
  | 'stale_sha'
  | 'checks_pending'
  | 'checks_failed'
  | 'no_checks'

export type ContractDecision =
  { kind: 'done' } | { kind: 'triage'; reason: 'pr_closed_unmerged' } | { kind: 'wait'; reason: ContractWait }

/** Done needs the contract met and, when a verifier is configured, its approval; an unmerged close always triages. */
export function planContract(input: ContractInput): ContractDecision {
  const wait = (reason: ContractWait): ContractDecision => ({ kind: 'wait', reason })
  if (input.status !== 'review') return wait('not_review')
  if (input.contract === 'close') return wait('no_pr_contract')
  if (input.linkedPrNumber === null) return wait('no_linked_pr')
  const pr = input.pr
  if (!pr || pr.number !== input.linkedPrNumber) return wait('pr_missing')
  if (pr.state === 'closed' && !pr.merged) return { kind: 'triage', reason: 'pr_closed_unmerged' }
  const verified = input.verifierAgentId === null || input.verifiedAt !== null
  if (input.contract === 'pr_merged') {
    if (!pr.merged) return wait('pr_open')
    return verified ? { kind: 'done' } : wait('awaiting_verifier')
  }
  const checks = input.checks
  if (!checks) return wait('checks_unread')
  if (checks.headSha !== pr.headSha) return wait('stale_sha')
  if (checks.verdict === 'pending') return wait('checks_pending')
  if (checks.verdict === 'failed') return wait('checks_failed')
  if (checks.verdict === 'none') return wait('no_checks')
  return verified ? { kind: 'done' } : wait('awaiting_verifier')
}

/** Body-free note for a card whose linked PR closed unmerged: it names only the PR number, labels, and the reason code. */
export function prClosedUnmergedComment(prNumber: number): string {
  return (
    `AgentConnect Kanban: linked pull request #${prNumber} was closed without merging, so this card moved to ` +
    '`ac/status:triage` (pr_closed_unmerged). Set another status to continue.'
  )
}
