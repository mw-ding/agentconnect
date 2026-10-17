# Kanban Lane 3 API

This document tracks the CP HTTP surface and daemon behavior added by Lane 3
(human-in-the-loop milestones). Sections are added per lane so sibling PRs merge
cleanly.

## 3c

Human controls (issue #2 B5) and the per-card write branch + synthesizer (B3).

### Routes (all owner + interactive OIDC, like the run-mode setters)

- `POST /api/v1/orgs/:orgId/kanban/boards/:boardId/pause` — pause a board.
  Idempotent; a paused board claims nothing but its reaper, reports, heartbeats,
  label sync, graph promotion and doorbells keep running. Returns the board DTO.
- `POST /api/v1/orgs/:orgId/kanban/boards/:boardId/resume` — resume and re-arm
  the dispatcher. Idempotent. Returns the board DTO.
- `POST /api/v1/orgs/:orgId/kanban/boards/:boardId/cards/:cardId/skip` — archive
  the card (issue closed `not_planned`), revoke any open lease with a
  dispatch-revision bump, and post one body-free comment. `404` for a card not on
  the board, `409` when the transition is not allowed.
- `POST /api/v1/orgs/:orgId/kanban/boards/:boardId/cards/:cardId/restart` — reset
  the card to `ready` (clearing failure counters, block recurrence, cooldown,
  block kind, and the attention flag), revoke any open lease, reopen a closed
  issue, write the status label and one body-free comment, then re-arm the
  dispatcher. `404`/`409` as above.

All four leave body-free audit rows: `board_paused`, `board_resumed`,
`card_skipped`, `card_restarted`.

### Board fields

`KanbanBoard` gains `paused` (default false), `pausedAt`, `pausedByUserId`
(`User` FK, `SetNull`), and `synthesizerAgentId` (`Agent` FK, `SetNull`).
`synthesizerAgentId` is accepted on the board CRUD bodies and validated like
`verifierAgentId` (an agent of the board's organization).

### Synthesizer card (B3)

A card whose issue has sub-issues (an epic) and is `todo` is promoted to `ready`
and assigned to `synthesizerAgentId` when every sub-issue is closed `completed`
and the graph read is not truncated; any `not_planned`/open sub-issue, a truncated
read, or no synthesizer configured leaves it alone. This is `planSynthesis` in
`cp/src/kanban/graph-reconciler.ts`, evaluated beside the existing blocker
promotion, with a sub-issue close re-evaluating its parent epic (the mirror of a
blocker re-evaluating its dependents). The write uses the same CAS + promotion
intent + idempotent label-write pattern as graph promotion.

### Write-card branch (B3)

A WRITE-mode Kanban run for issue #n checks out its session worktree on branch
`ac/card-<n>`, created from the repository's default branch on first use and
reused on later attempts and after a restart; it is never reused for another
card. The branch name comes from `kanbanCardBranch` in
`packages/daemon/src/kanban/card-branch.ts` and is told to the worker in the
kanban prompt. Read-mode runs are unchanged.
