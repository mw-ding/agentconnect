// @vitest-environment happy-dom
// The Kanban client against a stubbed fetch: URLs, bodies, title chunking, and the stable error code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, setApiOrgId } from '@/lib/api'
import {
  explainKanbanCard,
  getKanbanBoard,
  getKanbanCardTitles,
  KANBAN_TITLES_MAX,
  kanbanErrorCode,
  listKanbanBoards,
  listKanbanCards,
  setKanbanBoardMode,
  setKanbanCardMode
} from './kanban-api'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let fetchMock: ReturnType<typeof vi.fn>
const call = (n: number) => {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit | undefined]
  return {
    url: String(url),
    method: init?.method ?? 'GET',
    body: init?.body ? JSON.parse(String(init.body)) : undefined
  }
}

beforeEach(() => {
  setApiOrgId('org-1')
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  setApiOrgId(null)
  vi.unstubAllGlobals()
})

describe('kanban client reads', () => {
  it('unwraps the board list and reads one board under the active org', async () => {
    fetchMock.mockResolvedValueOnce(json({ boards: [{ id: 'b1', name: 'web' }] }))
    fetchMock.mockResolvedValueOnce(json({ id: 'b1', name: 'web' }))
    expect(await listKanbanBoards()).toEqual([{ id: 'b1', name: 'web' }])
    await getKanbanBoard('b1')
    expect(call(0).url).toMatch(/\/orgs\/org-1\/kanban\/boards$/)
    expect(call(1).url).toMatch(/\/orgs\/org-1\/kanban\/boards\/b1$/)
  })

  it('reads the cards and one card explanation', async () => {
    fetchMock.mockResolvedValueOnce(json({ boardId: 'b1', cards: [], total: 0, truncated: false }))
    fetchMock.mockResolvedValueOnce(json({ cardId: 'c1', verdict: { eligible: false, gate: 'cooldown' }, hint: 'h' }))
    await listKanbanCards('b1')
    const explained = await explainKanbanCard('b1', 'c1')
    expect(call(0).url).toMatch(/\/kanban\/boards\/b1\/cards$/)
    expect(call(1).url).toMatch(/\/kanban\/boards\/b1\/cards\/c1\/explain$/)
    expect(explained.verdict.gate).toBe('cooldown')
  })
})

describe('getKanbanCardTitles', () => {
  const titleFor = (n: number) => ({ title: `t${n}`, state: 'open', htmlUrl: `https://github.com/a/b/issues/${n}` })

  it('requests at most the CP’s limit per call and merges the chunks', async () => {
    const numbers = Array.from({ length: KANBAN_TITLES_MAX + 20 }, (_, i) => i + 1)
    fetchMock.mockImplementation(async (url: string) => {
      const asked = new URL(String(url), 'http://x').searchParams.get('numbers')!.split(',').map(Number)
      return json({ titles: Object.fromEntries(asked.map((n) => [String(n), titleFor(n)])), missing: [] })
    })
    const result = await getKanbanCardTitles('b1', numbers)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(call(0).url).toContain(`numbers=${numbers.slice(0, 100).join(',')}`)
    expect(Object.keys(result.titles)).toHaveLength(120)
    expect(result.failed).toBe(false)
  })

  it('keeps the chunks that loaded and flags the one that failed', async () => {
    const numbers = Array.from({ length: 101 }, (_, i) => i + 1)
    fetchMock.mockResolvedValueOnce(json({ titles: { '1': titleFor(1) }, missing: [] }))
    fetchMock.mockResolvedValueOnce(json({ message: 'down', code: 'github_unavailable' }, 502))
    const result = await getKanbanCardTitles('b1', numbers)
    expect(Object.keys(result.titles)).toEqual(['1'])
    expect(result.failed).toBe(true)
  })

  it('makes no request for no cards', async () => {
    expect(await getKanbanCardTitles('b1', [])).toEqual({ titles: {}, failed: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('kanban client writes', () => {
  it('PUTs the board mode and the card override, with null clearing the override', async () => {
    fetchMock.mockImplementation(async () => json({ ok: true }))
    await setKanbanBoardMode('b1', 'write')
    await setKanbanCardMode('b1', 'c1', 'read')
    await setKanbanCardMode('b1', 'c1', null)
    expect(call(0)).toMatchObject({ method: 'PUT', body: { mode: 'write' } })
    expect(call(0).url).toMatch(/\/kanban\/boards\/b1\/mode$/)
    expect(call(1)).toMatchObject({ method: 'PUT', body: { mode: 'read' } })
    expect(call(1).url).toMatch(/\/kanban\/boards\/b1\/cards\/c1\/mode$/)
    expect(call(2).body).toEqual({ mode: null })
  })

  it('surfaces the interactive-auth refusal as a stable code', async () => {
    fetchMock.mockImplementation(async () =>
      json({ message: 'interactive sign-in required', code: 'INTERACTIVE_AUTH_REQUIRED' }, 403)
    )
    const err = await setKanbanBoardMode('b1', 'write').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(kanbanErrorCode(err)).toBe('INTERACTIVE_AUTH_REQUIRED')
    expect(kanbanErrorCode(new Error('x'))).toBeUndefined()
  })
})
