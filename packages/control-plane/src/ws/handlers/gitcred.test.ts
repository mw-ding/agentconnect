import { describe, expect, it, vi } from 'vitest'
import type { AnyFrame } from '@agentconnect.md/protocol'
import { GitCredDeniedError } from '../../github/service.js'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { handleGitCredRequest } from './gitcred.js'

const DAEMON_ID = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const AGENT_ID = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const HOOK_ID = 'b0b0b0b0-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const LEASE_ID = 'c0c0c0c0-cccc-4ccc-8ccc-cccccccccccc'

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

  it('mints an issues-only token for an accepted Kanban lease and never the workspace git path', async () => {
    const mintForAgent = vi.fn()
    const mintForKanbanComment = vi.fn(async () => ({
      token: 'ghs_kanban',
      ttlSec: 3540,
      expiresAt: '2026-07-11T01:00:00.000Z',
      repoFullName: 'acme/web',
      access: 'read' as const
    }))
    const commentGrant = vi.fn(async () => ({ repoId: 42n }))
    const deps = {
      agent: { getUnscoped: async () => PLACED_AGENT },
      kanbanDispatcher: { commentGrant },
      github: { mintForAgent, mintForKanbanComment }
    } as unknown as DaemonWsDeps
    const conn = fakeConn()
    const frame = gitcredFrame({
      purpose: 'kanban_card_write',
      leaseId: LEASE_ID,
      capabilities: ['issues'],
      repoFullName: 'acme/web',
      forceRefresh: true
    })

    await handleGitCredRequest(frame, conn, deps)

    expect(commentGrant).toHaveBeenCalledWith(DAEMON_ID, AGENT_ID, LEASE_ID, 'acme/web')
    expect(mintForKanbanComment).toHaveBeenCalledWith(
      PLACED_AGENT,
      'acme/web',
      42n,
      [`daemon:${DAEMON_ID}`, `org:org-a`],
      true
    )
    expect(mintForAgent).not.toHaveBeenCalled()
    expect(conn.replyTo).toHaveBeenCalledWith(
      frame,
      'gitcred/grant',
      expect.objectContaining({ token: 'ghs_kanban', access: 'read' })
    )
  })

  it('denies a Kanban comment token when the lease was not accepted or the ask is wider than issues', async () => {
    const mintForKanbanComment = vi.fn()
    const commentGrant = vi.fn(async () => null)
    const deps = {
      agent: { getUnscoped: async () => PLACED_AGENT },
      kanbanDispatcher: { commentGrant },
      github: { mintForKanbanComment }
    } as unknown as DaemonWsDeps
    const conn = fakeConn()
    const refused = gitcredFrame({
      purpose: 'kanban_card_write',
      leaseId: LEASE_ID,
      capabilities: ['issues'],
      repoFullName: 'acme/web'
    })
    await handleGitCredRequest(refused, conn, deps)
    expect(conn.sendError).toHaveBeenCalledWith(
      refused.id,
      'SCOPE_DENIED',
      'lease does not authorize a kanban comment on this repo',
      false
    )

    const wide = gitcredFrame({
      purpose: 'kanban_card_write',
      leaseId: LEASE_ID,
      capabilities: ['issues', 'contents'],
      repoFullName: 'acme/web'
    })
    await handleGitCredRequest(wide, conn, deps)
    expect(conn.sendError).toHaveBeenCalledWith(
      wide.id,
      'SCOPE_DENIED',
      'kanban comment credentials require an accepted lease, one repo, and issues only',
      false
    )
    expect(mintForKanbanComment).not.toHaveBeenCalled()
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
