// Kanban write-card branch naming (issue #2 B3): one worktree + branch per write card, so work resumes after a restart and never collides with another card.
export const KANBAN_CARD_BRANCH_PREFIX = 'ac/card-'

/** The branch a WRITE-mode Kanban run for issue #n checks out. Read-mode runs are unchanged. */
export function kanbanCardBranch(issueNumber: number): string {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`kanban card branch needs a positive issue number, got ${String(issueNumber)}`)
  }
  return `${KANBAN_CARD_BRANCH_PREFIX}${issueNumber}`
}
