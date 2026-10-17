import { describe, expect, it, vi } from 'vitest'
import { kanbanTokenSource } from './tokens.js'

describe('kanbanTokenSource', () => {
  it('keeps the App token service when it is configured', () => {
    const app = { mintKanbanCard: vi.fn(), mintKanbanRun: vi.fn(), mintKanbanOrchestratorWrite: vi.fn() }
    const log = { warn: vi.fn() }
    expect(kanbanTokenSource({ app, injectedToken: 'ghp_test', log })).toBe(app)
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('logs and serves the injected token when the App is not configured', async () => {
    const log = { warn: vi.fn() }
    const tokens = kanbanTokenSource({ injectedToken: ' ghp_test ', log })
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('GitHub App is not configured'))
    await expect(tokens!.mintKanbanCard(1n, 'acme/web', 7n, 'write')).resolves.toMatchObject({
      token: 'ghp_test',
      repoFullName: 'acme/web',
      access: 'write'
    })
    await expect(tokens!.mintKanbanRun(1n, 'acme/web', 7n, 'read')).resolves.toMatchObject({
      token: 'ghp_test',
      access: 'read'
    })
    await expect(tokens!.mintKanbanOrchestratorWrite(1n, 'acme/web', 7n)).resolves.toMatchObject({
      token: 'ghp_test',
      access: 'write'
    })
  })

  it('is absent when neither source is configured', () => {
    expect(kanbanTokenSource({})).toBeUndefined()
  })
})
