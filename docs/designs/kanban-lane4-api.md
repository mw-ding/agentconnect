# Kanban Lane 4 API contracts

Per-lane contract notes for the Kanban M5 and console work. Each lane edits only its own `##` section so parallel lanes merge cleanly. Parent tracking: [issue #2](https://github.com/mw-ding/agentconnect/issues/2).

## 4a

M5 Projects v2 `Status` projection (org-owned only) plus the consolidated design at [kanban-swarm.md](kanban-swarm.md). Issues and labels stay the system of record; the project's `Status` single-select field is a one-way, best-effort mirror the CP writes for humans.

Board fields: `POST` and `PATCH /api/v1/orgs/:orgId/kanban/boards` accept optional `projectNodeId` + `statusFieldId`, both-or-neither. The pair is stored on the board and returned in the board DTO. `PATCH { projectNodeId: null, statusFieldId: null }` clears both without any GitHub call. Changing the repo (`repoFullName`) or setting a new pair re-proves the guard; without a verifier/GitHub App the create path refuses with `github_app_not_configured` (409). Migration `20261123300000_kanban_board_project_projection` adds the two board columns with a both-null-or-both-set CHECK, plus `kanban_card.projectItemId`, a cache of the `ProjectV2Item` id so later writes skip the add.

Refusal codes (HTTP 400 unless noted):

| HTTP | `code`                      | When                                                                                                                                                |
| ---- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `project_requires_org_repo` | the board's repo owner is not an Organization                                                                                                       |
| 400  | `project_not_found`         | the project is missing, or the token cannot see it (GraphQL FORBIDDEN/NOT_FOUND, HTTP 401/403/404 on the guard read); never leaks GitHub error text |
| 400  | `project_not_org_owned`     | the project is owned by a User                                                                                                                      |
| 400  | `project_owner_mismatch`    | the project's org login differs from the repo owner (case-insensitive)                                                                              |
| 400  | `status_field_invalid`      | `statusFieldId` is not a single-select field of that project                                                                                        |
| 409  | `github_app_not_configured` | project fields given with no verifier/GitHub App                                                                                                    |
| 429  | `github_rate_limited`       | GitHub rate limit                                                                                                                                   |
| 502  | `github_unavailable`        | other GitHub API failure, including our own 401 credential misconfig                                                                                |

The guard is pure (`judgeProjectConfig`) over the repo owner type plus one live GraphQL read of `node(id:) { ... on ProjectV2 { owner, field } }` with `strictErrors`, so a 200 carrying `errors[]` beside partial data still denies as `project_not_found` with log reason `project_access_denied`.

Option-name mapping: CP statuses `triage/todo/ready/running/blocked/review/done/archived` map to option names `Triage/Todo/Ready/Running/Blocked/Review/Done/Archived`, matched case-insensitively because admins capitalize freely.

Writer contract (`cp/src/kanban/project-writer.ts`, `KanbanProjectWriter.project`): mint the `kanban_project` token (`organization_projects:write`, `issues:read`, `metadata:read` riding along, scoped by repo id); read the field's options (cached per project+field for 5 minutes); re-check the cached owner is an Organization; resolve the option; `addProjectV2ItemById` (idempotent; skipped when the card caches `projectItemId`); then `updateProjectV2ItemFieldValue`. The dispatcher calls `projectAfterLabel` once, after the status label write succeeds, and the hook remembers a fresh item id. The projection never blocks or fails a transition: every failure is logged with a body-free reason and swallowed.

Failure reason codes: `project_issue_node_missing` (skip before minting), `project_not_org_owned` (runtime re-check), `project_option_missing`, `project_item_add_failed`, `project_field_write_failed`, `project_access_denied` (denial or limit mapped from LEASE_DENIED), `project_rate_limited` (RATE_LIMITED). Board without a pair means no mint and no call.

Re-consent note: the GitHub App manifest now requests `organization_projects:write`. Existing installations must re-consent (GitHub emails the org owner); until then the projection fails closed with `project_access_denied` and transitions keep working.
