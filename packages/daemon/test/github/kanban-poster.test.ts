import { describe, expect, it, vi } from 'vitest'
import { GithubFinalPoster } from '../../src/github/poster.js'
import { kanbanCommentToken, kanbanFinalPoster } from '../../src/github/kanban-poster.js'

describe('kanban final poster token', () => {
  it('uses the App mint and does not log when the App is configured', () => {
    const mint = vi.fn(async () => 'ghs_poster')
    const log = { warn: vi.fn() }
    expect(kanbanCommentToken({ mint, injected: async () => 'ghp_test', log })).toBe(mint)
    expect(log.warn).not.toHaveBeenCalled()
    expect(kanbanFinalPoster({ repo: 'acme/web', issueNumber: 7, log, mint })).toBeInstanceOf(GithubFinalPoster)
  })

  it('logs and uses the injected token when the App is not configured', async () => {
    const log = { warn: vi.fn() }
    const token = kanbanCommentToken({ log, injected: async () => 'ghp_test' })
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('injected token'))
    await expect(token()).resolves.toBe('ghp_test')
    expect(
      kanbanFinalPoster({ repo: 'acme/web', issueNumber: 7, log, injected: async () => 'ghp_test' })
    ).toBeInstanceOf(GithubFinalPoster)
  })

  it('refuses to build a token when neither source exists', () => {
    expect(() => kanbanCommentToken({ log: { warn: vi.fn() } })).toThrow(/no token source/)
  })
})
