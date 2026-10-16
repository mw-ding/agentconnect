// Kanban final poster token: an App installation token (issues write) or, when the App is off, the injected PAT.
import { GithubFinalPoster, type GithubCommentAttributionSource } from './poster.js'

export function kanbanCommentToken(opts: {
  mint?: () => Promise<string>
  injected?: () => Promise<string>
  log: { warn(message: string): void }
}): () => Promise<string> {
  if (opts.mint) return opts.mint
  opts.log.warn('kanban: GitHub App is not configured; the final poster is using the injected token')
  const injected = opts.injected
  if (!injected) throw new Error('kanban poster has no token source')
  return injected
}

/** Poster whose token is issues:write on the board repo and never enters the agent environment. */
export function kanbanFinalPoster(opts: {
  repo: string
  issueNumber: number
  log: { warn(message: string): void }
  mint?: () => Promise<string>
  invalidateMinted?: (token: string) => void
  injected?: () => Promise<string>
  attribution?: GithubCommentAttributionSource
}): GithubFinalPoster {
  const minted = opts.mint !== undefined
  return new GithubFinalPoster(
    {
      token: kanbanCommentToken(opts),
      ...(minted && opts.invalidateMinted ? { invalidateToken: opts.invalidateMinted } : {}),
      log: opts.log
    },
    opts.repo,
    opts.issueNumber,
    opts.attribution
  )
}
