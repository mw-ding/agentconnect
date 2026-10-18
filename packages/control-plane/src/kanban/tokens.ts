// Kanban GitHub tokens: App installation tokens when configured, otherwise a dev/test injected PAT (issue #2 M3).
import type { InstallationTokenService, MintedGitCred } from '../github/installation-token.service.js'

export type KanbanTokenMinter = Pick<InstallationTokenService, 'mintKanbanCard' | 'mintKanbanRun' | 'mintKanbanPr'>

/** App tokens when the GitHub App is configured; otherwise a dev/test injected PAT, with one warning. */
export function kanbanTokenSource(opts: {
  app?: KanbanTokenMinter
  injectedToken?: string
  log?: { warn(message: string): void }
}): KanbanTokenMinter | undefined {
  if (opts.app) return opts.app
  const token = opts.injectedToken?.trim()
  if (!token) return undefined
  opts.log?.warn(
    'kanban: GitHub App is not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY_B64); using the injected token'
  )
  const grant = (repoFullName: string, access: 'read' | 'write'): MintedGitCred => ({
    token,
    ttlSec: 3600,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    repoFullName,
    access
  })
  return {
    mintKanbanCard: async (_installationId, repoFullName, _repoId, access) => grant(repoFullName, access),
    mintKanbanRun: async (_installationId, repoFullName, _repoId, mode) => grant(repoFullName, mode),
    mintKanbanPr: async (_installationId, repoFullName) => grant(repoFullName, 'read')
  }
}
