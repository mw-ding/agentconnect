# Kanban swarm design (as built)

Parent tracking: [issue #2](https://github.com/mw-ding/agentconnect/issues/2). This is the consolidated Kanban design: [kanban-p0-pilot.md](kanban-p0-pilot.md) stays the pilot/history doc (linked for history, not repeated here) plus the TRD decisions it records. Lane 4 API deltas live in [kanban-lane4-api.md](kanban-lane4-api.md).

## Overview and invariants (D1–D5)

- **D1 — Issues are the system of record; the Project is a projection.** Card state lives in issue labels, issue state, and native links; every transition is driven by repository webhooks. The Project v2 `Status` field is a one-way mirror the CP writes for humans. User-owned projects are unsupported (no installation-token access, no webhooks).
- **D2 — Push dispatch with a centralized CP claim.** `SELECT … FOR UPDATE SKIP LOCKED` gives atomic single assignment, per-board and per-agent `maxInProgress` caps, and fencing via `leaseId` plus `dispatchRevision`.
- **D3 — The CP stays off the content path.** It stores and sends only body-free card metadata: ids, logins, statuses, counters, leases, runs. The `kanban/dispatch` frame carries no title or body; the console board shows titles by proxying a live GitHub read through the BFF without persisting it.
- **D4 — Session affinity reuses the GitHub thread key.** A dispatched card opens or resumes the ACP session keyed `github#<issueNumber>`, so a human comment on the card lands in the worker's session.
- **D5 — One writer per effect.** Only the CP state machine writes status labels and the Project field; agents change status only through tools, never through `gh`. Terminal tools write exactly one summary comment.

## Data model

`KanbanBoard` (`cp/prisma/schema.prisma`): identity (`id`, `orgId`, `name`), watched repo (`repoId` numeric and rename-proof, `repoFullName` display-only), orchestrator/verifier agents, caps (`maxInProgress`, `maxInProgressPerAgent`, `staleLeaseSec`, `failureLimit`, `protocolRetryLimit`, `blockRecurrenceLimit`), `defaultMode` (`read`/`write`), `completionContract`, the projection pair (`projectNodeId`, `statusFieldId`, both set or both null by CHECK), `enabled`, `visibility`/`sharedWith`, audit ids.

`KanbanCard`: `boardId`, GitHub ids (`issueId`, `issueNumber`, `issueNodeId`), `projectItemId` plus `projectItemProjectId` (the cached `ProjectV2Item` id and the project it belongs to, so later Status writes there skip the add), `idempotencyKey` (orchestrator creates), `status`, `assigneeAgentId`, `priority`, `mode` override, `stateRevision`/`dispatchRevision`, plus the lease, promotion-intent, recovery-backoff, and attention columns the sections below use. Runs, leases, and audit rows are covered by the lane-1 contract ([kanban-lane1-api.md](kanban-lane1-api.md)) and the pilot doc's M2/M3 sections.

## State machine and labels

Statuses: `triage, todo, ready, running, blocked, review, done, archived`. GitHub carries them as `ac/status:<status>` labels (detected case-insensitively, valid only in canonical lowercase), assignment as `ac/agent:<slug>`, mode display as `ac/mode:*`. The exhaustive transition table is `KANBAN_TRANSITIONS` (`cp/src/kanban/card-state.ts`). Import keeps a status only with attested human authority (Lane 1, [kanban-lane1-api.md](kanban-lane1-api.md) §§1–4); mismatch-parked cards un-park only on a human `User` status edit verified through the events API; promotion residue, recovery backoff, and escalation (`needsAttention` + a fixed body-free comment) are in [kanban-p0-pilot.md](kanban-p0-pilot.md) §§M2–M3.

## Dispatcher, claim, and leases

Claims, reports, heartbeats, and the reaper run in `KanbanDispatcher` over `KanbanDispatchRepo`; a daemon posts the one summary after acceptance while the CP only mints its `kanban_card_write` token. Caps, cooldowns, provider-transient backoff, and the nudge protocol are in [kanban-p0-pilot.md](kanban-p0-pilot.md) §M3. Two sibling-owned seams plug in here at a high level: Lane 3's claim-eligibility predicate (`explainClaim`) powers the CP explain endpoint that tells an operator why a card is not running, and Lane 4b's `dispatch --dry-run` diagnostic reuses that predicate from the console (see [kanban-lane4-api.md](kanban-lane4-api.md) `## 4b` once it lands). The console board shows CP metadata plus live titles proxied through the CP, never persisted.

## Worker protocol and tools

A dispatched turn that ends without a terminal call gets one nudge asking for exactly one of `kanbanComplete`, `kanbanRequestReview`, `kanbanBlock`, or `kanbanFail`; provider errors classify to `transient/provider_*` vs counted `failed` under the daemon-side classifier. `kanbanShow`/`kanbanComment` resolve the worker's own card from the trusted session context through the fenced `kanban/card` RPC; the daemon reads GitHub directly, normalizes a copy for untrusted-content fencing only, and returns the originals. Details are in [kanban-p0-pilot.md](kanban-p0-pilot.md) §M3.

## Tokens and GitHub App permissions

Purpose-bound installation tokens, each scoped by numeric repo id: the daemon run grant (`contents`/`issues`/`pull_requests` at the run's mode, `workflows:write` following contents write), the CP card token (`issues` read/write), the daemon summary token (`issues:write`), and the CP projection token (`organization_projects:write`, `issues:read`, `metadata:read` riding along). The manifest (`packages/setup/src/github-app.ts`) requests contents/issues/pull-requests/actions/checks/workflows write plus metadata/deployments/emails read and `organization_projects:write`; events are `push`, `issues`, `issue_comment`, `pull_request*`, checks, runs, deployments, releases, `repository`, and the graph pair `sub_issues`/`issue_dependencies`. The drift audit reports repo vs `Organization permissions` separately. Webhook delivery points at the relay with `X-Hub-Signature-256`; verified deliveries become body-free doorbells. Existing installations must re-consent to the new org permission (GitHub emails the org owner); until then the projection fails closed with `project_access_denied` and transitions keep working.

## Project v2 projection (M5 5.1)

Board CRUD carries the optional `projectNodeId` + `statusFieldId` pair (both-or-neither; null clears). The org-only guard requires an Organization repo owner, a live GraphQL read showing an Organization-owned project whose login matches the repo owner, and a single-select field of that project; denials map to stable codes without leaking GitHub text. Every committed status change (dispatcher, human recovery, graph promotion, the #194 sync reconcile, import, and Lane 2b orchestrator creation/unblock/reassignment/epic-budget fallback) queues a best-effort projection of the card's committed status on its own per-card queue: mint, re-check the project owner, resolve the option by case-insensitive name, idempotent add (cached on the card with its project; a NOT_FOUND item is re-added once), field write, swallow with a body-free reason. Full contract, codes, and mapping are in [kanban-lane4-api.md](kanban-lane4-api.md) `## 4a`.

Sync queues the projection immediately after each successful status-changing repository call, before later GitHub effects can fail. Shutdown drains the dispatcher and graph doorbell (including sync, graph and import) before the projection queue. Re-pointing a board does not backfill; existing cards reach the new project on their next committed status change. Lane 3 (Refs #414, Refs #415) is not on merged main `2ed09a787`; its verifier-routing and request-changes transitions must call `onStatusCommitted` after successful commits.

## Humans in the loop (M4)

M4 review routing (`review` → the board's verifier agent, `submitGithubReview` on the linked PR), PR completion contracts, and notifications ride the milestones above; the owned M4 pieces (claim eligibility explanations, approval/control surfaces) belong to Lane 3's docs where they exist, and the TRD (§9 M-table) where they do not yet.

## Operations runbook

- Database: `TEST_DATABASE_URL` to a dedicated Postgres 17 database; `test:int` migrates, seeds, clones per worker, and drops the clones. Production deploys with `prisma migrate deploy` (migrations `20261123300000_kanban_board_project_projection` and `20261123300100_kanban_card_project_item_project` for the projection columns).
- Token cache: keyed by installation, repo id, permission levels, and purpose; drop it on permission, suspension, or reinstall changes (`invalidateInstallation`). A grant minted for one run may serve a later same-mode run until 15 minutes before expiry.
- Webhooks: the 10-minute redelivery sweep re-asks GitHub for doorbells that never landed (at most 3 tries per delivery, live relay required).
- Projection: needs the App installed on the board repo with `organization_projects:write` consented; a PAT fallback needs the `project` scope (dev only). Rotated option names take up to 5 minutes (field-options TTL), or one failed write.

## Known gaps

History stays in [kanban-p0-pilot.md](kanban-p0-pilot.md); these are the consolidated open items: user-owned Projects v2 stay unsupported (no write path, no webhooks); Project UI edits are not reconciled: nothing reads the `Status` field back, so a human edit there stays until the card's next committed status change overwrites it; renamed Status options lag up to the field cache TTL; the console has no projection controls and no M3 attention-flag surface; the items above under M4 belong to their owning lanes.
