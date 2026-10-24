import { describe, expect, it, vi } from 'vitest'
import { KANBAN_STATUSES, type KanbanStatus } from './card-state.js'
import { planNotification, type KanbanTransition } from './notifier.js'
import {
  KANBAN_NOTIFY_LEASE_MS,
  KANBAN_NOTIFY_MAX_ATTEMPTS,
  KanbanNotifier,
  notifyBackoffMs
} from './notifier-sender.js'
import type { KanbanNotificationRow, KanbanNotifyRepo, KanbanNotifyTarget } from '../persistence/ports.js'
import { FakeClock } from '../../test/fakes/fake-clock.js'

const base = { cardId: 'c', boardId: 'b', issueNumber: 7 }
const tr = (from: KanbanStatus, to: KanbanStatus, extra: Partial<KanbanTransition> = {}): KanbanTransition => ({
  ...base,
  from,
  to,
  ...extra
})
const board = { targetChannel: 'C0ANCHOR' }

describe('planNotification', () => {
  it('notifies exactly the entered statuses across the whole from×to table', () => {
    const notified: string[] = []
    for (const from of KANBAN_STATUSES)
      for (const to of KANBAN_STATUSES) {
        if (planNotification(tr(from, to), board).notify) notified.push(`${from}>${to}`)
      }
    const entering = (to: string) => KANBAN_STATUSES.filter((s) => s !== to).map((s) => `${s}>${to}`)
    expect(notified.sort()).toEqual(
      [...entering('blocked'), ...entering('review'), ...entering('done'), ...entering('archived')].sort()
    )
  })

  it('mentions the requester only when a card blocks for needs_input', () => {
    expect(planNotification(tr('running', 'blocked', { blockKind: 'needs_input' }), board)).toEqual({
      notify: true,
      mention: true
    })
    expect(planNotification(tr('running', 'blocked', { blockKind: 'dependency' as never }), board).mention).toBe(false)
    expect(planNotification(tr('running', 'review'), board).mention).toBe(false)
  })

  it('notifies triage only with a tripped limit or an attention reason', () => {
    expect(planNotification(tr('running', 'triage'), board).notify).toBe(false)
    expect(planNotification(tr('running', 'triage', { tripped: 'review_round_limit' }), board).notify).toBe(true)
    expect(planNotification(tr('review', 'triage', { reasonCode: 'verifier_is_worker' }), board).notify).toBe(true)
  })

  it('notifies ready only when a verify run sent a review card back', () => {
    expect(planNotification(tr('review', 'ready', { role: 'verify' }), board).notify).toBe(true)
    expect(planNotification(tr('review', 'ready'), board).notify).toBe(false)
    expect(planNotification(tr('running', 'ready', { role: 'work' }), board).notify).toBe(false)
    expect(planNotification(tr('todo', 'ready'), board).notify).toBe(false)
    expect(planNotification(tr('blocked', 'ready', { reasonCode: 'comment_command' }), board).notify).toBe(true)
  })

  it('notifies explicit restarts and synthesis without mentioning the owner', () => {
    for (const reasonCode of ['restarted', 'synthesis']) {
      expect(planNotification(tr('todo', 'ready', { reasonCode }), board)).toEqual({ notify: true, mention: false })
      expect(planNotification(tr('todo', 'ready', { reasonCode }), { targetChannel: null }).notify).toBe(false)
    }
  })

  it('never notifies self-moves, running churn, or a headless board', () => {
    expect(planNotification(tr('review', 'review'), board).notify).toBe(false)
    expect(planNotification(tr('ready', 'running'), board).notify).toBe(false)
    expect(planNotification(tr('running', 'done'), { targetChannel: null }).notify).toBe(false)
  })
})

const INTEGRATION = '55555555-5555-4555-8555-555555555555'
const T0 = Date.parse('2026-10-15T12:00:00.000Z')

function row(over: Partial<KanbanNotificationRow> = {}): KanbanNotificationRow {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    boardId: '11111111-1111-4111-8111-111111111111',
    cardId: '22222222-2222-4222-8222-222222222222',
    issueNumber: 7,
    stateRevision: 3n,
    from: 'running',
    to: 'blocked',
    blockKind: 'needs_input',
    mention: true,
    createdAt: new Date(T0),
    attempts: 0,
    claims: 1,
    ...over
  }
}

function setup(
  opts: {
    rows?: KanbanNotificationRow[]
    target?: Partial<KanbanNotifyTarget> | null
    live?: boolean
    mention?: string | null
  } = {}
) {
  const target =
    opts.target === null
      ? null
      : ({
          orgId: 'org',
          repoFullName: 'acme/web',
          targetPlatform: 'slack',
          targetChannel: 'C0ANCHOR',
          targetIntegrationId: INTEGRATION,
          createdByUserId: 'u1',
          ...opts.target
        } as KanbanNotifyTarget)
  const rows = opts.rows ?? [row()]
  const repo = {
    claim: vi.fn(async (limit: number, _now: Date, _leaseUntil: Date, exclude: readonly string[] = []) =>
      rows.filter((r) => !exclude.includes(r.id)).slice(0, limit)
    ),
    release: vi.fn(async () => {}),
    target: vi.fn(async () => target),
    markSent: vi.fn(async () => {}),
    markFailed: vi.fn(async () => {}),
    giveUp: vi.fn(async () => {}),
    enqueue: vi.fn(async () => {})
  } satisfies KanbanNotifyRepo
  const send = vi.fn(async (_d: string, n: { notifyId: string }) => ({ notifyId: n.notifyId, ok: true }))
  const log = { warn: vi.fn(), info: vi.fn() }
  const notifier = new KanbanNotifier({
    repo,
    integration: { getUnscoped: async () => ({ id: INTEGRATION, agentId: 'agent', status: 'active' }) as never },
    agent: { get: async () => ({ id: 'agent', daemonId: 'daemon' }) as never },
    resolveMention: async () => opts.mention ?? null,
    liveDaemonIds: () => ((opts.live ?? true) ? ['daemon'] : []),
    send,
    clock: new FakeClock(T0),
    log
  })
  return { repo, send, log, notifier }
}

describe('KanbanNotifier', () => {
  it('sends a pending row to the owning daemon and marks it sent', async () => {
    const h = setup({ mention: 'U0REQUEST1' })
    await h.notifier.drain()
    expect(h.send).toHaveBeenCalledOnce()
    expect(h.send.mock.calls[0]![0]).toBe('daemon')
    expect(h.send.mock.calls[0]![1]).toMatchObject({
      repoFullName: 'acme/web',
      issueNumber: 7,
      to: 'blocked',
      blockKind: 'needs_input',
      mention: { slackUserId: 'U0REQUEST1' },
      target: { platform: 'slack', channel: 'C0ANCHOR', integrationId: INTEGRATION }
    })
    expect(h.repo.markSent).toHaveBeenCalledWith(row())
  })

  it('sends without a mention when none resolved (never a GitHub login)', async () => {
    const h = setup({ mention: null })
    await h.notifier.drain()
    expect(h.send.mock.calls[0]![1]).not.toHaveProperty('mention')
  })

  it('leaves the row pending while the daemon is offline', async () => {
    const h = setup({ live: false })
    await h.notifier.drain()
    expect(h.send).not.toHaveBeenCalled()
    expect(h.repo.markSent).not.toHaveBeenCalled()
    expect(h.repo.markFailed).not.toHaveBeenCalled()
  })

  it('drops a row whose board went headless without posting', async () => {
    const h = setup({ target: { targetChannel: null } })
    await h.notifier.drain()
    expect(h.send).not.toHaveBeenCalled()
    expect(h.repo.markSent).toHaveBeenCalled()
  })

  it('backs off exponentially on a refusal or a send error', async () => {
    const h = setup()
    h.send.mockResolvedValueOnce({ notifyId: row().id, ok: false })
    await h.notifier.drain()
    expect(h.repo.markFailed).toHaveBeenCalledWith(row(), new Date(T0 + notifyBackoffMs(1)), 1, 'daemon_refused')
    h.send.mockRejectedValueOnce(new Error('boom'))
    await h.notifier.drain()
    expect(h.repo.markFailed).toHaveBeenLastCalledWith(row(), new Date(T0 + notifyBackoffMs(1)), 1, 'delivery_failed')
    expect(notifyBackoffMs(2)).toBe(2 * notifyBackoffMs(1))
  })

  it('gives up with a warn after the attempt limit', async () => {
    const h = setup({ rows: [row({ attempts: KANBAN_NOTIFY_MAX_ATTEMPTS - 1 })] })
    h.send.mockRejectedValueOnce(new Error('boom'))
    await h.notifier.drain()
    expect(h.repo.giveUp).toHaveBeenCalledWith(row({ attempts: KANBAN_NOTIFY_MAX_ATTEMPTS - 1 }), 'delivery_failed')
    expect(h.repo.markFailed).not.toHaveBeenCalled()
    expect(h.log.warn).toHaveBeenCalled()
  })

  it('gives up at once on a board with no integration', async () => {
    const h = setup({ target: { targetIntegrationId: null } })
    await h.notifier.drain()
    expect(h.repo.giveUp).toHaveBeenCalledWith(row(), 'no_integration')
  })
})

describe('KanbanNotifier — claimed drain across replicas', () => {
  function claimed(rows: KanbanNotificationRow[], opts: { live?: boolean; ok?: boolean } = {}) {
    const repo = {
      // Honors the exclusion list as the SQL does, so a handed-back row is not re-claimed in the same pass.
      claim: vi.fn(async (limit: number, _now: Date, _leaseUntil: Date, exclude: readonly string[] = []) =>
        rows
          .filter((r) => !exclude.includes(r.id))
          .slice(0, limit)
          .map((r) => ({ ...r, claims: 1 }))
      ),
      release: vi.fn(async () => {}),
      target: vi.fn(
        async () =>
          ({
            orgId: 'org',
            repoFullName: 'acme/web',
            targetPlatform: 'slack',
            targetChannel: 'C0ANCHOR',
            targetIntegrationId: INTEGRATION,
            createdByUserId: 'u1'
          }) as KanbanNotifyTarget
      ),
      markSent: vi.fn(async () => {}),
      markFailed: vi.fn(async () => {}),
      giveUp: vi.fn(async () => {}),
      enqueue: vi.fn(async () => {})
    }
    const send = vi.fn(async (_d: string, n: { notifyId: string }) => ({ notifyId: n.notifyId, ok: opts.ok ?? true }))
    const notifier = new KanbanNotifier({
      repo: repo as never,
      integration: { getUnscoped: async () => ({ id: INTEGRATION, agentId: 'agent', status: 'active' }) as never },
      agent: { get: async () => ({ id: 'agent', daemonId: 'daemon' }) as never },
      resolveMention: async () => null,
      liveDaemonIds: () => ((opts.live ?? true) ? ['daemon'] : []),
      send,
      clock: new FakeClock(T0),
      log: { warn: vi.fn(), info: vi.fn() }
    })
    return { repo, send, notifier }
  }

  it('vera-414: claims a row under a lease before sending, then settles it under that claim', async () => {
    const h = claimed([row()])
    await h.notifier.drain()
    expect(h.repo.claim.mock.calls[0]!.slice(0, 3)).toEqual([1, new Date(T0), new Date(T0 + KANBAN_NOTIFY_LEASE_MS)])
    expect(h.send).toHaveBeenCalledOnce()
    expect(h.repo.claim.mock.invocationCallOrder[0]!).toBeLessThan(h.send.mock.invocationCallOrder[0]!)
    expect(h.repo.markSent).toHaveBeenCalledWith(expect.objectContaining({ id: row().id, claims: 1 }))
  })

  it('vera-414: hands a row back when this replica has no live connection to its daemon', async () => {
    const h = claimed([row()], { live: false })
    await h.notifier.drain()
    expect(h.send).not.toHaveBeenCalled()
    expect(h.repo.release).toHaveBeenCalledWith(expect.objectContaining({ id: row().id, claims: 1 }))
    expect(h.repo.markSent).not.toHaveBeenCalled()
    expect(h.repo.markFailed).not.toHaveBeenCalled()
  })

  it('vera-414: tries each row at most once per pass and settles a failure under its claim', async () => {
    const rows = ['a', 'b', 'c'].map((c) => row({ id: `66666666-6666-4666-8666-66666666666${c}` }))
    const h = claimed(rows, { ok: false })
    await h.notifier.drain()
    expect(h.send.mock.calls.map(([, n]) => n.notifyId)).toEqual(rows.map((r) => r.id))
    expect(h.repo.markFailed).toHaveBeenCalledTimes(3)
    expect(h.repo.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: rows[0]!.id, claims: 1 }),
      new Date(T0 + notifyBackoffMs(1)),
      1,
      'daemon_refused'
    )
  })
})

describe('vera-414-merge: KanbanNotifier lease time and liveness', () => {
  function drainer(rows: KanbanNotificationRow[], opts: { live?: string[]; sendMs?: number; ok?: boolean } = {}) {
    const clock = new FakeClock(T0)
    let live = opts.live ?? ['daemon']
    const repo = {
      claim: vi.fn(
        async (
          limit: number,
          _now: Date,
          _leaseUntil: Date,
          exclude: readonly string[] = [],
          liveIds?: readonly string[]
        ) =>
          // Mirrors the SQL: a row whose board posts through a daemon live on no connection here is never claimed.
          liveIds && !liveIds.includes('daemon')
            ? []
            : rows
                .filter((r) => !exclude.includes(r.id))
                .slice(0, limit)
                .map((r) => ({ ...r, claims: 1 }))
      ),
      release: vi.fn(async () => {}),
      target: vi.fn(
        async () =>
          ({
            orgId: 'org',
            repoFullName: 'acme/web',
            targetPlatform: 'slack',
            targetChannel: 'C0ANCHOR',
            targetIntegrationId: INTEGRATION,
            createdByUserId: 'u1'
          }) as KanbanNotifyTarget
      ),
      markSent: vi.fn(async () => {}),
      markFailed: vi.fn(async (_row: KanbanNotificationRow, _next: Date, _attempts: number, _error: string) => {}),
      giveUp: vi.fn(async () => {}),
      enqueue: vi.fn(async () => {})
    }
    const send = vi.fn(async (_d: string, n: { notifyId: string }) => {
      // Each send takes real time on the CP's clock, as a slow daemon ack does.
      clock.advance(opts.sendMs ?? 0)
      return { notifyId: n.notifyId, ok: opts.ok ?? true }
    })
    const notifier = new KanbanNotifier({
      repo: repo as never,
      integration: { getUnscoped: async () => ({ id: INTEGRATION, agentId: 'agent', status: 'active' }) as never },
      agent: { get: async () => ({ id: 'agent', daemonId: 'daemon' }) as never },
      resolveMention: async () => null,
      liveDaemonIds: () => live,
      send,
      clock,
      log: { warn: vi.fn(), info: vi.fn() }
    })
    return { repo, send, notifier, clock, setLive: (ids: string[]) => (live = ids) }
  }
  const ids = ['a', 'b', 'c'].map((c) => `66666666-6666-4666-8666-66666666666${c}`)

  it('vera-414-merge: 5 each row is claimed at its own claim time, with a lease measured from that moment', async () => {
    const h = drainer(
      ids.map((id) => row({ id })),
      { sendMs: 4 * 60_000 }
    )
    await h.notifier.drain()
    // Three 4-minute sends: a pass-start lease would already have lapsed for the second and third rows.
    expect(h.repo.claim.mock.calls.map(([, now, leaseUntil]) => [now, leaseUntil])).toEqual([
      [new Date(T0), new Date(T0 + KANBAN_NOTIFY_LEASE_MS)],
      [new Date(T0 + 4 * 60_000), new Date(T0 + 4 * 60_000 + KANBAN_NOTIFY_LEASE_MS)],
      [new Date(T0 + 8 * 60_000), new Date(T0 + 8 * 60_000 + KANBAN_NOTIFY_LEASE_MS)],
      [new Date(T0 + 12 * 60_000), new Date(T0 + 12 * 60_000 + KANBAN_NOTIFY_LEASE_MS)]
    ])
    expect(h.send).toHaveBeenCalledTimes(3)
  })

  it('vera-414-merge: 5 a failed row backs off from its own claim time, not the pass start', async () => {
    const h = drainer(
      ids.slice(0, 2).map((id) => row({ id })),
      { sendMs: 60_000, ok: false }
    )
    await h.notifier.drain()
    expect(h.repo.markFailed.mock.calls.map(([r, next]) => [r.id, next])).toEqual([
      [ids[0], new Date(T0 + notifyBackoffMs(1))],
      [ids[1], new Date(T0 + 60_000 + notifyBackoffMs(1))]
    ])
  })

  it('vera-414-merge: 6 a replica without the daemon claims nothing, so it neither releases nor bumps a claim', async () => {
    const h = drainer([row()], { live: ['other-daemon'] })
    for (let i = 0; i < 3; i++) await h.notifier.drain()
    // The live set rides every claim, so the SQL can leave the row to the replica that holds the daemon.
    expect(h.repo.claim.mock.calls.map((c) => c[4])).toEqual([['other-daemon'], ['other-daemon'], ['other-daemon']])
    expect(h.repo.release).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
    h.setLive(['daemon'])
    await h.notifier.drain()
    expect(h.send).toHaveBeenCalledOnce()
    expect(h.repo.markSent).toHaveBeenCalledOnce()
  })

  it('vera-414-merge: 6 a daemon that drops between claim and send is still handed back at once', async () => {
    const h = drainer([row()])
    h.repo.claim.mockImplementationOnce(async () => {
      // The daemon disconnects from this replica right after the claim landed.
      h.setLive([])
      return [{ ...row(), claims: 1 }]
    })
    await h.notifier.drain()
    expect(h.send).not.toHaveBeenCalled()
    expect(h.repo.release).toHaveBeenCalledWith(expect.objectContaining({ id: row().id, claims: 1 }))
  })
})
