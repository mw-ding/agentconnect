import { describe, expect, it, vi } from 'vitest'
import type { AnyFrame } from '@agentconnect.md/protocol'
import { GitCredDeniedError } from '../../github/service.js'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { handleGitCredRequest } from './gitcred.js'

const DAEMON_ID = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const AGENT_ID = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HOOK_ID = 'b0b0b0b0-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** An agent placed on DAEMON_ID — passes the handler's placement scope check. */
const PLACED_AGENT = { id: AGENT_ID, orgId: 'org-a', daemonId: DAEMON_ID }

function gitcredFrame(payload: Record<string, unknown> = {}): AnyFrame {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: '2026-07-11T00:00:00.000Z',
    type: 'gitcred/request',
    payload: { agentId: AGENT_ID, ...payload }
  } as AnyFrame
}

function fakeConn() {
  return {
    daemonId: DAEMON_ID,
    replyTo: vi.fn(),
    sendError: vi.fn()
  } as unknown as DaemonConnection & { replyTo: ReturnType<typeof vi.fn>; sendError: ReturnType<typeof vi.fn> }
}

describe('handleGitCredRequest — repoFullName passthrough (issue #457)', () => {
  it('forwards capabilities + repoFullName to mintForAgent and replies with the grant', async () => {
    const mintForAgent = vi.fn(async () => ({
      token: 'ghs_secret',
      ttlSec: 3540,
      expiresAt: '2026-07-11T01:00:00.000Z',
      repoFullName: 'Acme/Tools', // as the grant row stores it — may differ from the ask
      access: 'read' as const
    }))
    const deps = {
      agent: { getUnscoped: async () => PLACED_AGENT },
      github: { mintForAgent }
    } as unknown as DaemonWsDeps
    const conn = fakeConn()
    const frame = gitcredFrame({ capabilities: ['contents'], repoFullName: 'acme/tools' })

    await handleGitCredRequest(frame, conn, deps)

    expect(mintForAgent).toHaveBeenCalledWith(
      PLACED_AGENT,
      [`daemon:${DAEMON_ID}`, `org:org-a`],
      ['contents'],
      'acme/tools'
    )
    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'gitcred/grant', {
      username: 'x-access-token',
      token: 'ghs_secret',
      ttlSec: 3540,
      expiresAt: '2026-07-11T01:00:00.000Z',
      repoFullName: 'Acme/Tools',
      access: 'read'
    })
    expect(conn.sendError).not.toHaveBeenCalled()

    // An absent repoFullName stays absent — the pre-multi-repo workspace ask.
    await handleGitCredRequest(gitcredFrame(), conn, deps)
    expect(mintForAgent).toHaveBeenLastCalledWith(PLACED_AGENT, expect.anything(), undefined, undefined)
  })

  it('uses the enabled-hook mint for a GithubPoster reply instead of the workspace gitAccess path', async () => {
    const mintForAgent = vi.fn()
    const mintForHookReply = vi.fn(async () => ({
      token: 'ghs_comment',
      ttlSec: 3540,
      expiresAt: '2026-07-11T01:00:00.000Z',
      repoFullName: 'acme/infra',
      access: 'read' as const
    }))
    const deps = {
      agent: { getUnscoped: async () => PLACED_AGENT },
      hook: {
        getUnscoped: async () => ({
          agentId: AGENT_ID,
          kind: 'github',
          enabled: true,
          repoId: 501n,
          // The request uses the post-rename name. Authorization must stay on
          // hookId/repoId instead of this stale display field.
          repoFullName: 'acme/infra-old'
        })
      },
      github: { mintForAgent, mintForHookReply }
    } as unknown as DaemonWsDeps
    const conn = fakeConn()
    const frame = gitcredFrame({
      purpose: 'github_hook_reply',
      hookId: HOOK_ID,
      forceRefresh: true,
      capabilities: ['issues', 'pull_requests'],
      repoFullName: 'acme/infra-renamed'
    })

    await handleGitCredRequest(frame, conn, deps)

    expect(mintForHookReply).toHaveBeenCalledWith(
      PLACED_AGENT,
      'acme/infra-renamed',
      501n,
      [`daemon:${DAEMON_ID}`, `org:org-a`],
      true
    )
    expect(mintForAgent).not.toHaveBeenCalled()
    expect(conn.replyTo).toHaveBeenCalledWith(
      frame,
      'gitcred/grant',
      expect.objectContaining({ token: 'ghs_comment', access: 'read' })
    )
  })

  it('denies a GithubPoster mint when no enabled hook watches the requested repo', async () => {
    const mintForHookReply = vi.fn()
    const deps = {
      agent: { getUnscoped: async () => PLACED_AGENT },
      hook: { getUnscoped: async () => null },
      github: { mintForHookReply }
    } as unknown as DaemonWsDeps
    const conn = fakeConn()
    const frame = gitcredFrame({
      purpose: 'github_hook_reply',
      hookId: HOOK_ID,
      capabilities: ['issues', 'pull_requests'],
      repoFullName: 'acme/tools'
    })

    await handleGitCredRequest(frame, conn, deps)

    expect(conn.sendError).toHaveBeenCalledWith(
      frame.id,
      'SCOPE_DENIED',
      'hook is not an enabled github hook of this agent',
      false
    )
    expect(mintForHookReply).not.toHaveBeenCalled()
  })

  it('denies a malformed GithubPoster capability request before minting', async () => {
    const deps = {
      agent: { getUnscoped: async () => PLACED_AGENT },
      github: { mintForHookReply: vi.fn() }
    } as unknown as DaemonWsDeps
    const conn = fakeConn()
    const frame = gitcredFrame({
      purpose: 'github_hook_reply',
      hookId: HOOK_ID,
      capabilities: ['issues', 'contents'],
      repoFullName: 'acme/tools'
    })

    await handleGitCredRequest(frame, conn, deps)

    expect(conn.sendError).toHaveBeenCalledWith(
      frame.id,
      'SCOPE_DENIED',
      'github hook reply credentials require a hook, one repo, and issues/pull_requests only',
      false
    )
  })

  it('maps a GitCredDeniedError onto a correlated error REP (code + retryable preserved)', async () => {
    const deps = {
      agent: { getUnscoped: async () => PLACED_AGENT },
      github: {
        mintForAgent: vi.fn(async () => {
          throw new GitCredDeniedError('acme/tools is not authorized for this agent', 'SCOPE_DENIED', false)
        })
      }
    } as unknown as DaemonWsDeps
    const conn = fakeConn()
    const frame = gitcredFrame({ repoFullName: 'acme/tools' })

    await handleGitCredRequest(frame, conn, deps)

    expect(conn.sendError).toHaveBeenCalledWith(
      frame.id,
      'SCOPE_DENIED',
      'acme/tools is not authorized for this agent',
      false
    )
    expect(conn.replyTo).not.toHaveBeenCalled()
  })
})

const grant = {
  token: 'ghs_kanban',
  ttlSec: 3540,
  expiresAt: '2026-07-11T01:00:00.000Z',
  repoFullName: 'acme/web',
  access: 'read' as const
}

describe('handleGitCredRequest — Kanban run grants', () => {
  const scope = { repoId: 77n, repoFullName: 'acme/web', mode: 'read' as const }

  function kanbanDeps(scopes: Array<typeof scope>, github: Record<string, unknown>) {
    return {
      agent: { getUnscoped: async () => PLACED_AGENT },
      kanbanGrants: { openScopes: async () => scopes },
      github
    } as unknown as DaemonWsDeps
  }

  it('mints a read-scoped run token instead of the workspace grant while a read run is open', async () => {
    const mintForAgent = vi.fn()
    const mintForKanbanRun = vi.fn(async () => ({ ...grant, access: 'read' as const }))
    const conn = fakeConn()
    const frame = gitcredFrame({ capabilities: ['contents', 'issues', 'pull_requests'], repoFullName: 'Acme/Web' })

    await handleGitCredRequest(frame, conn, kanbanDeps([scope], { mintForAgent, mintForKanbanRun }))

    expect(mintForKanbanRun).toHaveBeenCalledWith(PLACED_AGENT, 'Acme/Web', 77n, 'read', [
      `daemon:${DAEMON_ID}`,
      `org:org-a`
    ])
    expect(mintForAgent).not.toHaveBeenCalled()
    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'gitcred/grant', expect.objectContaining({ access: 'read' }))
  })

  it('mints the write run set when every open run on the repo is write', async () => {
    const mintForKanbanRun = vi.fn(async () => ({ ...grant, access: 'write' as const }))
    const conn = fakeConn()
    const frame = gitcredFrame({ repoFullName: 'acme/web' })

    await handleGitCredRequest(
      frame,
      conn,
      kanbanDeps([{ ...scope, mode: 'write' }], { mintForKanbanRun, mintForAgent: vi.fn() })
    )

    expect(mintForKanbanRun).toHaveBeenCalledWith(PLACED_AGENT, 'acme/web', 77n, 'write', expect.any(Array))
    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'gitcred/grant', expect.objectContaining({ access: 'write' }))
  })

  it('keeps the workspace grant when the request names a different repo', async () => {
    const mintForAgent = vi.fn(async () => grant)
    const mintForKanbanRun = vi.fn()
    const conn = fakeConn()
    const frame = gitcredFrame({ repoFullName: 'acme/other' })

    await handleGitCredRequest(frame, conn, kanbanDeps([scope], { mintForAgent, mintForKanbanRun }))

    expect(mintForKanbanRun).not.toHaveBeenCalled()
    expect(mintForAgent).toHaveBeenCalled()
  })

  it('mints an issues-write poster token for an open run and refuses without one', async () => {
    const mintForKanbanComment = vi.fn(async () => grant)
    const conn = fakeConn()
    const frame = gitcredFrame({
      purpose: 'kanban_comment',
      capabilities: ['issues'],
      repoFullName: 'acme/web',
      forceRefresh: true
    })

    await handleGitCredRequest(frame, conn, kanbanDeps([scope], { mintForKanbanComment }))

    expect(mintForKanbanComment).toHaveBeenCalledWith(
      PLACED_AGENT,
      'acme/web',
      77n,
      [`daemon:${DAEMON_ID}`, `org:org-a`],
      true
    )
    expect(conn.replyTo).toHaveBeenCalledWith(frame, 'gitcred/grant', expect.objectContaining({ token: 'ghs_kanban' }))

    const denied = fakeConn()
    await handleGitCredRequest(frame, denied, kanbanDeps([], { mintForKanbanComment }))
    expect(denied.sendError).toHaveBeenCalledWith(
      frame.id,
      'SCOPE_DENIED',
      'kanban comment credentials require an open run on the requested repo',
      false
    )
  })
})
