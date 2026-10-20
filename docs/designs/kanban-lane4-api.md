# Kanban Lane 4 API contracts

Per-lane contract notes for the Kanban M5 and console work. Each lane edits only its own `##` section so parallel lanes merge cleanly. Parent tracking: [issue #2](https://github.com/mw-ding/agentconnect/issues/2).

## 4a

M5 Projects v2 `Status` projection (org-owned only) plus the consolidated design at [kanban-swarm.md](kanban-swarm.md). Issues and labels stay the system of record; the project's `Status` single-select field is a one-way, best-effort mirror the CP writes for humans.

Board fields: `POST` and `PATCH /api/v1/orgs/:orgId/kanban/boards` accept optional `projectNodeId` + `statusFieldId`, both-or-neither. The pair is stored on the board and returned in the board DTO. `PATCH { projectNodeId: null, statusFieldId: null }` clears both without minting a Projects token or calling Projects; the normal live repository coverage check still runs. Changing the repo (`repoFullName`) or setting a new pair re-proves the guard; PATCH compares the validated `configRevision` under the board lock and returns HTTP 409 `stale` if a concurrent edit invalidated that snapshot; without a verifier/GitHub App the create path refuses with `github_app_not_configured` (409). Migration `20261123300000_kanban_board_project_projection` adds the two board columns with a both-null-or-both-set CHECK, plus `kanban_card.projectItemId`, a cache of the `ProjectV2Item` id so later writes skip the add. Migration `20261123300100_kanban_card_project_item_project` adds `kanban_card.projectItemProjectId`, the project that item belongs to: an item cached for any other project (a re-pointed board) or with no recorded project (a legacy row) is never reused, and the card is re-added through the idempotent add.

Re-pointing a board from P1 to P2 does **not** backfill existing cards. A card appears on P2 only at its next committed status change.

Refusal codes (HTTP 400 unless noted):

| HTTP | `code`                      | When                                                                                                                                                |
| ---- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `project_requires_org_repo` | the board's repo owner is not an Organization                                                                                                       |
| 400  | `project_not_found`         | the project is missing, or the token cannot see it (GraphQL FORBIDDEN/NOT_FOUND, HTTP 403/404/422 on the guard read); never leaks GitHub error text |
| 400  | `project_not_org_owned`     | the project is owned by a User                                                                                                                      |
| 400  | `project_owner_mismatch`    | the project's org login differs from the repo owner (case-insensitive)                                                                              |
| 400  | `status_field_invalid`      | `statusFieldId` is not a single-select field of that project                                                                                        |
| 409  | `github_app_not_configured` | project fields given with no verifier/GitHub App                                                                                                    |
| 429  | `github_rate_limited`       | GitHub rate limit                                                                                                                                   |
| 502  | `github_unavailable`        | every other GitHub API failure, including an HTTP 401 (our own App credential misconfig, never a project verdict)                                   |

The guard is pure (`judgeProjectConfig`) over the repo owner type plus one live GraphQL read of `node(id:) { ... on ProjectV2 { owner, field } }` with `strictErrors`, so a 200 carrying `errors[]` beside partial data still denies as `project_not_found` with log reason `project_access_denied`.

Required Status options: the field must offer one option per CP status, named `Triage`, `Todo`, `Ready`, `Running`, `Blocked`, `Review`, `Done`, `Archived` (matched case-insensitively, so `ready` or `READY` also work). Nothing else is mapped: GitHub's default Status field (`Todo`, `In Progress`, `Done`) projects only `todo` and `done`, and every other status logs `project_option_missing` with no write until the admin adds the missing options (`In Progress` is never used).

Token scope: the `kanban_project` token is minted with `repository_ids: [boardRepoId]`, but only the repository permissions (`issues:read`, `metadata:read`) are narrowed by it. `organization_projects:write` is an organization permission and applies to every project of the installation's org; GitHub offers no per-project or per-repo narrowing, so this is the least privilege available. The runtime owner check below keeps writes on the board's own org.

Writer contract (`cp/src/kanban/project-writer.ts`, `KanbanProjectWriter.project`): mint the `kanban_project` token; read the field's options and owner, cached per (installation id, project, field) for 5 minutes in a bounded map (256 entries, least recently used evicted) that drops an entry whenever a status write fails, so a deleted option is re-read on the next write; re-check the cached owner is an Organization whose login equals the board repo owner case-insensitively (`project_owner_mismatch` otherwise, with no write, which also covers a dev PAT that can reach other orgs); resolve the option; reuse the cached item only when `projectItemProjectId` is this project, else `addProjectV2ItemById` (idempotent); then `updateProjectV2ItemFieldValue`. When a write on a cached item fails with GraphQL `NOT_FOUND` (the item was removed from the project by hand), the writer re-adds once, writes again, and returns the new id; FORBIDDEN stays a denial and never re-adds. The hook stores the item id with its project whenever either changed.

Post-commit seam (`kanbanProjectHook`, `onStatusCommitted({ boardId, issueNumber, issueNodeId? })`): every committed card status change calls it once after its transaction: dispatcher transitions (ack → running, run end, reaper, a dispatch that finds GitHub moved the card), human recovery (`ingestStatus`), graph promotion (todo → ready once the intent clears, its rollback, and recovery's adopt/clear/escalate), the #194 KanbanSync reconcile (human label adoption, reassignment restart, fail-closed), import, and Lane 2b orchestrator creation, unblock, reassignment restart and epic-budget fallback. Sync queues each status immediately after the repository commit, before revocation, label/comment writes, acknowledgement or promotion can fail; assignment-only changes and failed commits queue nothing. It returns at once and runs on its own per-card queue, apart from label writes, so a slow Projects write never delays a later label write for that card. Each run projects the card's status as committed when the run starts, so a burst of commits coalesces into one queued run and out-of-order callers still converge on the latest status. The projection never blocks or fails a transition: every failure is logged with a body-free reason and swallowed. Project UI edits are not reconciled: nothing reads the `Status` field back, so a human edit there stays until the card's next committed status change overwrites it (known gap).

Shutdown settles the dispatcher and graph-doorbell producers (including their sync, graph and import work) before settling the projection queue and disconnecting Prisma. Lane 3 M4 (Refs #414) is integrated: worker review requests, verifier approvals that change status, request-changes returns to ready, and the review-round limit to triage use the same post-commit seam. A verify claim or PR-contract approval that keeps the card in review queues no status projection.

Failure reason codes: `project_issue_node_missing` (skip before minting), `project_not_org_owned` (runtime re-check), `project_owner_mismatch` (runtime owner-login re-check), `project_option_missing`, `project_item_add_failed`, `project_field_write_failed`, `project_item_missing` (a cached item answered NOT_FOUND; one line with `recovered: true`, or `recovered: false` plus the failing step's reason as `cause`), `project_access_denied` (a GitHub denial: GraphQL FORBIDDEN/NOT_FOUND, HTTP 403/404/422), `project_rate_limited` (RATE_LIMITED). An HTTP 401 is our credential misconfig and logs the step's own reason. Board without a pair means no mint and no call.

Re-consent note: the GitHub App manifest now requests `organization_projects:write`. Existing installations must re-consent (GitHub emails the org owner); until then the projection fails closed with `project_access_denied` and transitions keep working.

Still **UNVERIFIED until Block B (the MD-gated live test)** runs:

- The real `addProjectV2ItemById` / `updateProjectV2ItemFieldValue` calls against an org project.
- A token mint combining `repository_ids` with `organization_projects`.
- The real error types for an installation that has not re-consented, and for a removed item (`project_item_missing` assumes GraphQL `NOT_FOUND`).
- The option id format.
- The end-to-end transition → Status flow.
