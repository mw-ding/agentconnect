// Human-action gate and transition planner: the authz reason matrix and every command × status, leased or not.
import { describe, expect, it, vi } from 'vitest'
import type { RepoPermissionLevel, RepoPermissionLookup } from '../github/repo-permission.js'
import { KANBAN_STATUSES, statusLabel, type KanbanStatus, type ObservedIssue } from './card-state.js'
import { isAttestedHumanAuthority } from './human-authority.js'
import {
  authorizeHumanKanbanAction,
  humanRefusalComment,
  KANBAN_COMMANDS,
  planHumanTransition,
  type KanbanCommand,
  type KanbanHumanActor
} from './human-action.js'

const REPO = { installationId: 1n, repoId: 42n, repoFullName: 'acme/web' }

function lookup(level: RepoPermissionLevel | Error): RepoPermissionLookup & { permission: ReturnType<typeof vi.fn> } {
  return {
    permission: vi.fn(async () => {
      if (level instanceof Error) throw level
      return level
    })
  }
}

const authorize = (actor: KanbanHumanActor, permissions: RepoPermissionLookup) =>
  authorizeHumanKanbanAction({ repo: REPO, actor, appSlug: 'agentconnect', permissions })

describe('authorizeHumanKanbanAction', () => {
  it.each(['admin', 'maintain', 'write'] as const)(
    'accepts a human with %s and attests the authority',
    async (level) => {
      const permissions = lookup(level)
      const result = await authorize({ login: 'Alice', type: 'User', id: 7 }, permissions)
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('narrow')
      expect(isAttestedHumanAuthority(result.authority)).toBe(true)
      expect(result.authority).toMatchObject({ login: 'Alice', permission: level })
      // The login is compared case-insensitively by GitHub; the lookup key is normalised.
      expect(permissions.permission).toHaveBeenCalledWith(REPO, 'alice')
    }
  )

  it.each(['triage', 'read', 'none'] as const)('refuses a human with %s as no_write', async (level) => {
    expect(await authorize({ login: 'bob', type: 'User' }, lookup(level))).toEqual({ ok: false, reason: 'no_write' })
  })

  it('fails closed when the live lookup throws', async () => {
    const err = new Error('github 502')
    expect(await authorize({ login: 'bob', type: 'User' }, lookup(err))).toEqual({
      ok: false,
      reason: 'lookup_failed',
      error: err
    })
  })

  it('refuses this App as app_actor without a lookup (B8: an agent cannot unblock its own card)', async () => {
    const permissions = lookup('admin')
    expect(await authorize({ login: 'agentconnect[bot]', type: 'Bot' }, permissions)).toEqual({
      ok: false,
      reason: 'app_actor'
    })
    expect(permissions.permission).not.toHaveBeenCalled()
  })

  it.each<[string, KanbanHumanActor]>([
    ['another bot', { login: 'dependabot[bot]', type: 'Bot' }],
    ['a [bot] login typed as User', { login: 'evil[bot]', type: 'User' }],
    ['an organization', { login: 'acme', type: 'Organization' }],
    ['an unknown type', { login: 'alice' }],
    ['an App acting for a user', { login: 'alice', type: 'User', viaApp: true }],
    ['an empty login', { login: '', type: 'User' }]
  ])('refuses %s as not_human without a lookup', async (_name, actor) => {
    const permissions = lookup('admin')
    expect(await authorize(actor, permissions)).toEqual({ ok: false, reason: 'not_human' })
    expect(permissions.permission).not.toHaveBeenCalled()
  })

  it('without an App slug a Bot is still never a human', async () => {
    const result = await authorizeHumanKanbanAction({
      repo: REPO,
      actor: { login: 'agentconnect[bot]', type: 'Bot' },
      appSlug: undefined,
      permissions: lookup('admin')
    })
    expect(result).toEqual({ ok: false, reason: 'not_human' })
  })
})

const OPEN: ObservedIssue = { labels: ['bug'], state: 'open' }
const observedFor = (status: KanbanStatus): ObservedIssue => {
  if (status === 'done') return { labels: [statusLabel('done')], state: 'closed', stateReason: 'completed' }
  if (status === 'archived') return { labels: [statusLabel('archived')], state: 'closed', stateReason: 'not_planned' }
  return { labels: ['bug', statusLabel(status)], state: 'open' }
}

const APPLIES: Record<KanbanCommand, readonly KanbanStatus[]> = {
  unblock: ['blocked'],
  reopen: ['done'],
  ready: ['todo', 'triage']
}

describe('planHumanTransition', () => {
  for (const command of KANBAN_COMMANDS) {
    for (const status of KANBAN_STATUSES) {
      for (const leased of [false, true]) {
        const applies = APPLIES[command].includes(status)
        const expected = !applies ? 'wrong_status' : leased ? 'leased' : 'ready'
        it(`/kanban ${command} on ${leased ? 'leased ' : ''}${status} → ${expected}`, () => {
          const result = planHumanTransition({ status, leased }, command, observedFor(status))
          if (expected === 'ready') {
            expect(result.ok).toBe(true)
            if (!result.ok) throw new Error('narrow')
            expect(result).toMatchObject({ from: status, to: 'ready' })
            expect(result.plan.status).toBe('ready')
            expect(result.plan.addLabels).toEqual([statusLabel('ready')])
            expect(result.plan.removeLabels).toEqual([statusLabel(status)])
            expect(result.plan.comment).toBeUndefined()
            expect(result.plan.releaseLease).toBe(false)
          } else {
            expect(result).toMatchObject({ ok: false, reason: expected })
            if (result.ok) throw new Error('narrow')
            expect(result.refusalComment).toContain(`/kanban ${command}`)
            expect(result.refusalComment).toContain(expected)
          }
        })
      }
    }
  }

  it('reopen reopens a closed issue as part of the plan', () => {
    const result = planHumanTransition({ status: 'done', leased: false }, 'reopen', observedFor('done'))
    if (!result.ok) throw new Error('narrow')
    expect(result.plan.issueState).toEqual({ state: 'open' })
  })

  it('unblock on an issue whose label already moved writes only what is missing', () => {
    const result = planHumanTransition({ status: 'blocked', leased: false }, 'unblock', {
      labels: [statusLabel('ready')],
      state: 'open'
    })
    if (!result.ok) throw new Error('narrow')
    expect(result.plan).toMatchObject({ outcome: 'noop', addLabels: [], removeLabels: [] })
  })

  it('ready on a label-less triage card adds the ready label', () => {
    const result = planHumanTransition({ status: 'triage', leased: false }, 'ready', OPEN)
    if (!result.ok) throw new Error('narrow')
    expect(result.plan.addLabels).toEqual([statusLabel('ready')])
  })
})

describe('humanRefusalComment', () => {
  it('is one fixed-template line naming only the command, labels, and the reason code', () => {
    for (const reason of ['wrong_status', 'leased', 'illegal', 'no_write'] as const) {
      const text = humanRefusalComment('unblock', 'running', reason)
      expect(text.startsWith('AgentConnect Kanban: `/kanban unblock` was not applied')).toBe(true)
      expect(text).toContain(`(${reason})`)
      expect(text.includes('\n')).toBe(false)
    }
    expect(humanRefusalComment('reopen', 'ready', 'wrong_status')).toContain('`ac/status:done`')
    expect(humanRefusalComment('ready', 'blocked', 'wrong_status')).toContain('`ac/status:todo`, `ac/status:triage`')
  })
})
