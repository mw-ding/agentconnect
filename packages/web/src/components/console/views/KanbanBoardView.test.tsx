// @vitest-environment happy-dom
// The Kanban board view: columns from CP metadata, live titles merged in as plain text, explain disclosure, owner mode controls.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setApiOrgId } from '@/lib/api'
import type { KanbanBoardDto, KanbanCardMetaDto } from '@/lib/kanban-api'

vi.mock('next/navigation', () => ({ useParams: () => ({ boardId: 'board-1' }), useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-test' }, myRole: 'owner', orgPath: (path: string) => path })
}))

import KanbanBoardView from './KanbanBoardView'
import KanbanBoardsView from './KanbanBoardsView'

const BOARD: KanbanBoardDto = {
  id: 'board-1',
  name: 'web',
  repoFullName: 'acme/web',
  defaultMode: 'read',
  enabled: true,
  maxInProgress: 2,
  maxInProgressPerAgent: 1,
  canEdit: true
}

function card(n: number, over: Partial<KanbanCardMetaDto> = {}): KanbanCardMetaDto {
  return {
    id: `card-${n}`,
    issueNumber: n,
    status: 'ready',
    assigneeAgentId: null,
    assignee: null,
    priority: 0,
    mode: 'read',
    modeOverride: null,
    needsAttention: false,
    attentionReason: null,
    blockKind: null,
    consecutiveFailures: 0,
    protocolViolations: 0,
    blockRecurrence: 0,
    cooldownUntil: null,
    notBefore: null,
    promotionPending: false,
    linkedPrNumber: null,
    stateRevision: '1',
    openRun: null,
    ...over
  }
}

const liveTitle = (n: number, title: string) => ({
  title,
  state: 'open',
  htmlUrl: `https://github.com/acme/web/issues/${n}`
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface Server {
  board?: KanbanBoardDto
  cards?: KanbanCardMetaDto[]
  titles?: Record<string, ReturnType<typeof liveTitle>> | 'fail'
  explain?: unknown
  put?: (path: string, body: unknown) => Response
}

let host: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>
const puts: Array<{ path: string; body: unknown }> = []

function serve(server: Server) {
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(String(input), 'http://x').pathname
    const method = init?.method ?? 'GET'
    if (method === 'PUT') {
      const body = JSON.parse(String(init?.body))
      puts.push({ path, body })
      return server.put ? server.put(path, body) : json({ ok: true })
    }
    if (path.endsWith('/cards/titles')) {
      return server.titles === 'fail'
        ? json({ message: 'down', code: 'github_unavailable' }, 502)
        : json({ titles: server.titles ?? {}, missing: [] })
    }
    if (path.endsWith('/explain')) return json(server.explain)
    if (path.endsWith('/cards')) {
      const cards = server.cards ?? []
      return json({ boardId: 'board-1', cards, total: cards.length, truncated: false })
    }
    if (path.endsWith('/kanban/boards')) return json({ boards: [server.board ?? BOARD] })
    return json(server.board ?? BOARD)
  })
  vi.stubGlobal('fetch', fetchMock)
}

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</SWRConfig>)
  })
}

async function settleUntil(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    if (done()) return
  }
  throw new Error('view did not settle')
}

const tile = (n: number) => host.querySelector(`[data-testid="kanban-card-${n}"]`) as HTMLElement | null
const column = (status: string) => host.querySelector(`[data-testid="kanban-column-${status}"]`) as HTMLElement
const button = (label: string, within: ParentNode = host) =>
  [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  setApiOrgId('org-test')
  puts.length = 0
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  setApiOrgId(null)
  vi.unstubAllGlobals()
})

describe('KanbanBoardView columns and titles', () => {
  it('groups cards into status columns and keeps done and archived collapsed until shown', async () => {
    serve({
      cards: [card(1), card(2, { status: 'running' }), card(3, { status: 'done' }), card(4, { status: 'archived' })]
    })
    await render(<KanbanBoardView />)
    await settleUntil(() => tile(1) !== null)

    expect(column('ready').contains(tile(1))).toBe(true)
    expect(column('running').contains(tile(2))).toBe(true)
    expect(tile(3)).toBeNull()
    expect(tile(4)).toBeNull()
    expect(column('done').textContent).toContain('1')
    await click(button('Show', column('done')))
    expect(column('done').contains(tile(3))).toBe(true)
    expect(tile(4)).toBeNull()
    await click(button('Hide', column('done')))
    expect(tile(3)).toBeNull()
  })

  it('merges live titles onto the cards and shows only #n when a title is missing', async () => {
    serve({ cards: [card(1), card(2)], titles: { '1': liveTitle(1, 'Fix the login bug') } })
    await render(<KanbanBoardView />)
    await settleUntil(() => tile(1)?.textContent?.includes('Fix the login bug') === true)

    expect(tile(2)?.textContent).toContain('#2')
    expect(tile(2)?.querySelector('[data-testid="kanban-title"]')).toBeNull()
    const titleCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/cards/titles'))!
    expect(String(titleCall[0])).toContain('numbers=1,2')
  })

  it('renders a hostile title literally, as text, never as markup or markdown', async () => {
    const hostile = '<script>alert(1)</script> **bold** [x](javascript:alert(1)) <img src=x onerror=alert(1)>'
    serve({ cards: [card(1)], titles: { '1': liveTitle(1, hostile) } })
    await render(<KanbanBoardView />)
    await settleUntil(() => tile(1)?.querySelector('[data-testid="kanban-title"]') != null)

    const title = tile(1)!.querySelector('[data-testid="kanban-title"]')!
    expect(title.textContent).toBe(hostile)
    expect(title.children).toHaveLength(0)
    expect(host.querySelector('script, img, strong')).toBeNull()
    expect(host.innerHTML).not.toContain('javascript:alert(1)">')
  })

  it('links #n to the repository’s issue page, built from the board, not from the server’s URL', async () => {
    serve({ cards: [card(7)], titles: { '7': { ...liveTitle(7, 't'), htmlUrl: 'https://evil.example/x' } } })
    await render(<KanbanBoardView />)
    await settleUntil(() => tile(7)?.textContent?.includes('t') === true)
    const link = tile(7)!.querySelector('a')!
    expect(link.getAttribute('href')).toBe('https://github.com/acme/web/issues/7')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('still shows every card when the titles request fails, with a notice', async () => {
    serve({ cards: [card(1), card(2, { status: 'blocked' })], titles: 'fail' })
    await render(<KanbanBoardView />)
    await settleUntil(() => host.textContent?.includes('could not be loaded from GitHub') === true)
    expect(tile(1)?.textContent).toContain('#1')
    expect(tile(2)?.textContent).toContain('#2')
  })

  it('does not ask for titles on an empty board', async () => {
    serve({ cards: [] })
    await render(<KanbanBoardView />)
    await settleUntil(() => column('ready') != null)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/cards/titles'))).toBe(false)
  })

  it('vera-528: titles are fetched once per visible set, never on a timer', async () => {
    vi.useFakeTimers()
    try {
      serve({ cards: [card(1)] })
      await render(<KanbanBoardView />)
      for (let i = 0; i < 10; i++) await act(async () => {})
      const titleCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/cards/titles'))
      expect(titleCalls()).toHaveLength(1)
      await act(async () => {
        vi.advanceTimersByTime(61_000)
      })
      for (let i = 0; i < 10; i++) await act(async () => {})
      expect(titleCalls()).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('vera-528: done, archived and collapsed cards are never requested', async () => {
    serve({
      cards: [
        card(1),
        card(2, { status: 'done' }),
        card(3, { status: 'archived' }),
        card(4, { status: 'blocked', needsAttention: true })
      ],
      titles: { '1': liveTitle(1, 'one'), '4': liveTitle(4, 'four') }
    })
    await render(<KanbanBoardView />)
    await settleUntil(() => tile(1) !== null)
    const titleNumbers = () =>
      fetchMock.mock.calls
        .filter(([url]) => String(url).includes('/cards/titles'))
        .map(([url]) => new URL(String(url), 'http://x').searchParams.get('numbers'))
    expect(tile(2)).toBeNull()
    expect(tile(3)).toBeNull()
    expect(titleNumbers()).toEqual(['1,4'])
    // Expanding the done column renders the card but still requests no title for it.
    await click(button('Show', column('done')))
    await settleUntil(() => tile(2) !== null)
    for (const numbers of titleNumbers()) {
      expect(`;${numbers};`).not.toContain(';2;')
      expect(`;${numbers};`).not.toContain(';3;')
    }
    // Filtering to needs-attention drops the other cards from the request.
    await click(button('Needs attention', host.querySelector('h1')!.parentElement!))
    await settleUntil(() => tile(1) === null)
    expect(titleNumbers().at(-1)).toBe('4')
  })
})

describe('KanbanBoardView attention and run state', () => {
  it('shows the needs-attention badge with its block kind and filters to flagged cards', async () => {
    serve({
      cards: [
        card(1, {
          status: 'blocked',
          needsAttention: true,
          blockKind: 'needs_input',
          consecutiveFailures: 2,
          blockRecurrence: 1
        }),
        card(2)
      ]
    })
    await render(<KanbanBoardView />)
    await settleUntil(() => tile(1) !== null)

    expect(tile(1)!.textContent).toContain('Needs attention: needs_input')
    expect(tile(1)!.textContent).toContain('2 failures')
    expect(tile(1)!.textContent).toContain('1 repeat block')
    expect(tile(2)!.textContent).not.toContain('Needs attention')
    await click(button('Needs attention', host.querySelector('h1')!.parentElement!))
    expect(tile(2)).toBeNull()
    expect(tile(1)).not.toBeNull()
  })

  it('shows a running card’s heartbeat age and offers no explain disclosure for it', async () => {
    serve({
      cards: [
        card(1, {
          status: 'running',
          openRun: {
            attempt: 1,
            agentId: 'a',
            dispatchedAt: new Date(Date.now() - 600_000).toISOString(),
            ackedAt: null,
            heartbeatAt: new Date(Date.now() - 125_000).toISOString()
          }
        })
      ]
    })
    await render(<KanbanBoardView />)
    await settleUntil(() => tile(1) !== null)
    expect(tile(1)!.textContent).toContain('Heartbeat 2 minutes ago')
    expect(button("Why isn't this running?", tile(1)!)).toBeUndefined()
  })

  it('explains a non-running card on demand with the gate and hint', async () => {
    serve({
      cards: [card(1)],
      explain: {
        verdict: { eligible: false, gate: 'cooldown' },
        hint: 'cooling down until 2026-10-15T13:00:00.000Z after a failed run'
      }
    })
    await render(<KanbanBoardView />)
    await settleUntil(() => tile(1) !== null)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/explain'))).toBe(false)

    await click(button("Why isn't this running?", tile(1)!))
    await settleUntil(() => tile(1)!.textContent?.includes('cooldown') === true)
    expect(tile(1)!.textContent).toContain('cooling down until')
    expect(String(fetchMock.mock.calls.find(([url]) => String(url).includes('/explain'))![0])).toContain(
      '/kanban/boards/board-1/cards/card-1/explain'
    )
  })

  it('says an eligible card will be picked up', async () => {
    serve({ cards: [card(1)], explain: { verdict: { eligible: true, role: 'work', agentId: 'a' }, hint: 'x' } })
    await render(<KanbanBoardView />)
    await settleUntil(() => tile(1) !== null)
    await click(button("Why isn't this running?", tile(1)!))
    await settleUntil(() => tile(1)!.textContent?.includes('Eligible') === true)
  })
})

describe('KanbanBoardView run-mode controls', () => {
  it('shows mode controls to an owner and hides them from everyone else', async () => {
    serve({ cards: [card(1)] })
    await render(<KanbanBoardView />)
    await settleUntil(() => tile(1) !== null)
    expect(tile(1)!.querySelector('select')).not.toBeNull()
    expect(host.querySelector('[role="group"][aria-label="Board default run mode"]')).not.toBeNull()

    await act(async () => root.unmount())
    root = createRoot(host)
    serve({ board: { ...BOARD, canEdit: false }, cards: [card(1)] })
    await render(<KanbanBoardView />)
    await settleUntil(() => tile(1) !== null)
    expect(tile(1)!.querySelector('select')).toBeNull()
    expect(host.querySelector('[role="group"][aria-label="Board default run mode"]')).toBeNull()
    expect(host.textContent).toContain('Default mode: read')
  })

  it('sets a card override to read straight away and clears it back to the board default', async () => {
    serve({ cards: [card(1)] })
    await render(<KanbanBoardView />)
    await settleUntil(() => tile(1) !== null)
    await choose(tile(1)!.querySelector('select')!, 'read')
    await settleUntil(() => puts.length === 1)
    expect(puts[0]).toEqual({
      path: expect.stringContaining('/kanban/boards/board-1/cards/card-1/mode'),
      body: { mode: 'read' }
    })
    await choose(tile(1)!.querySelector('select')!, 'inherit')
    await settleUntil(() => puts.length === 2)
    expect(puts[1]!.body).toEqual({ mode: null })
  })

  it('asks before granting a card write mode, and sends nothing until confirmed', async () => {
    serve({ cards: [card(1)] })
    await render(<KanbanBoardView />)
    await settleUntil(() => tile(1) !== null)

    await choose(tile(1)!.querySelector('select')!, 'write')
    expect(tile(1)!.textContent).toContain('write-scoped GitHub token for this card')
    expect(puts).toHaveLength(0)
    await click(button('Cancel', tile(1)!))
    expect(puts).toHaveLength(0)
    expect(tile(1)!.textContent).not.toContain('write-scoped')

    await choose(tile(1)!.querySelector('select')!, 'write')
    await click(button('Switch to write', tile(1)!))
    await settleUntil(() => puts.length === 1)
    expect(puts[0]!.body).toEqual({ mode: 'write' })
  })

  it('vera-528: choosing inherit on a write-default board asks first, then clears the override', async () => {
    serve({
      board: { ...BOARD, defaultMode: 'write' },
      cards: [card(1, { mode: 'read', modeOverride: 'read' })]
    })
    await render(<KanbanBoardView />)
    await settleUntil(() => tile(1) !== null)

    await choose(tile(1)!.querySelector('select')!, 'inherit')
    expect(tile(1)!.textContent).toContain('write-scoped GitHub token for this card')
    expect(puts).toHaveLength(0)
    await click(button('Switch to write', tile(1)!))
    await settleUntil(() => puts.length === 1)
    expect(puts[0]).toEqual({
      path: expect.stringContaining('/kanban/boards/board-1/cards/card-1/mode'),
      body: { mode: null }
    })
  })

  it('asks before switching the board default to write, then sends it', async () => {
    serve({ cards: [] })
    await render(<KanbanBoardView />)
    await settleUntil(() => host.querySelector('h1') !== null)
    const group = host.querySelector('[role="group"][aria-label="Board default run mode"]')!
    await click(button('Write', group))
    expect(host.textContent).toContain('write-scoped GitHub tokens for every card')
    expect(puts).toHaveLength(0)
    await click(button('Switch to write'))
    await settleUntil(() => puts.length === 1)
    expect(puts[0]).toEqual({ path: expect.stringContaining('/kanban/boards/board-1/mode'), body: { mode: 'write' } })
  })

  it('explains INTERACTIVE_AUTH_REQUIRED when a card mode write is refused', async () => {
    serve({
      cards: [card(1)],
      put: () => json({ message: 'interactive sign-in required', code: 'INTERACTIVE_AUTH_REQUIRED' }, 403)
    })
    await render(<KanbanBoardView />)
    await settleUntil(() => tile(1) !== null)
    await choose(tile(1)!.querySelector('select')!, 'read')
    await settleUntil(() => tile(1)!.querySelector('[role="alert"]') !== null)
    expect(tile(1)!.querySelector('[role="alert"]')!.textContent).toContain('interactive sign-in')
  })

  it('shows the CP’s message for any other refusal of a board mode change', async () => {
    serve({ cards: [], put: () => json({ message: 'board not found', code: 'not_found' }, 404) })
    await render(<KanbanBoardView />)
    await settleUntil(() => host.querySelector('h1') !== null)
    const group = host.querySelector('[role="group"][aria-label="Board default run mode"]')!
    await click(button('Write', group))
    await click(button('Switch to write'))
    await settleUntil(() => host.querySelector('[role="alert"]') !== null)
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('board not found')
  })
})

describe('Kanban board list', () => {
  it('lists boards with their repository, state and mode, linking to the board', async () => {
    serve({ board: { ...BOARD, enabled: false, defaultMode: 'write' } })
    await render(<KanbanBoardsView />)
    await settleUntil(() => host.textContent?.includes('acme/web') === true)
    expect(host.textContent).toContain('web')
    expect(host.textContent).toContain('Paused')
    expect(host.textContent).toContain('Default mode: write')
    expect(host.querySelector('a')!.getAttribute('href')).toBe('/kanban/board-1')
  })

  it('shows an empty state without boards', async () => {
    fetchMock = vi.fn(async () => json({ boards: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await render(<KanbanBoardsView />)
    await settleUntil(() => host.textContent?.includes('No Kanban boards yet') === true)
  })
})
