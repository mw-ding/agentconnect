import { describe, expect, it, vi } from 'vitest'
import { executeTool, type OpsDeps, type SessionContext } from '../../src/mcp/ops.js'
import { KANBAN_TOOLS } from '../../src/mcp/tools.js'

const ctx: SessionContext = {
  agentId: '33333333-3333-4333-8333-333333333333',
  platform: 'hook',
  isDm: false,
  channel: 'github:123',
  thread: '42',
  deliveryThread: '42',
  transportScope: 'github:123',
  tools: KANBAN_TOOLS,
  integrations: []
}

function deps(record = vi.fn(async () => ({ recorded: true }))): { deps: OpsDeps; record: typeof record } {
  return { deps: { recordKanbanTerminal: record } as unknown as OpsDeps, record }
}

describe('kanban terminal tools', () => {
  it('binds the call to the session and never forwards lease, revision, or epoch arguments', async () => {
    const { deps: d, record } = deps()
    await executeTool(ctx, 'kanbanComplete', { summary: ' shipped ' }, d)
    expect(record).toHaveBeenCalledWith({
      agentId: ctx.agentId,
      platform: 'hook',
      channel: 'github:123',
      thread: '42',
      transportScope: 'github:123',
      terminal: { outcome: 'completed', summary: 'shipped' }
    })
    await expect(
      executeTool(ctx, 'kanbanComplete', { summary: 'x', leaseId: '44444444-4444-4444-8444-444444444444' }, d)
    ).rejects.toThrow(/unexpected argument: leaseId/)
    await expect(
      executeTool(ctx, 'kanbanRequestReview', { summary: 'x', dispatchRevision: '3', epoch: 4 }, d)
    ).rejects.toThrow(/unexpected argument/)
  })

  it('requires a summary, and a reason for blocked and failed', async () => {
    const { deps: d, record } = deps()
    await expect(executeTool(ctx, 'kanbanComplete', {}, d)).rejects.toThrow(/summary/)
    await expect(executeTool(ctx, 'kanbanFail', { summary: 'no' }, d)).rejects.toThrow(/reason/)
    await expect(executeTool(ctx, 'kanbanBlock', { summary: 'no', reason: 'why' }, d)).rejects.toThrow(/kind/)
    await executeTool(ctx, 'kanbanRequestReview', { summary: 'ready', prNumber: 7 }, d)
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ terminal: { outcome: 'review_requested', summary: 'ready', prNumber: 7 } })
    )
    await executeTool(ctx, 'kanbanBlock', { summary: 'waiting', kind: 'dependency', reason: 'needs #9' }, d)
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: {
          outcome: 'blocked',
          blockKind: 'dependency',
          reasonCode: 'agent_blocked',
          summary: 'waiting',
          reason: 'needs #9'
        }
      })
    )
    await executeTool(ctx, 'kanbanFail', { summary: 'gave up', reason: 'tests red' }, d)
    expect(record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        terminal: { outcome: 'failed', reasonCode: 'agent_failed', summary: 'gave up', reason: 'tests red' }
      })
    )
  })

  it('surfaces a refused second call and a missing lease as tool errors', async () => {
    const record = vi.fn(async () => {
      throw new Error('This Kanban card run already reported its outcome; only the first terminal call counts.')
    })
    const { deps: d } = deps(record)
    await expect(executeTool(ctx, 'kanbanRequestReview', { summary: 'again' }, d)).rejects.toThrow(/already reported/)
    await expect(executeTool(ctx, 'kanbanComplete', { summary: 'x' }, {} as OpsDeps)).rejects.toThrow(/unavailable/)
  })
})
