# GitHub hook config (Kanban P0, per worker agent)

Each **worker agent** that can be assigned cards needs its own GitHub hook on the **board repository**. The hook fires when a **human** adds a label such that the issue’s **current** labels intersect `labelFilter`.

## Console / API fields

| Field | P0 value | Notes |
| --- | --- | --- |
| `kind` | `github` | GitHub App webhook subscription |
| `agentId` | UUID of the worker agent | One hook per agent per repo (duplicate agent+repo returns 409) |
| `name` | e.g. `kanban-<slug>` | Operator-chosen label |
| `repoFullName` | `owner/repo` | Kanban board repo; must be under an org GitHub App installation |
| `events` | `["issues:labeled"]` | Matches `issues:labeled` (valid event pattern) |
| `labelFilter` | `["ac/agent:<slug>"]` | `<slug>` must match the label and the agent’s public slug/name convention |
| `mentionOnly` | `false` | Recommended for P0 — dispatch is label-driven, not @-mention summon |
| `enabled` | `true` | |
| Session mode | `perThread` (implicit) | Same issue continues one session; not configurable for `kind: github` |

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

- Matching is **intersection** with the issue’s **current** label names after the event is applied.
- For `issues:labeled`, GitHub delivers when a label is **added**. The added label is included in the issue’s label set for matching.
- Example: `labelFilter: ["ac/agent:worker-alpha"]` matches only if the issue currently has `ac/agent:worker-alpha` (among any other labels).
- Empty `labelFilter` means no label gate (not recommended for Kanban P0).

## Prerequisites

1. **Agent placed** on a connected daemon.
2. **GitHub App** installed on the org/account that owns `repoFullName`, with access to that repo.
3. **AgentRepoAuthorization** (or workspace repo alignment) so the agent may watch the repo — see [webhook-triggers-and-github-events.md](../../../docs/designs/webhook-triggers-and-github-events.md).
4. **Relay** registered and `PUBLIC_RELAY_URL` set (hook creation fails with 409 otherwise).
5. **Skill enabled** on the agent: skill source → this repo’s `skills/` tree → `kanban-label-protocol` (see [kanban-p0-pilot.md](../../../docs/designs/kanban-p0-pilot.md)).

## Dispatch flow (happy path)

```text
Human adds ac/agent:<slug> on issue
  → GitHub issues:labeled (senderType User)
  → Relay matches hook (event + labelFilter + installation)
  → Daemon opens/continues perThread session on that issue
  → Worker follows kanban-label-protocol skill
```

## Known gap (P0)

GitHub deliveries where `sender.type` is **Bot** are vetoed in relay GitHub ingress (except narrow App PR review paths). Therefore:

- Labels applied by the **GitHub App**, **github-actions**, or the **agent’s own bot identity** do **not** dispatch hooks.
- Workers **cannot** drive the board by editing labels in P0; humans (or non-bot users) must apply `ac/status:*` and assignee labels.
- There is **no** agent-driven dispatch, **no** concurrency caps, and **no** leases in P0 — only human label moves plus hook-fired sessions.

Reference implementation: `packages/relay/src/hooks/github-ingress.ts` (`senderType === 'Bot'` gate). This document does not change that behavior.
