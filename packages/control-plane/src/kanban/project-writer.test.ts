// Kanban Projects v2 writer and hook (issue #2 M5) over mocked GraphQL: exact calls, caches, errors, no network.
import { describe, expect, it, vi } from 'vitest'
import { KANBAN_STATUSES, type KanbanStatus } from './card-state.js'
import {
  kanbanProjectHook,
  KanbanProjectWriter,
  PROJECT_STATUS_OPTIONS,
  type ProjectWriteReason
} from './project-writer.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

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
    issueNodeId: ISSUE_NODE as string | null,
    projectItemId: null as string | null,
    projectItemProjectId: null as string | null,
    idempotencyKey: null,
    status: 'done' as KanbanStatus,
    assigneeAgentId: null,
    priority: 0,
    mode: null,
    stateRevision: 1n,
    dispatchRevision: 1n,
    createdAt: new Date()
  }
  const REF = { boardId: 'board-1', issueNumber: 11, issueNodeId: ISSUE_NODE }

  function hookHarness(
    over: {
      board?: { projectNodeId: string | null; statusFieldId: string | null } | null
      card?: typeof card | null
      write?: { itemId: string } | null
      target?: { orgId: string; repo: typeof REPO } | null
    } = {}
  ) {
    const boards = { getForOrg: vi.fn(async () => (over.board === undefined ? board : over.board)) }
    const cards = {
      findByIssueNumber: vi.fn(async () => (over.card === null ? null : { id: 'card-1' })),
      getCard: vi.fn(async () => (over.card === undefined ? card : over.card)),
      setProjectItemId: vi.fn(async () => {})
    }
    const writer = {
      project: vi.fn(async (_args: unknown): Promise<{ itemId: string } | null> =>
        over.write === undefined ? { itemId: 'PVTI_new' } : over.write
      )
    }
    const boardRepo = vi.fn(async () => (over.target === undefined ? { orgId: 'org-1', repo: REPO } : over.target))
    // The fakes carry only the fields the hook reads; the cast keeps the repo-shaped production seam intact.
    const hook = kanbanProjectHook({
      boards: boards as unknown as Parameters<typeof kanbanProjectHook>[0]['boards'],
      cards: cards as unknown as Parameters<typeof kanbanProjectHook>[0]['cards'],
      writer,
      boardRepo
    })
    const commit = async (ref: { boardId: string; issueNumber: number; issueNodeId?: string | null } = REF) => {
      hook.onStatusCommitted(ref)
      await hook.settle()
    }
    return { boards, cards, writer, hook, boardRepo, commit }
  }

  it('projects the committed card status with the board pair and remembers a fresh item id', async () => {
    const h = hookHarness()
    await h.commit()
    expect(h.boards.getForOrg).toHaveBeenCalledWith('org-1', 'board-1')
    expect(h.cards.findByIssueNumber).toHaveBeenCalledWith('board-1', 11)
    expect(h.writer.project).toHaveBeenCalledWith({
      repo: REPO,
      board,
      card: { issueNodeId: ISSUE_NODE, projectItemId: null, projectItemProjectId: null },
      status: 'done'
    })
    expect(h.cards.setProjectItemId).toHaveBeenCalledWith('card-1', PROJECT, 'PVTI_new')
  })

  it('falls back to the row issue node when the caller read none', async () => {
    const h = hookHarness()
    await h.commit({ boardId: 'board-1', issueNumber: 11 })
    expect(h.writer.project).toHaveBeenCalledWith(
      expect.objectContaining({ card: { issueNodeId: ISSUE_NODE, projectItemId: null, projectItemProjectId: null } })
    )
  })

  it('projects the status committed when the run starts, not a status the caller names', async () => {
    const h = hookHarness({ card: { ...card, status: 'review' } })
    await h.commit()
    expect(h.writer.project).toHaveBeenCalledWith(expect.objectContaining({ status: 'review' }))
  })

  it('does nothing when the board has no projection', async () => {
    const h = hookHarness({ board: { projectNodeId: null, statusFieldId: null } })
    await h.commit()
    expect(h.cards.findByIssueNumber).not.toHaveBeenCalled()
    expect(h.writer.project).not.toHaveBeenCalled()
  })

  it('does nothing when the installation is gone', async () => {
    const h = hookHarness({ target: null })
    await h.commit()
    expect(h.boards.getForOrg).not.toHaveBeenCalled()
    expect(h.writer.project).not.toHaveBeenCalled()
  })

  it('does nothing when the card belongs to another board or is gone', async () => {
    const other = hookHarness({ card: { ...card, boardId: 'board-9' } })
    await other.commit()
    expect(other.writer.project).not.toHaveBeenCalled()
    expect(other.cards.setProjectItemId).not.toHaveBeenCalled()
    const gone = hookHarness({ card: null })
    await gone.commit()
    expect(gone.writer.project).not.toHaveBeenCalled()
  })

  it('does not re-store an item id the card already caches for this project', async () => {
    const h = hookHarness({
      card: { ...card, projectItemId: 'PVTI_old', projectItemProjectId: PROJECT },
      write: { itemId: 'PVTI_old' }
    })
    await h.commit()
    expect(h.writer.project).toHaveBeenCalled()
    expect(h.cards.setProjectItemId).not.toHaveBeenCalled()
  })

  it('does not store when the write failed, and never throws when loaders fail', async () => {
    const failed = hookHarness({ write: null })
    await failed.commit()
    expect(failed.cards.setProjectItemId).not.toHaveBeenCalled()
    const broken = hookHarness()
    broken.boards.getForOrg.mockRejectedValueOnce(new Error('db down'))
    expect(() => broken.hook.onStatusCommitted(REF)).not.toThrow()
    await expect(broken.hook.settle()).resolves.toBeUndefined()
    // The failed run leaves the queue usable for the next commit.
    await broken.commit()
    expect(broken.writer.project).toHaveBeenCalledTimes(1)
  })

  it('coalesces a burst of commits behind a running projection into one queued run', async () => {
    const h = hookHarness()
    let release!: () => void
    h.writer.project.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ itemId: 'PVTI_new' })))
    )
    h.hook.onStatusCommitted(REF)
    await vi.waitFor(() => expect(h.writer.project).toHaveBeenCalledTimes(1))
    h.hook.onStatusCommitted(REF)
    h.hook.onStatusCommitted(REF)
    h.hook.onStatusCommitted(REF)
    release()
    await h.hook.settle()
    expect(h.writer.project).toHaveBeenCalledTimes(2)
  })

  it('vera-474r2: one card has at most one active projection and a burst writes ready then done', async () => {
    const row = { ...card, status: 'ready' as KanbanStatus }
    const h = hookHarness({ card: row })
    const gate = deferred()
    const started = deferred()
    let active = 0
    let maxActive = 0
    const writes: string[] = []
    h.writer.project.mockImplementation(async (args) => {
      active++
      maxActive = Math.max(maxActive, active)
      const { status } = args as { status: KanbanStatus }
      if (status === 'ready') {
        started.resolve()
        await gate.promise
      }
      writes.push(status)
      active--
      return { itemId: 'PVTI_new' }
    })
    h.hook.onStatusCommitted(REF)
    await started.promise
    row.status = 'running'
    h.hook.onStatusCommitted(REF)
    row.status = 'review'
    h.hook.onStatusCommitted(REF)
    row.status = 'done'
    h.hook.onStatusCommitted(REF)
    await new Promise<void>((resolve) => setImmediate(resolve))
    gate.resolve()
    await h.hook.settle()
    expect(maxActive).toBe(1)
    expect(writes).toEqual(['ready', 'done'])
    expect(h.writer.project).toHaveBeenCalledTimes(2)
  })

  it('a slow projection for one card never holds another card', async () => {
    const h = hookHarness()
    h.writer.project.mockImplementationOnce(() => new Promise(() => {}))
    h.hook.onStatusCommitted(REF)
    await vi.waitFor(() => expect(h.writer.project).toHaveBeenCalledTimes(1))
    h.hook.onStatusCommitted({ boardId: 'board-1', issueNumber: 12 })
    await vi.waitFor(() => expect(h.writer.project).toHaveBeenCalledTimes(2))
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
    const cards = {
      findByIssueNumber: vi.fn(async () => ({ id: card.id })),
      getCard: vi.fn(async () => card),
      setProjectItemId: vi.fn(async () => {})
    }
    const writer = { project: vi.fn(async () => ({ itemId })) }
    const hook = kanbanProjectHook({
      boards: { getForOrg: vi.fn(async () => ({ projectNodeId: PROJECT, statusFieldId: FIELD })) } as never,
      cards: cards as never,
      writer,
      boardRepo: async () => ({ orgId: 'org-1', repo: REPO })
    })
    const commit = async () => {
      hook.onStatusCommitted({ boardId: 'board-1', issueNumber: 11 })
      await hook.settle()
    }
    return { cards, writer, commit }
  }

  it('vera-474: a re-pointed board overwrites the stale item id and records the new project', async () => {
    const h = hookWith(row, 'PVTI_P2')
    await h.commit()
    expect(h.writer.project).toHaveBeenCalledWith(
      expect.objectContaining({
        card: { issueNodeId: ISSUE_NODE, projectItemId: 'PVTI_P1', projectItemProjectId: 'PVT_P1' }
      })
    )
    expect(h.cards.setProjectItemId).toHaveBeenCalledWith('card-1', PROJECT, 'PVTI_P2')
  })

  it('vera-474: a re-added item on the same project overwrites the cached id', async () => {
    const h = hookWith({ ...row, projectItemId: 'PVTI_gone', projectItemProjectId: PROJECT }, 'PVTI_new')
    await h.commit()
    expect(h.cards.setProjectItemId).toHaveBeenCalledWith('card-1', PROJECT, 'PVTI_new')
  })

  it('vera-474: a legacy id with no recorded project gains its project even when the id is unchanged', async () => {
    const h = hookWith({ ...row, projectItemId: 'PVTI_same', projectItemProjectId: null }, 'PVTI_same')
    await h.commit()
    expect(h.cards.setProjectItemId).toHaveBeenCalledWith('card-1', PROJECT, 'PVTI_same')
  })
})

describe('vera-474: the field cache key, bound and invalidation, and the owner-login guard', () => {
  type Read = { project: string; owner: string; ownerType: string; fieldProject?: string }
  // Answers the guard read per (project, field) and counts every mutation, so cache hits are observable.
  function routed(readbacks: Record<string, Read>, opts: { fieldCacheMax?: number; failUpdates?: number } = {}) {
    const calls: Call[] = []
    let failures = opts.failUpdates ?? 0
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const call = JSON.parse(String(init?.body)) as Call
      calls.push(call)
      const v = call.variables as Record<string, string>
      if (call.query.includes('addProjectV2ItemById')) return new Response(JSON.stringify(addBody('PVTI_1')))
      if (call.query.includes('updateProjectV2ItemFieldValue')) {
        if (failures-- > 0) {
          return new Response(JSON.stringify({ data: null, errors: [{ message: 'option does not exist' }] }))
        }
        return new Response(JSON.stringify(updateBody))
      }
      const r = readbacks[`${v.project}:${v.field}`]!
      return new Response(
        JSON.stringify({
          data: {
            project: { id: r.project, owner: { __typename: r.ownerType, login: r.owner } },
            field: {
              __typename: 'ProjectV2SingleSelectField',
              id: v.field,
              project: { id: r.fieldProject ?? r.project },
              options: Object.values(PROJECT_STATUS_OPTIONS).map((name) => ({ id: optionId(name), name }))
            }
          }
        })
      )
    })
    const logs: Array<{ reason: string }> = []
    const mintKanbanProject = vi.fn(async () => ({
      token: 'ghs_project',
      ttlSec: 3600,
      expiresAt: '',
      repoFullName: REPO.repoFullName,
      access: 'read' as const
    }))
    const writer = new KanbanProjectWriter({
      tokens: { mintKanbanProject },
      fetchImpl,
      log: { info: (o: { reason: string }) => logs.push(o) },
      now: () => 1_700_000_000_000,
      ...(opts.fieldCacheMax ? { fieldCacheMax: opts.fieldCacheMax } : {})
    } as ConstructorParameters<typeof KanbanProjectWriter>[0])
    const project = (projectNodeId: string, statusFieldId: string, repo = REPO) =>
      writer.project({
        repo,
        board: { projectNodeId, statusFieldId },
        card: { issueNodeId: ISSUE_NODE },
        status: 'ready'
      })
    const reads = () => calls.filter((c) => c.query.includes('KanbanProjectGuard')).length
    const mutationsOn = (projectNodeId: string) =>
      calls.filter((c) => !c.query.includes('KanbanProjectGuard') && c.variables.project === projectNodeId).length
    return { calls, logs, project, reads, mutationsOn }
  }
  const org = (project: string, extra: Partial<Read> = {}): Read => ({
    project,
    owner: 'Acme',
    ownerType: 'Organization',
    ...extra
  })

  it('vera-474: two projects sharing a field id are read separately, so a user-owned one is refused (C1, C3)', async () => {
    const h = routed({ 'P_ORG:F': org('P_ORG'), 'P_USER:F': org('P_USER', { owner: 'mallory', ownerType: 'User' }) })
    expect(await h.project('P_ORG', 'F')).toEqual({ itemId: 'PVTI_1' })
    expect(await h.project('P_USER', 'F')).toBeNull()
    expect(h.reads()).toBe(2)
    expect(h.mutationsOn('P_USER')).toBe(0)
    expect(h.logs).toEqual([{ reason: 'project_not_org_owned' }])
  })

  it('vera-474: one project with two field ids reads each field, never reusing the other field options (C2)', async () => {
    const h = routed({ 'P:F1': org('P'), 'P:F2': org('P', { fieldProject: 'P_OTHER' }) })
    expect(await h.project('P', 'F1')).toEqual({ itemId: 'PVTI_1' })
    const mutations = h.mutationsOn('P')
    expect(await h.project('P', 'F2')).toBeNull()
    expect(h.reads()).toBe(2)
    expect(h.mutationsOn('P')).toBe(mutations)
    expect(h.logs).toEqual([{ reason: 'project_option_missing' }])
  })

  it('vera-474: the same project and field under two installations are read once per installation', async () => {
    const h = routed({ 'P:F': org('P') })
    await h.project('P', 'F')
    await h.project('P', 'F', { ...REPO, installationId: 8n })
    await h.project('P', 'F', { ...REPO, installationId: 8n })
    expect(h.reads()).toBe(2)
  })

  it('vera-474: the field cache is bounded and evicts the least recently used entry', async () => {
    const h = routed({ 'A:F': org('A'), 'B:F': org('B'), 'C:F': org('C') }, { fieldCacheMax: 2 })
    await h.project('A', 'F')
    await h.project('B', 'F')
    await h.project('A', 'F') // A is now the most recently used
    expect(h.reads()).toBe(2)
    await h.project('C', 'F') // evicts B, keeps A
    expect(h.reads()).toBe(3)
    await h.project('A', 'F')
    expect(h.reads()).toBe(3)
    await h.project('B', 'F')
    expect(h.reads()).toBe(4)
  })

  it('vera-474: a failed status write drops the field entry so the next write re-reads the options', async () => {
    const h = routed({ 'P:F': org('P') }, { failUpdates: 1 })
    expect(await h.project('P', 'F')).toBeNull()
    expect(h.logs).toEqual([{ reason: 'project_field_write_failed' }])
    expect(await h.project('P', 'F')).toEqual({ itemId: 'PVTI_1' })
    expect(h.reads()).toBe(2)
  })

  it('vera-474: a PAT reaching a project owned by evil-org is refused with project_owner_mismatch and zero mutations', async () => {
    const h = routed({ 'P_EVIL:F': org('P_EVIL', { owner: 'evil-org' }) })
    expect(await h.project('P_EVIL', 'F')).toBeNull()
    expect(h.mutationsOn('P_EVIL')).toBe(0)
    expect(h.calls).toHaveLength(1)
    expect(h.logs).toEqual([{ reason: 'project_owner_mismatch' }])
  })

  it('vera-474: the owner login matches the repo owner case-insensitively', async () => {
    const h = routed({ 'P:F': org('P', { owner: 'ACME' }) })
    expect(await h.project('P', 'F', { ...REPO, repoFullName: 'acme/web' })).toEqual({ itemId: 'PVTI_1' })
  })
})
