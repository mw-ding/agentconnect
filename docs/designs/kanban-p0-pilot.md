# GitHub Kanban — Phase 0 (zero-code pilot)

**Status:** Pilot / P0  
**Scope:** Configuration + agent skill only. **Do not start M1** from this doc.

Parent tracking: [issue #2](https://github.com/mw-ding/agentconnect/issues/2) §9 Phase 0 — validate board UX and worker prompts using GitHub labels and existing GitHub hooks, before Kanban MCP tools and control-plane automation land in later milestones.

## What P0 is

- A **board repo** whose issues are cards; **humans** move cards by adding/removing labels.
- One **GitHub hook per worker agent**: `events=["issues:labeled"]`, `labelFilter=["ac/agent:<slug>"]`.
- A shared **skill** [`skills/kanban-label-protocol/SKILL.md`](../../skills/kanban-label-protocol/SKILL.md) teaches status/assignee labels and the **final-answer + human label** terminal protocol until `kanban*` MCP exists.

Execution path is the standard hook pipeline documented in [webhook-triggers-and-github-events.md](webhook-triggers-and-github-events.md) (relay ingress → daemon turn, per-issue session).

## Enable the skill source

1. In the Console, add a **public GitHub skill source** for this repository with subdirectory `skills/` (or select skill `kanban-label-protocol` only). See [shared-skills.md](shared-skills.md) §3.
2. Enable that skill on each **worker agent** that participates in the pilot.
3. Operators can also symlink or vendor-copy `skills/kanban-label-protocol` locally; the canonical pilot tree lives in this repo under [`skills/`](../../skills/README.md).

## Enable hooks (per worker)

Documented in [`skills/kanban-label-protocol/references/hook-config.md`](../../skills/kanban-label-protocol/references/hook-config.md):

- `kind: github`, `repoFullName` = board repo, `mentionOnly: false` recommended.
- Assignee label `ac/agent:<slug>` must match the hook filter and the agent slug used on cards.
- Board repo must sit under a GitHub App installation that covers it (**org or user account** — P0 accepts either).

## Avoiding the re-dispatch loop

`labelFilter` matches the issue’s **current** labels on **any** `issues:labeled` event. While `ac/agent:<slug>` stays on the card, adding `ac/status:running` / `review` / `blocked` / `done` starts another worker turn.

P0 control (no platform change):

1. Humans add `ac/agent:<slug>` **last** to dispatch, and **remove it before** terminal or parked status moves.
2. Workers **no-op** (no new `Kanban:` directive) when the card is already `done` / `archived` / `review` / `blocked` with no new human instruction.

## Terminal outcomes (P0)

On GitHub hook turns the **daemon** posts the worker’s final answer (workers must not `gh` comment). The final answer starts with `Kanban: complete` | `Kanban: request_review` | `Kanban: block kind=…`, and asks a human to remove the assignee label and set the matching `ac/status:*`. Mapping to future MCP: issue #2 §6.

## Authorization note

For `issues` events the relay checks the **issue author’s** live write/admin access, not the permission of the user who added the label. File smoke cards as a write-capable user.

## Known gap (document in pilot reports)

**Bot label events do not dispatch.** Relay GitHub ingress vetoes most `senderType === 'Bot'` deliveries (`packages/relay/src/hooks/github-ingress.ts`). Labels applied by the GitHub App, Actions, or the agent bot identity **do not** fire `issues:labeled` hooks.

Consequences for P0:

- No agent-driven dispatch or board moves via label writes.
- No concurrency caps or leases on cards.
- **One writer per effect:** humans (non-bot users) own `ac/status:*` and assignee labels; workers use the daemon-posted final answer only.
- Worker label edits via a **user** PAT still re-dispatch if the assignee label remains — forbid that in the pilot.

## Local validation

Manual smoke: [`skills/kanban-label-protocol/scripts/pilot-smoke.md`](../../skills/kanban-label-protocol/scripts/pilot-smoke.md) and optional [`pilot-smoke.sh`](../../skills/kanban-label-protocol/scripts/pilot-smoke.sh).

## Out of scope (P0)

- M1+ control-plane Kanban APIs, MCP `kanban*` tools, daemon lease/cap enforcement, and automated label writers.
- Changes to relay, daemon, CP, or protocol — pilot feedback should inform those milestones, not ship in P0.
