// Kanban transition notifier (issue #2 M4): drains the notification outbox to the board's anchor channel through the owning daemon.
import type { KanbanNotify, KanbanNotifyOk } from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'
import type { AgentRecord, IntegrationRecord, KanbanNotifyRepo, KanbanNotificationRow } from '../persistence/ports.js'

/** A row is retried with exponential backoff up to this many attempts, then parked with a warn + lastError. */
export const KANBAN_NOTIFY_MAX_ATTEMPTS = 8
const KANBAN_NOTIFY_BASE_MS = 15_000
const KANBAN_NOTIFY_BATCH = 25

export interface KanbanNotifierDeps {
  repo: KanbanNotifyRepo
  integration: { getUnscoped(id: string): Promise<IntegrationRecord | null> }
  agent: { get(orgId: string, agentId: string): Promise<AgentRecord | null> }
  /** The board owner's Slack user id, resolved through a CP linkage only; null when none exists (never a GitHub login). */
  resolveMention(orgId: string, userId: string | null): Promise<string | null>
  /** The daemon's live control connection; an offline daemon leaves the row pending. */
  isDaemonLive(daemonId: string): boolean
  send(daemonId: string, notify: KanbanNotify): Promise<KanbanNotifyOk>
  clock: Clock
  log: { warn(obj: unknown, msg?: string): void; info(obj: unknown, msg?: string): void }
}

export function notifyBackoffMs(attempts: number): number {
  return Math.min(KANBAN_NOTIFY_BASE_MS * 2 ** Math.max(0, attempts - 1), 15 * 60_000)
}

export class KanbanNotifier {
  private draining?: Promise<void>

  constructor(private readonly deps: KanbanNotifierDeps) {}

  /** Single-flight drain; called on the dispatcher's poke and tick. */
  drain(): Promise<void> {
    this.draining ??= this.pass().finally(() => {
      this.draining = undefined
    })
    return this.draining
  }

  private async pass(): Promise<void> {
    const now = new Date(this.deps.clock.now())
    let rows: KanbanNotificationRow[]
    try {
      rows = await this.deps.repo.pending(KANBAN_NOTIFY_BATCH, now)
    } catch (err) {
      this.deps.log.warn({ err }, 'kanban: notification outbox read failed')
      return
    }
    for (const row of rows) await this.sendOne(row, now)
  }

  private async sendOne(row: KanbanNotificationRow, now: Date): Promise<void> {
    const target = await this.deps.repo.target(row.boardId)
    if (!target || target.targetChannel == null) {
      // The board went headless or is gone: nothing to post, and the row has no future either.
      await this.deps.repo.markSent(row.id)
      return
    }
    const integrationId = target.targetIntegrationId
    if (!integrationId) return await this.giveUp(row, 'no_integration')
    const integration = await this.deps.integration.getUnscoped(integrationId)
    if (!integration || integration.status !== 'active') return await this.retry(row, now, 'integration_missing')
    const agent = await this.deps.agent.get(target.orgId, integration.agentId)
    const daemonId = agent?.daemonId
    if (!daemonId) return await this.retry(row, now, 'agent_unplaced')
    if (!this.deps.isDaemonLive(daemonId)) return // stays pending until the daemon reconnects

    let mention: KanbanNotify['mention']
    if (row.mention) {
      const slackUserId = await this.deps.resolveMention(target.orgId, target.createdByUserId)
      if (slackUserId) mention = { slackUserId }
    }
    try {
      const reply = await this.deps.send(daemonId, {
        notifyId: row.id,
        boardId: row.boardId,
        cardId: row.cardId,
        repoFullName: target.repoFullName,
        issueNumber: row.issueNumber,
        from: row.from,
        to: row.to,
        ...(row.blockKind ? { blockKind: row.blockKind } : {}),
        ...(row.reasonCode ? { reasonCode: row.reasonCode } : {}),
        ...(row.tripped ? { tripped: row.tripped } : {}),
        ...(mention ? { mention } : {}),
        target: { platform: target.targetPlatform, channel: target.targetChannel, integrationId }
      })
      if (reply.ok) await this.deps.repo.markSent(row.id)
      else await this.retry(row, now, 'daemon_refused')
    } catch {
      await this.retry(row, now, 'delivery_failed')
    }
  }

  private async retry(row: KanbanNotificationRow, now: Date, lastError: string): Promise<void> {
    const attempts = row.attempts + 1
    if (attempts >= KANBAN_NOTIFY_MAX_ATTEMPTS) await this.giveUp(row, lastError)
    else
      await this.deps.repo.markFailed(row.id, new Date(now.getTime() + notifyBackoffMs(attempts)), attempts, lastError)
  }

  private async giveUp(row: KanbanNotificationRow, lastError: string): Promise<void> {
    await this.deps.repo.giveUp(row.id, lastError)
    this.deps.log.warn(
      { notifyId: row.id, issueNumber: row.issueNumber, attempts: row.attempts, lastError },
      'kanban: transition notification gave up'
    )
  }
}
