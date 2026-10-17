// Human Kanban actions (issue #2 §7, TRD 4.5/4.9/4.10): one live authz gate and one transition planner for comment and label moves.
import { checkWriteAccess, type RepoPermissionLookup, type RepoPermissionTarget } from '../github/repo-permission.js'
import {
  canTransition,
  LEASED_HUMAN_STATUSES,
  planStatusWrite,
  statusLabel,
  type KanbanStatus,
  type LabelPlan,
  type ObservedIssue
} from './card-state.js'
import { isAppActor, isHumanActor } from './card-store.js'
import { attestHumanAuthority, type KanbanHumanAuthority } from './human-authority.js'

/** The GitHub sender of a human action, body-free: login, optional numeric id, and the account type GitHub reported. */
export interface KanbanHumanActor {
  login: string
  id?: number | string
  type?: string
  /** The edit was made by an App on the user's behalf (an event's `performed_via_github_app`). */
  viaApp?: boolean
}

export type HumanActionRefusal = 'not_human' | 'app_actor' | 'no_write' | 'lookup_failed'

export type HumanActionAuthz =
  { ok: true; authority: KanbanHumanAuthority } | { ok: false; reason: HumanActionRefusal; error?: unknown }

export interface HumanActionAuthzInput {
  repo: RepoPermissionTarget
  actor: KanbanHumanActor
  /** This deployment's App slug: its bot is the actor of every CP and agent write. */
  appSlug: string | undefined
  /** Pass a lookup with caching off: a revoked write grant must stop the very next command. */
  permissions: RepoPermissionLookup
}

// B8: agents hold only App tokens, so they act as `<appSlug>[bot]` and are refused here; no agent → GitHub-user mapping exists.
export async function authorizeHumanKanbanAction(input: HumanActionAuthzInput): Promise<HumanActionAuthz> {
  const event = {
    actor: { login: input.actor.login, ...(input.actor.type !== undefined ? { type: input.actor.type } : {}) },
    performed_via_github_app: input.actor.viaApp ? true : undefined
  }
  if (isAppActor(event, input.appSlug)) return { ok: false, reason: 'app_actor' }
  if (!isHumanActor(event)) return { ok: false, reason: 'not_human' }
  const access = await checkWriteAccess(input.permissions, input.repo, input.actor.login.toLowerCase())
  if (access.error !== undefined) return { ok: false, reason: 'lookup_failed', error: access.error }
  if (!access.write) return { ok: false, reason: 'no_write' }
  return { ok: true, authority: attestHumanAuthority(input.actor.login, access.level) }
}

/** The comment commands (`/kanban <name>` on a new comment's first line). */
export const KANBAN_COMMANDS = ['unblock', 'reopen', 'ready'] as const
export type KanbanCommand = (typeof KANBAN_COMMANDS)[number]

/** Every command lands the card in `ready`; each names the only statuses it applies to. */
const COMMAND_FROM: Readonly<Record<KanbanCommand, readonly KanbanStatus[]>> = {
  unblock: ['blocked'],
  reopen: ['done'],
  ready: ['todo', 'triage']
}

export type HumanTransitionRefusal = 'wrong_status' | 'leased' | 'illegal' | 'no_write'

export interface HumanTransitionCard {
  status: KanbanStatus
  leased: boolean
}

export type HumanTransitionPlan =
  | { ok: true; from: KanbanStatus; to: KanbanStatus; plan: LabelPlan }
  | { ok: false; reason: HumanTransitionRefusal; refusalComment: string }

/** Validate one human command against the state machine and the lease rule; the label plan is CP-shaped (silent). */
export function planHumanTransition(
  card: HumanTransitionCard,
  command: KanbanCommand,
  observed: ObservedIssue
): HumanTransitionPlan {
  const to: KanbanStatus = 'ready'
  if (!COMMAND_FROM[command].includes(card.status)) {
    return {
      ok: false,
      reason: 'wrong_status',
      refusalComment: humanRefusalComment(command, card.status, 'wrong_status')
    }
  }
  if (card.leased && !LEASED_HUMAN_STATUSES.has(to)) {
    return { ok: false, reason: 'leased', refusalComment: humanRefusalComment(command, card.status, 'leased') }
  }
  if (!canTransition(card.status, to)) {
    return { ok: false, reason: 'illegal', refusalComment: humanRefusalComment(command, card.status, 'illegal') }
  }
  return { ok: true, from: card.status, to, plan: planStatusWrite(to, observed) }
}

/** Fixed-template refusal (4.10): names only the command, labels, and a reason code, never issue or comment content. */
export function humanRefusalComment(
  command: KanbanCommand,
  status: KanbanStatus,
  reason: HumanTransitionRefusal
): string {
  const label = (s: KanbanStatus) => `\`${statusLabel(s)}\``
  const head = `AgentConnect Kanban: \`/kanban ${command}\` was not applied (${reason}).`
  switch (reason) {
    case 'wrong_status':
      return `${head} It applies to ${COMMAND_FROM[command].map(label).join(', ')} cards; this card is ${label(status)}.`
    case 'leased':
      return (
        `${head} This card is leased to a running agent, so only ` +
        `${[...LEASED_HUMAN_STATUSES].map(label).join(', ')} are accepted until the lease ends.`
      )
    case 'illegal':
      return `${head} ${label(status)} cannot move to ${label('ready')}.`
    case 'no_write':
      return `${head} Only collaborators with write access can move a card; it stays ${label(status)}.`
  }
}
