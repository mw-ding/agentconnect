// Kanban Projects v2 writer (issue #2 M5): mocked-GraphQL contract — exact queries/variables, option mapping,
// idempotent add, cached item reuse, error mapping, and the best-effort guarantee. No real network.
import { describe, expect, it, vi } from 'vitest'
import { KANBAN_STATUSES, type KanbanStatus } from './card-state.js'
import {
  kanbanProjectHook,
  KanbanProjectWriter,
  PROJECT_STATUS_OPTIONS,
  type ProjectWriteReason
} from './project-writer.js'

const PROJECT = 'PVT_kwDOAbc'
const FIELD = 'PVTSSF_lADOAbc'
const ISSUE_NODE = 'I_kwDOAbc123'
const REPO = { installationId: 7n, repoId: 4242n, repoFullName: 'acme/web' }

const optionId = (name: string) => `opt-${name}`

/** Field readback with every documented option name, owned by the repo's org. */
function fieldBody(
  names: string[] = Object.values(PROJECT_STATUS_OPTIONS),
  owner = 'Acme',
  ownerType = 'Organization'
) {
  return {
    data: {
      project: { id: PROJECT, owner: { __typename: ownerType, login: owner } },
      field: {
        __typename: 'ProjectV2SingleSelectField',
        id: FIELD,
        project: { id: PROJECT },
        options: names.map((name) => ({ id: optionId(name), name }))
      }
    }
  }
}

interface Call {
  query: string
  variables: Record<string, unknown>
}

function harness(opts: { bodies?: unknown[] | ((call: Call, n: number) => unknown); status?: number } = {}) {
  const calls: Call[] = []
  const logs: Array<{ reason: ProjectWriteReason }> = []
  let n = 0
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const call = JSON.parse(String(init?.body)) as Call
    calls.push(call)
    n += 1
    const body =
      typeof opts.bodies === 'function'
        ? opts.bodies(call, n)
        : (opts.bodies?.[n - 1] ?? opts.bodies?.[opts.bodies.length - 1])
    return new Response(JSON.stringify(body), {
      status: opts.status ?? 200,
      headers: { 'content-type': 'application/json' }
    })
  })
  const mintKanbanProject = vi.fn(async () => ({
    token: 'ghs_project',
    ttlSec: 3600,
    expiresAt: '',
    repoFullName: REPO.repoFullName,
    access: 'read' as const
  }))
  const log = { info: vi.fn((o: { reason: ProjectWriteReason }) => logs.push(o)) }
  const now = { at: 1_700_000_000_000, fn: () => now.at }
  const writer = new KanbanProjectWriter({ tokens: { mintKanbanProject }, fetchImpl, log, now: now.fn })
  const project = (over: Record<string, unknown> = {}) =>
    writer.project({
      repo: REPO,
      board: { projectNodeId: PROJECT, statusFieldId: FIELD },
      card: { issueNodeId: ISSUE_NODE, projectItemId: null },
      status: 'ready' as KanbanStatus,
      ...over
    })
  return { calls, logs, log, mintKanbanProject, fetchImpl, writer, project, now }
}

const addBody = (id: string) => ({ data: { addProjectV2ItemById: { item: { id } } } })
const updateBody = { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } } }

describe('KanbanProjectWriter', () => {
  it.each(KANBAN_STATUSES)('projects status %s onto its option with exact add/update variables', async (status) => {
    const h = harness({ bodies: [fieldBody(), addBody('PVTI_1'), updateBody] })
    const result = await h.project({ status })
    expect(result).toEqual({ itemId: 'PVTI_1' })
    expect(h.mintKanbanProject).toHaveBeenCalledWith(7n, 'acme/web', 4242n)
    expect(h.calls).toHaveLength(3)
    expect(h.calls[1]).toMatchObject({ variables: { project: PROJECT, content: ISSUE_NODE } })
    expect(h.calls[1]!.query).toContain('addProjectV2ItemById')
    expect(h.calls[2]).toMatchObject({
      variables: { project: PROJECT, item: 'PVTI_1', field: FIELD, option: optionId(PROJECT_STATUS_OPTIONS[status]) }
    })
    expect(h.calls[2]!.query).toContain('updateProjectV2ItemFieldValue')
  })

  it('matches option names case-insensitively', async () => {
    const h = harness({
      bodies: [
        fieldBody(['triage', 'todo', 'ready', 'running', 'blocked', 'review', 'done', 'archived']),
        addBody('PVTI_9'),
        updateBody
      ]
    })
    expect(await h.project({ status: 'done' })).toEqual({ itemId: 'PVTI_9' })
    expect(h.calls[2]).toMatchObject({ variables: { option: optionId('done') } })
  })

  it('reuses a cached item id and skips the add', async () => {
    const h = harness({ bodies: [fieldBody(), updateBody] })
    const result = await h.project({
      card: { issueNodeId: ISSUE_NODE, projectItemId: 'PVTI_cached', projectItemProjectId: PROJECT }
    })
    expect(result).toEqual({ itemId: 'PVTI_cached' })
    expect(h.calls).toHaveLength(2)
    expect(h.calls.some((c) => c.query.includes('addProjectV2ItemById'))).toBe(false)
    expect(h.calls[1]).toMatchObject({ variables: { item: 'PVTI_cached' } })
  })

  it('uses the id GitHub returns when the add finds an existing item', async () => {
    const h = harness({ bodies: [fieldBody(), addBody('PVTI_existing'), updateBody] })
    expect(await h.project()).toEqual({ itemId: 'PVTI_existing' })
    expect(h.calls[2]).toMatchObject({ variables: { item: 'PVTI_existing' } })
  })

  it('caches field options per project+field within the TTL, then re-reads', async () => {
    // Route every call by query so repeated projects never exhaust a fixed body list.
    const h = harness()
    h.fetchImpl.mockImplementation(async (_url: string, init?: RequestInit) => {
      const call = JSON.parse(String(init?.body)) as Call
      h.calls.push(call)
      if (call.query.includes('addProjectV2ItemById')) return new Response(JSON.stringify(addBody('PVTI_1')))
      if (call.query.includes('updateProjectV2ItemFieldValue')) return new Response(JSON.stringify(updateBody))
      return new Response(JSON.stringify(fieldBody()))
    })
    const guardReads = () => h.calls.filter((c) => c.query.includes('KanbanProjectGuard')).length
    expect(await h.project()).toEqual({ itemId: 'PVTI_1' })
    expect(await h.project()).toEqual({ itemId: 'PVTI_1' })
    expect(guardReads()).toBe(1)
    h.now.at += 6 * 60_000
    expect(await h.project()).toEqual({ itemId: 'PVTI_1' })
    expect(guardReads()).toBe(2)
  })

  it('refuses without any call when no projection is configured', async () => {
    const h = harness()
    expect(await h.project({ board: { projectNodeId: null, statusFieldId: null } })).toBeNull()
    expect(h.mintKanbanProject).not.toHaveBeenCalled()
    expect(h.fetchImpl).not.toHaveBeenCalled()
    expect(h.log.info).not.toHaveBeenCalled()
  })

  it('skips a card without an issue node before minting', async () => {
    const h = harness()
    expect(await h.project({ card: { issueNodeId: null, projectItemId: null } })).toBeNull()
    expect(h.mintKanbanProject).not.toHaveBeenCalled()
    expect(h.fetchImpl).not.toHaveBeenCalled()
    expect(h.logs).toEqual([{ reason: 'project_issue_node_missing' }])
  })

  it('refuses a user-owned project at runtime and never writes', async () => {
    const h = harness({
      bodies: [fieldBody(Object.values(PROJECT_STATUS_OPTIONS), 'mallory', 'User'), addBody('x'), updateBody]
    })
    expect(await h.project()).toBeNull()
    expect(h.calls).toHaveLength(1)
    expect(h.logs).toEqual([{ reason: 'project_not_org_owned' }])
  })

  it('refuses a missing project readback without writing', async () => {
    const h = harness({ bodies: [{ data: { project: null, field: null } }, addBody('x'), updateBody] })
    expect(await h.project()).toBeNull()
    expect(h.calls).toHaveLength(1)
    expect(h.logs).toEqual([{ reason: 'project_not_org_owned' }])
  })

  it('reports a missing option without adding or writing', async () => {
    const h = harness({ bodies: [fieldBody(['Todo']), addBody('x'), updateBody] })
    expect(await h.project({ status: 'ready' })).toBeNull()
    expect(h.calls).toHaveLength(1)
    expect(h.logs).toEqual([{ reason: 'project_option_missing' }])
  })

  it('reports a field of another project as a missing option', async () => {
    const body = fieldBody()
    body.data.field.project = { id: 'PVT_other' }
    const h = harness({ bodies: [body, addBody('x'), updateBody] })
    expect(await h.project()).toBeNull()
    expect(h.logs).toEqual([{ reason: 'project_option_missing' }])
  })

  it('maps a GraphQL FORBIDDEN read to project_access_denied', async () => {
    const h = harness({
      bodies: [{ data: { project: null, field: null }, errors: [{ type: 'FORBIDDEN', message: 'no [SECRET]' }] }]
    })
    expect(await h.project()).toBeNull()
    expect(h.logs).toEqual([{ reason: 'project_access_denied' }])
    expect(JSON.stringify(h.logs)).not.toContain('SECRET')
  })

  it('maps a GraphQL RATE_LIMITED body to project_rate_limited', async () => {
    const h = harness({ bodies: [{ data: null, errors: [{ type: 'RATE_LIMITED', message: 'slow' }] }] })
    expect(await h.project()).toBeNull()
    expect(h.logs).toEqual([{ reason: 'project_rate_limited' }])
  })

  it.each([
    [403, 'project_access_denied'],
    [404, 'project_access_denied'],
    [401, 'project_field_write_failed'],
    [429, 'project_rate_limited'],
    [500, 'project_field_write_failed']
  ] as const)('maps an HTTP %i options read to %s', async (status, reason) => {
    const h = harness({ bodies: [{ message: 'denied [SECRET]' }], status })
    expect(await h.project()).toBeNull()
    expect(h.logs).toEqual([{ reason }])
    expect(JSON.stringify(h.logs)).not.toContain('SECRET')
  })

  it('maps a failed item add to project_item_add_failed and skips the field write', async () => {
    // Only the add fails: answer per call so the options read succeeds first.
    const h = harness()
    h.fetchImpl.mockImplementation(async (_url: string, init?: RequestInit) => {
      const call = JSON.parse(String(init?.body)) as Call
      h.calls.push(call)
      if (call.query.includes('addProjectV2ItemById')) {
        return new Response(JSON.stringify({ message: 'add blew up [SECRET]' }), { status: 500 })
      }
      return new Response(JSON.stringify(fieldBody()))
    })
    expect(await h.project()).toBeNull()
    // The add is idempotent, so a transient 500 is retried; the field write must still never run.
    expect(h.calls.filter((c) => c.query.includes('KanbanProjectGuard'))).toHaveLength(1)
    expect(h.calls.filter((c) => c.query.includes('addProjectV2ItemById')).length).toBeGreaterThanOrEqual(1)
    expect(h.calls.some((c) => c.query.includes('updateProjectV2ItemFieldValue'))).toBe(false)
    expect(h.logs).toEqual([{ reason: 'project_item_add_failed' }])
    expect(JSON.stringify(h.logs)).not.toContain('SECRET')
  })

  it('maps a failed field write to project_field_write_failed', async () => {
    // Only the update fails: answer per call so the read and the add succeed first.
    const h = harness()
    h.fetchImpl.mockImplementation(async (_url: string, init?: RequestInit) => {
      const call = JSON.parse(String(init?.body)) as Call
      h.calls.push(call)
      if (call.query.includes('updateProjectV2ItemFieldValue')) {
        return new Response(JSON.stringify({ message: 'write blew up [SECRET]' }), { status: 500 })
      }
      if (call.query.includes('addProjectV2ItemById')) return new Response(JSON.stringify(addBody('PVTI_1')))
      return new Response(JSON.stringify(fieldBody()))
    })
    expect(await h.project()).toBeNull()
    // The read and the add succeed first try; the transient 500 on the write is retried before it is swallowed.
    expect(h.calls.filter((c) => c.query.includes('KanbanProjectGuard'))).toHaveLength(1)
    expect(h.calls.filter((c) => c.query.includes('addProjectV2ItemById'))).toHaveLength(1)
    expect(h.calls.filter((c) => c.query.includes('updateProjectV2ItemFieldValue')).length).toBeGreaterThanOrEqual(1)
    expect(h.logs).toEqual([{ reason: 'project_field_write_failed' }])
    expect(JSON.stringify(h.logs)).not.toContain('SECRET')
  })

  it('never throws, even when the mint itself fails unexpectedly', async () => {
    const h = harness()
    h.mintKanbanProject.mockRejectedValueOnce(new Error('config exploded [SECRET]'))
    await expect(h.project()).resolves.toBeNull()
    expect(JSON.stringify(h.logs)).not.toContain('SECRET')
  })
})

describe('kanbanProjectHook', () => {
  const board = { projectNodeId: PROJECT, statusFieldId: FIELD }
  const card = {
    id: 'card-1',
    boardId: 'board-1',
    issueId: 11n,
    issueNumber: 11,
    issueNodeId: ISSUE_NODE,
    projectItemId: null as string | null,
    projectItemProjectId: null as string | null,
    idempotencyKey: null,
    status: 'done' as const,
    assigneeAgentId: null,
    priority: 0,
    mode: null,
    stateRevision: 1n,
    dispatchRevision: 1n,
    createdAt: new Date()
  }

  function hookHarness(
    over: {
      board?: { projectNodeId: string | null; statusFieldId: string | null } | null
      card?: typeof card | null
      write?: { itemId: string } | null
    } = {}
  ) {
    const boards = { getForOrg: vi.fn(async () => (over.board === undefined ? board : over.board)) }
    const cards = {
      getCard: vi.fn(async () => (over.card === undefined ? card : over.card)),
      setProjectItemId: vi.fn(async () => {})
    }
    const writer = { project: vi.fn(async () => (over.write === undefined ? { itemId: 'PVTI_new' } : over.write)) }
    // The fakes carry only the fields the hook reads; the cast keeps the repo-shaped production seam intact.
    const hook = kanbanProjectHook({
      boards: boards as unknown as Parameters<typeof kanbanProjectHook>[0]['boards'],
      cards: cards as unknown as Parameters<typeof kanbanProjectHook>[0]['cards'],
      writer
    })
    const args = {
      boardId: 'board-1',
      orgId: 'org-1',
      cardId: 'card-1',
      repo: REPO,
      status: 'done' as const,
      issueNodeId: ISSUE_NODE
    }
    return { boards, cards, writer, hook, args }
  }

  it('projects with the board pair and remembers a fresh item id', async () => {
    const h = hookHarness()
    await h.hook.projectAfterLabel(h.args)
    expect(h.writer.project).toHaveBeenCalledWith({
      repo: REPO,
      board,
      card: { issueNodeId: ISSUE_NODE, projectItemId: null, projectItemProjectId: null },
      status: 'done'
    })
    expect(h.cards.setProjectItemId).toHaveBeenCalledWith('card-1', PROJECT, 'PVTI_new')
  })

  it('falls back to the row issue node when the label write read none', async () => {
    const h = hookHarness()
    await h.hook.projectAfterLabel({ ...h.args, issueNodeId: null })
    expect(h.writer.project).toHaveBeenCalledWith(
      expect.objectContaining({ card: { issueNodeId: ISSUE_NODE, projectItemId: null, projectItemProjectId: null } })
    )
  })

  it('does nothing when the board has no projection', async () => {
    const h = hookHarness({ board: { projectNodeId: null, statusFieldId: null } })
    await h.hook.projectAfterLabel(h.args)
    expect(h.cards.getCard).not.toHaveBeenCalled()
    expect(h.writer.project).not.toHaveBeenCalled()
  })

  it('does nothing when the card belongs to another board', async () => {
    const h = hookHarness({ card: { ...card, boardId: 'board-9' } })
    await h.hook.projectAfterLabel(h.args)
    expect(h.writer.project).not.toHaveBeenCalled()
    expect(h.cards.setProjectItemId).not.toHaveBeenCalled()
  })

  it('does not re-store an item id the card already caches', async () => {
    const h = hookHarness({
      card: { ...card, projectItemId: 'PVTI_old', projectItemProjectId: PROJECT },
      write: { itemId: 'PVTI_old' }
    })
    await h.hook.projectAfterLabel(h.args)
    expect(h.writer.project).toHaveBeenCalled()
    expect(h.cards.setProjectItemId).not.toHaveBeenCalled()
  })

  it('does not store when the write failed, and never throws when loaders fail', async () => {
    const failed = hookHarness({ write: null })
    await failed.hook.projectAfterLabel(failed.args)
    expect(failed.cards.setProjectItemId).not.toHaveBeenCalled()
    const broken = hookHarness()
    broken.boards.getForOrg.mockRejectedValueOnce(new Error('db down'))
    await expect(broken.hook.projectAfterLabel(broken.args)).resolves.toBeUndefined()
  })
})

describe('vera-474 B1: a stale cached item never sticks', () => {
  const notFound = {
    data: { updateProjectV2ItemFieldValue: null },
    errors: [{ type: 'NOT_FOUND', message: 'gone [SECRET]' }]
  }
  const forbidden = { data: { addProjectV2ItemById: null }, errors: [{ type: 'FORBIDDEN', message: 'no [SECRET]' }] }

  // Answers per mutation in order, so a test scripts the update and add sequences independently.
  function scripted(updates: unknown[], adds: unknown[]) {
    const h = harness()
    let u = 0
    let a = 0
    h.fetchImpl.mockImplementation(async (_url: string, init?: RequestInit) => {
      const call = JSON.parse(String(init?.body)) as Call
      h.calls.push(call)
      const body = call.query.includes('updateProjectV2ItemFieldValue')
        ? updates[u++]
        : call.query.includes('addProjectV2ItemById')
          ? adds[a++]
          : fieldBody()
      return new Response(JSON.stringify(body))
    })
    const count = (m: string) => h.calls.filter((c) => c.query.includes(m)).length
    return { ...h, adds: () => count('addProjectV2ItemById'), updates: () => count('updateProjectV2ItemFieldValue') }
  }

  it('vera-474: an item cached for another project is ignored and the card is added to the board project', async () => {
    const h = scripted([updateBody], [addBody('PVTI_P2')])
    const result = await h.project({
      card: { issueNodeId: ISSUE_NODE, projectItemId: 'PVTI_P1', projectItemProjectId: 'PVT_P1' }
    })
    expect(result).toEqual({ itemId: 'PVTI_P2' })
    expect(h.adds()).toBe(1)
    expect(h.calls.find((c) => c.query.includes('addProjectV2ItemById'))).toMatchObject({
      variables: { project: PROJECT, content: ISSUE_NODE }
    })
    expect(h.calls.find((c) => c.query.includes('updateProjectV2ItemFieldValue'))).toMatchObject({
      variables: { project: PROJECT, item: 'PVTI_P2' }
    })
  })

  it('vera-474: a legacy cached item with no recorded project is re-added through the idempotent add', async () => {
    const h = scripted([updateBody], [addBody('PVTI_same')])
    expect(await h.project({ card: { issueNodeId: ISSUE_NODE, projectItemId: 'PVTI_same' } })).toEqual({
      itemId: 'PVTI_same'
    })
    expect(h.adds()).toBe(1)
  })

  it('vera-474: an item deleted by hand (NOT_FOUND) is re-added once, written, and its new id returned', async () => {
    const h = scripted([notFound, updateBody], [addBody('PVTI_new')])
    const result = await h.project({
      card: { issueNodeId: ISSUE_NODE, projectItemId: 'PVTI_gone', projectItemProjectId: PROJECT }
    })
    expect(result).toEqual({ itemId: 'PVTI_new' })
    expect(h.adds()).toBe(1)
    expect(h.updates()).toBe(2)
    expect(h.calls.filter((c) => c.query.includes('updateProjectV2ItemFieldValue'))[1]).toMatchObject({
      variables: { item: 'PVTI_new' }
    })
    expect(h.logs).toEqual([{ reason: 'project_item_missing', recovered: true }])
    expect(JSON.stringify(h.logs)).not.toContain('SECRET')
  })

  it('vera-474: a re-add that also fails is swallowed with a single project_item_missing line', async () => {
    const h = scripted([notFound], [forbidden])
    const result = await h.project({
      card: { issueNodeId: ISSUE_NODE, projectItemId: 'PVTI_gone', projectItemProjectId: PROJECT }
    })
    expect(result).toBeNull()
    expect(h.adds()).toBe(1)
    expect(h.updates()).toBe(1)
    expect(h.logs).toEqual([{ reason: 'project_item_missing', recovered: false, cause: 'project_access_denied' }])
    expect(JSON.stringify(h.logs)).not.toContain('SECRET')
  })

  it('vera-474: the re-add happens only once even when the re-added item also fails NOT_FOUND', async () => {
    const h = scripted([notFound, notFound, notFound], [addBody('PVTI_new'), addBody('PVTI_newer')])
    const result = await h.project({
      card: { issueNodeId: ISSUE_NODE, projectItemId: 'PVTI_gone', projectItemProjectId: PROJECT }
    })
    expect(result).toBeNull()
    expect(h.adds()).toBe(1)
    expect(h.updates()).toBe(2)
    expect(h.logs).toEqual([{ reason: 'project_item_missing', recovered: false, cause: 'project_access_denied' }])
  })

  it('vera-474: a FORBIDDEN write on a cached item is a denial, not a missing item, and never re-adds', async () => {
    const denied = { data: { updateProjectV2ItemFieldValue: null }, errors: [{ type: 'FORBIDDEN', message: 'x' }] }
    const h = scripted([denied], [addBody('PVTI_new')])
    const result = await h.project({
      card: { issueNodeId: ISSUE_NODE, projectItemId: 'PVTI_cached', projectItemProjectId: PROJECT }
    })
    expect(result).toBeNull()
    expect(h.adds()).toBe(0)
    expect(h.logs).toEqual([{ reason: 'project_access_denied' }])
  })
})

describe('vera-474 B1: the hook keeps the item cache keyed by project', () => {
  const row = {
    id: 'card-1',
    boardId: 'board-1',
    issueNodeId: ISSUE_NODE,
    projectItemId: 'PVTI_P1' as string | null,
    projectItemProjectId: 'PVT_P1' as string | null,
    status: 'done' as const
  }
  function hookWith(card: typeof row, itemId: string) {
    const cards = { getCard: vi.fn(async () => card), setProjectItemId: vi.fn(async () => {}) }
    const writer = { project: vi.fn(async () => ({ itemId })) }
    const hook = kanbanProjectHook({
      boards: { getForOrg: vi.fn(async () => ({ projectNodeId: PROJECT, statusFieldId: FIELD })) } as never,
      cards: cards as never,
      writer
    })
    const args = { boardId: 'board-1', orgId: 'org-1', cardId: 'card-1', repo: REPO, status: 'done' as const }
    return { cards, writer, hook, args }
  }

  it('vera-474: a re-pointed board overwrites the stale item id and records the new project', async () => {
    const h = hookWith(row, 'PVTI_P2')
    await h.hook.projectAfterLabel(h.args)
    expect(h.writer.project).toHaveBeenCalledWith(
      expect.objectContaining({
        card: { issueNodeId: ISSUE_NODE, projectItemId: 'PVTI_P1', projectItemProjectId: 'PVT_P1' }
      })
    )
    expect(h.cards.setProjectItemId).toHaveBeenCalledWith('card-1', PROJECT, 'PVTI_P2')
  })

  it('vera-474: a re-added item on the same project overwrites the cached id', async () => {
    const h = hookWith({ ...row, projectItemId: 'PVTI_gone', projectItemProjectId: PROJECT }, 'PVTI_new')
    await h.hook.projectAfterLabel(h.args)
    expect(h.cards.setProjectItemId).toHaveBeenCalledWith('card-1', PROJECT, 'PVTI_new')
  })

  it('vera-474: a legacy id with no recorded project gains its project even when the id is unchanged', async () => {
    const h = hookWith({ ...row, projectItemId: 'PVTI_same', projectItemProjectId: null }, 'PVTI_same')
    await h.hook.projectAfterLabel(h.args)
    expect(h.cards.setProjectItemId).toHaveBeenCalledWith('card-1', PROJECT, 'PVTI_same')
  })
})
