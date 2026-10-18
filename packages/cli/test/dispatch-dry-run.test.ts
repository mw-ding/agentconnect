// `agentconnect dispatch --dry-run` against a stubbed fetch: routes, human and JSON output, and stable error reporting.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DispatchDryRunError,
  formatEntry,
  readStoredCredentials,
  restBaseFor,
  runDispatchCommand,
  runDispatchDryRun,
  type DryRunOpts
} from '../src/dispatch-dry-run.js'
import { classifyInvocation } from '../src/route.js'

const BOARD = 'b0000000-0000-4000-8000-000000000001'
const ORG = 'org-1'
const opts: DryRunOpts = { apiUrl: 'wss://cp.example.com/daemon/ws', apiKey: 'sekret-key', org: ORG, board: BOARD }

const entry = (n: number, extra: Record<string, unknown> = {}) => ({
  cardId: `card-${n}`,
  issueNumber: n,
  status: 'ready',
  verdict: { eligible: true, role: 'work', agentId: 'agent-1' },
  hint: 'eligible: the next claim dispatches it to agent agent-1',
  ...extra
})
const blocked = (n: number, gate: string, hint: string, status = 'ready') =>
  entry(n, { status, verdict: { eligible: false, gate }, hint })

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let lines: string[]
let fetchMock: ReturnType<typeof vi.fn>
const deps = () => ({ fetch: fetchMock as unknown as typeof fetch, out: (l: string) => void lines.push(l) })
const urls = () => fetchMock.mock.calls.map(([u]) => String(u))

beforeEach(() => {
  lines = []
  fetchMock = vi.fn()
})

describe('restBaseFor', () => {
  it.each([
    ['wss://cp.example.com/daemon/ws', 'https://cp.example.com/api/v1'],
    ['ws://localhost:8080/daemon/ws', 'http://localhost:8080/api/v1'],
    ['https://cp.example.com', 'https://cp.example.com/api/v1'],
    ['http://cp.example.com:8080/', 'http://cp.example.com:8080/api/v1'],
    ['wss://cp.example.com/prefix/daemon/ws', 'https://cp.example.com/prefix/api/v1']
  ])('derives the REST root from %s', (input, expected) => {
    expect(restBaseFor(input)).toBe(expected)
  })

  it('refuses a malformed URL and an unsupported scheme', () => {
    expect(() => restBaseFor('not a url')).toThrow(DispatchDryRunError)
    expect(() => restBaseFor('ftp://cp.example.com')).toThrow(/unsupported/)
  })
})

describe('formatEntry', () => {
  it('prints an eligible card with its role and agent', () => {
    expect(formatEntry(entry(12))).toBe('#12 ready → ELIGIBLE (work → agent agent-1)')
  })
  it('prints the gate and hint of a blocked card', () => {
    expect(formatEntry(blocked(7, 'cooldown', 'cooling down until T after a failed run', 'blocked'))).toBe(
      '#7 blocked → blocked by cooldown: cooling down until T after a failed run'
    )
  })
  it('flags an eligible card a cap defers', () => {
    expect(formatEntry(entry(3, { capBound: 'agent_cap', hint: 'wait' }))).toBe(
      '#3 ready → ELIGIBLE but deferred by agent_cap: wait'
    )
  })
})

describe('board mode', () => {
  it('prints each card, then what the next claim would take', async () => {
    fetchMock.mockImplementation(async () =>
      json({
        cards: [entry(1), blocked(2, 'no_assignee', 'no agent is assigned to this card'), entry(5)],
        wouldClaimNext: ['card-1', 'card-5'],
        wouldClaimNextIssueNumbers: [1, 5]
      })
    )
    await runDispatchDryRun(opts, deps())
    expect(urls()).toEqual([`https://cp.example.com/api/v1/orgs/${ORG}/kanban/boards/${BOARD}/explain`])
    expect(lines).toEqual([
      '#1 ready → ELIGIBLE (work → agent agent-1)',
      '#2 ready → blocked by no_assignee: no agent is assigned to this card',
      '#5 ready → ELIGIBLE (work → agent agent-1)',
      'would claim next: #1, #5'
    ])
  })

  it('says none when nothing would be claimed', async () => {
    fetchMock.mockImplementation(async () => json({ cards: [], wouldClaimNext: [], wouldClaimNextIssueNumbers: [] }))
    await runDispatchDryRun(opts, deps())
    expect(lines).toEqual(['would claim next: (none)'])
  })

  it('sends the key as a bearer header and never prints it', async () => {
    fetchMock.mockImplementation(async () =>
      json({ cards: [entry(1)], wouldClaimNext: [], wouldClaimNextIssueNumbers: [] })
    )
    await runDispatchDryRun(opts, deps())
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sekret-key')
    expect(lines.join('\n')).not.toContain('sekret-key')
  })

  it('prints the control plane’s JSON with --json', async () => {
    const body = { cards: [entry(1)], wouldClaimNext: ['card-1'], wouldClaimNextIssueNumbers: [1] }
    fetchMock.mockImplementation(async () => json(body))
    await runDispatchDryRun({ ...opts, json: true }, deps())
    expect(JSON.parse(lines.join('\n'))).toEqual(body)
  })
})

describe('card mode', () => {
  it('explains one card by id', async () => {
    fetchMock.mockImplementation(async () => json(blocked(4, 'agent_paused', 'the assigned agent is paused')))
    await runDispatchDryRun({ ...opts, card: 'card-4' }, deps())
    expect(urls()).toEqual([`https://cp.example.com/api/v1/orgs/${ORG}/kanban/boards/${BOARD}/cards/card-4/explain`])
    expect(lines).toEqual(['#4 ready → blocked by agent_paused: the assigned agent is paused'])
  })

  it('resolves an issue number through the cards list, then explains that card', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/cards')
        ? json({
            cards: [
              { id: 'card-9', issueNumber: 9 },
              { id: 'card-12', issueNumber: 12 }
            ]
          })
        : json(entry(12))
    )
    await runDispatchDryRun({ ...opts, issue: 12 }, deps())
    expect(urls()).toHaveLength(2)
    expect(urls()[0]).toMatch(/\/cards$/)
    expect(urls()[1]).toMatch(/\/cards\/card-12\/explain$/)
    expect(lines).toEqual(['#12 ready → ELIGIBLE (work → agent agent-1)'])
  })

  it('reports an issue that is not a card of the board', async () => {
    fetchMock.mockImplementation(async () => json({ cards: [{ id: 'card-9', issueNumber: 9 }] }))
    await expect(runDispatchDryRun({ ...opts, issue: 404 }, deps())).rejects.toThrow('no card #404 on this board')
    expect(lines).toEqual([])
  })

  it('refuses both --card and --issue without calling the control plane', async () => {
    await expect(runDispatchDryRun({ ...opts, card: 'c', issue: 1 }, deps())).rejects.toThrow(
      /either --card or --issue/
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('organization resolution', () => {
  const noOrg: DryRunOpts = { apiUrl: opts.apiUrl, apiKey: opts.apiKey, board: BOARD }

  it('uses the only organization the key belongs to', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/orgs')
        ? json([{ id: 'only-org' }])
        : json({ cards: [], wouldClaimNext: [], wouldClaimNextIssueNumbers: [] })
    )
    await runDispatchDryRun(noOrg, deps())
    expect(urls()[1]).toContain('/orgs/only-org/kanban/boards/')
  })

  it('asks for --org when there are several, and when there are none', async () => {
    fetchMock.mockImplementationOnce(async () => json([{ id: 'a' }, { id: 'b' }]))
    await expect(runDispatchDryRun(noOrg, deps())).rejects.toThrow(/pass --org/)
    fetchMock.mockImplementationOnce(async () => json([]))
    await expect(runDispatchDryRun(noOrg, deps())).rejects.toThrow(/no organization/)
  })
})

describe('errors', () => {
  it.each([
    [401, { message: 'invalid api key' }, '401: invalid api key'],
    [
      403,
      { message: 'this key is limited to read-only access', code: 'forbidden_key' },
      '403 forbidden_key: this key is limited to read-only access'
    ],
    [404, { code: 'not_found', message: 'board not found' }, '404 not_found: board not found']
  ])('reports HTTP %s with the stable code and message', async (status, body, expected) => {
    fetchMock.mockImplementation(async () => json(body, status))
    await expect(runDispatchDryRun(opts, deps())).rejects.toThrow(expected)
  })

  it('exposes the code on the error', async () => {
    fetchMock.mockImplementation(async () => json({ code: 'not_found', message: 'board not found' }, 404))
    const err = await runDispatchDryRun(opts, deps()).catch((e: unknown) => e)
    expect((err as DispatchDryRunError).code).toBe('not_found')
  })

  it('reports an unreachable control plane', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'))
    await expect(runDispatchDryRun(opts, deps())).rejects.toThrow(
      'cannot reach the control plane: connect ECONNREFUSED'
    )
  })
})

describe('runDispatchCommand', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ac-dispatch-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const writeLogin = () =>
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { url: 'wss://stored.example.com/daemon/ws', key: 'stored-key', enabled: true }
      })
    )

  it('refuses to run without --dry-run and touches nothing', async () => {
    writeLogin()
    await expect(runDispatchCommand({ root: dir, board: BOARD }, deps())).rejects.toThrow(
      'only --dry-run is supported; dispatch runs in the control plane'
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires a board', async () => {
    await expect(runDispatchCommand({ root: dir, dryRun: true }, deps())).rejects.toThrow('--board <id> is required')
  })

  it('uses the stored login when no flags are given', async () => {
    writeLogin()
    fetchMock.mockImplementation(async () => json({ cards: [], wouldClaimNext: [], wouldClaimNextIssueNumbers: [] }))
    await runDispatchCommand({ root: dir, dryRun: true, board: BOARD, org: ORG }, deps())
    expect(urls()[0]).toMatch(/^https:\/\/stored\.example\.com\/api\/v1\//)
    expect(((fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>).authorization).toBe(
      'Bearer stored-key'
    )
  })

  it('lets --api-url and --api-key override the stored login', async () => {
    writeLogin()
    fetchMock.mockImplementation(async () => json({ cards: [], wouldClaimNext: [], wouldClaimNextIssueNumbers: [] }))
    await runDispatchCommand(
      { root: dir, dryRun: true, board: BOARD, org: ORG, apiUrl: 'ws://localhost:8080/daemon/ws', apiKey: 'flag-key' },
      deps()
    )
    expect(urls()[0]).toMatch(/^http:\/\/localhost:8080\/api\/v1\//)
    expect(((fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>).authorization).toBe(
      'Bearer flag-key'
    )
  })

  it('explains the missing login instead of calling out', async () => {
    await expect(runDispatchCommand({ root: dir, dryRun: true, board: BOARD }, deps())).rejects.toThrow(
      /agentconnect login/
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['0', '-3', 'abc', '1.5'])('rejects --issue %s', async (issue) => {
    writeLogin()
    await expect(runDispatchCommand({ root: dir, dryRun: true, board: BOARD, issue }, deps())).rejects.toThrow(
      /invalid --issue/
    )
  })

  it('reads a stored login only when well-formed', () => {
    writeFileSync(join(dir, 'config.json'), '{ not json')
    expect(readStoredCredentials(dir)).toEqual({})
    expect(readStoredCredentials(join(dir, 'missing'))).toEqual({})
  })
})

describe('routing', () => {
  it('keeps dispatch in the CLI instead of delegating it to the daemon', () => {
    expect(classifyInvocation(['dispatch', '--dry-run', '--board', 'b'])).not.toBe('delegate')
    expect(classifyInvocation(['--root', '/x', 'dispatch', '--dry-run'])).not.toBe('delegate')
  })
})
