// Which open Kanban run, if any, clamps a daemon gitcred grant (issue #2 M3).
import { gitRepoLabel } from '@agentconnect.md/protocol'
import type { KanbanGrantScope } from '../persistence/ports.js'

/** The repo a gitcred request is for: the named repo, else a GitHub-credentialed workspace. */
export function kanbanRequestRepo(
  requested: string | undefined,
  workspace: { mode?: string; gitRepo?: string; credential?: { provider: string } } | undefined
): string | undefined {
  if (requested?.includes('/')) return requested
  if (workspace?.mode !== 'git' || workspace.credential?.provider !== 'github' || !workspace.gitRepo) return undefined
  const label = gitRepoLabel(workspace.gitRepo)
  return label.includes('/') ? label : undefined
}

/** Open runs on one repo. Any read run wins so the shared daemon token cannot write. */
export function kanbanGrantFor(
  scopes: readonly KanbanGrantScope[],
  repoFullName: string
): KanbanGrantScope | undefined {
  const want = repoFullName.toLowerCase()
  const matches = scopes.filter((scope) => scope.repoFullName.toLowerCase() === want)
  if (matches.length === 0) return undefined
  const mode = matches.some((scope) => scope.mode === 'read') ? 'read' : 'write'
  return { repoId: matches[0]!.repoId, repoFullName: matches[0]!.repoFullName, mode }
}
