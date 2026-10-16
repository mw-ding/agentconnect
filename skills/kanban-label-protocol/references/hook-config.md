# GitHub hook config (Kanban P0, per worker agent)

Each **worker agent** that can be assigned cards needs its own GitHub hook on the **board repository**. The hook fires when a **human** adds a label such that the issue’s **current** labels intersect `labelFilter`.

## Console / API fields

| Field          | P0 value                 | Notes                                                                                                                          |
| -------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `kind`         | `github`                 | GitHub App webhook subscription                                                                                                |
| `agentId`      | UUID of the worker agent | One hook per agent per repo (duplicate agent+repo returns 409)                                                                 |
| `name`         | e.g. `kanban-<slug>`     | Operator-chosen label                                                                                                          |
| `repoFullName` | `owner/repo`             | Kanban board repo; must be under a GitHub App installation that covers that repo (org or user account — same as Prerequisites) |
| `events`       | `["issues:labeled"]`     | Matches `issues:labeled` (valid event pattern)                                                                                 |
| `labelFilter`  | `["ac/agent:<slug>"]`    | `<slug>` must match the label and the agent’s public slug/name convention                                                      |
| `mentionOnly`  | `false`                  | Recommended for P0 — dispatch is label-driven, not @-mention summon                                                            |
| `enabled`      | `true`                   |                                                                                                                                |
| Session mode   | `perThread` (implicit)   | Same issue continues one session; not configurable for `kind: github`                                                          |

Optional fields (`commentFamilies`, `reviewPolicy`, `reportingMode`, `gateMode`) can stay at defaults for P0 unless the org already uses PR review hooks on the same agent.

## Example `POST` body

Org-scoped route: `POST /hooks` under `/api/v1/orgs/:orgId` (Console uses the same API). Replace placeholders.

```json
{
  "kind": "github",
  "agentId": "00000000-0000-4000-8000-000000000001",
  "name": "kanban-worker-alpha",
  "enabled": true,
  "repoFullName": "acme/kanban-board",
  "events": ["issues:labeled"],
  "labelFilter": ["ac/agent:worker-alpha"],
  "mentionOnly": false
}
```

## How `labelFilter` matches

- Matching is **intersection** with the issue’s **current** label names after the event is applied (not only the newly added label name).
- For `issues:labeled`, GitHub delivers when a label is **added**. The added label is included in the issue’s label set for matching.
- Example: `labelFilter: ["ac/agent:worker-alpha"]` matches only if the issue currently has `ac/agent:worker-alpha` (among any other labels).
- **Important (re-dispatch):** while `ac/agent:<slug>` remains on the card, **every** subsequent human label add (`ac/status:running`, `review`, `blocked`, `done`, …) also matches and starts another worker turn. Remove the assignee label before status moves. When you intend to dispatch, add `ac/agent:<slug>` **alone** (its own action) — never with another label in the same edit, and never at issue creation. GitHub sends one delivery per label; the daemon dedupes per delivery only, so bundled adds can start 2+ turns. Empty `labelFilter` means no label gate (not recommended for Kanban P0).

## Prerequisites

1. **Agent placed** on a connected daemon.
2. **GitHub App** installed on the **org or user account** that owns `repoFullName`, with access to that repo. (P0 accepts either; issue #2 §8 may later standardize board ownership.)
3. **AgentRepoAuthorization** (or workspace repo alignment) so the agent may watch the repo — see [webhook-triggers-and-github-events.md](../../../docs/designs/webhook-triggers-and-github-events.md).
4. **Relay** registered and `PUBLIC_RELAY_URL` set (hook creation fails with 409 otherwise).
5. **Skill enabled** on the agent: skill source → this repo’s `skills/` tree → `kanban-label-protocol` (see [kanban-p0-pilot.md](../../../docs/designs/kanban-p0-pilot.md)).
6. **Issue author permission:** for `issues` events the relay authorizes the **issue author** (not the person who added the label). The author needs live write/admin access on the repo. A card filed by a read-only user will **not** dispatch even when a maintainer adds `ac/agent:<slug>`.

## Dispatch flow (happy path)

```text
Human sets ac/status:ready (assignee label still off)
Human adds ac/agent:<slug> alone (own action; not at create)
  → GitHub issues:labeled (senderType User)
  → Relay matches hook (event + labelFilter + installation + issue-author authz)
  → Daemon opens/continues perThread session on that issue
  → Worker follows kanban-label-protocol skill
  → Worker final answer starts with Kanban: … ; daemon posts it
Human removes ac/agent:<slug>, then sets ac/status:done|review|blocked
```

## Known gap (P0)

GitHub deliveries where `sender.type` is **Bot** are vetoed in relay GitHub ingress (except narrow App PR review paths). Therefore:

- Labels applied by the **GitHub App**, **github-actions**, or the **agent’s own bot identity** do **not** dispatch hooks.
- Workers **cannot** drive the board by editing labels in P0; humans (or non-bot users) must apply `ac/status:*` and assignee labels.
- There is **no** agent-driven dispatch, **no** concurrency caps, and **no** leases in P0 — only human label moves plus hook-fired sessions.
- A worker that edits labels with a **user** PAT (`senderType: User`) **will** re-dispatch if `ac/agent:<slug>` is still present — do not do that in the pilot.

Reference implementation: `packages/relay/src/hooks/github-ingress.ts` (`senderType === 'Bot'` gate; issue-author authz for `issues` events). This document does not change that behavior.
