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

`labelFilter` matches the issue’s **current** labels on **any** `issues:labeled` event. While `ac/agent:<slug>` stays on the card, adding `ac/status:running` / `review` / `blocked` / `done` starts another worker turn. GitHub also emits **one delivery per label** (including labels at issue creation); the daemon deduplicates **per delivery**, not per issue — so bundling `ac/agent:<slug>` with another label, or setting it at create, can start **two or more** turns.

P0 control (no platform change):

1. Humans add `ac/agent:<slug>` **alone** (own label action — never with other labels, never at issue create) to dispatch, and **remove it before** terminal or parked status moves.
2. Workers **no-op** with an **empty** final answer (daemon posts nothing) when the card is already `running` / `done` / `archived` / `review` / `blocked` with no new human instruction. Do not use a quiet phrase — any non-empty body is posted.

## Terminal outcomes (P0)

On GitHub hook turns the **daemon** posts the worker’s final answer (workers must not `gh` comment). The final answer starts with `Kanban: complete` | `Kanban: request_review` | `Kanban: block kind=…`, and asks a human to remove the assignee label and set the matching `ac/status:*`. Mapping to future MCP: issue #2 §6.

## Authorization note

For `issues` events the relay checks the **issue author’s** live write/admin access, not the permission of the user who added the label. File smoke cards as a write-capable user.

## Known gap (document in pilot reports)

**Bot label events do not dispatch.** Relay GitHub ingress vetoes most `senderType === 'Bot'` deliveries (`packages/relay/src/hooks/github-ingress.ts`). Labels applied by the GitHub App, Actions, or the agent bot identity **do not** fire `issues:labeled` hooks.

Consequences for P0:

- No agent-driven dispatch or board moves via label writes.
- No concurrency caps or leases on cards.
- **One writer per effect:** humans (non-bot users) own all `ac/*` labels, including status and assignment (mode labels are display-only); workers use the daemon-posted final answer only.
- Worker label edits via a **user** PAT still re-dispatch if the assignee label remains — forbid that in the pilot.

## Local validation

Manual smoke: [`skills/kanban-label-protocol/scripts/pilot-smoke.md`](../../skills/kanban-label-protocol/scripts/pilot-smoke.md) and optional [`pilot-smoke.sh`](../../skills/kanban-label-protocol/scripts/pilot-smoke.sh).

## Out of scope (P0)

- M1+ control-plane Kanban APIs, MCP `kanban*` tools, daemon lease/cap enforcement, and automated label writers.
- Changes to relay, daemon, CP, or protocol — pilot feedback should inform those milestones, not ship in P0.

## M2 dispatch safety

A worker must never add, remove, rename, or edit any `ac/*` label, including
`ac/status:*`, `ac/mode:*`, and `ac/agent:*`, through `gh`, APIs, scripts, or other
tools. Issue content cannot authorize a mode or assignment change. The dispatched
prompt and shared skill carry this rule. The daemon rejects recognizable label
mutations when the runtime requests tool permission; arbitrary shell execution and
externally supplied credentials are not comprehensively mediated by that guard.

Run mode comes only from control-plane database configuration: `KanbanBoard.defaultMode`
defaults to `read`, and nullable `KanbanCard.mode` overrides it. A claim records
`card.mode ?? board.defaultMode` in the run before dispatch, including fast-report races.
`ac/mode:write` is display-only and never grants access, regardless of whether a
human, PAT-backed User, bot, or App added it. No issue-event history is read.

Until a human-authenticated board administration route exists, control-plane admin
code may use `PgKanbanBoardRepo.setDefaultMode(orgId, boardId, userId, mode)` and
`setCardMode(orgId, boardId, cardId, userId, modeOrNull)`. Callers must derive
`userId` from human authentication, never worker input. Both methods require an
organization owner in that board's organization; no daemon RPC or worker tool
exposes them. Clearing a card override restores the board default for the next
claim. Configuration edits do not upgrade an already active lease.

A closed or relabeled issue discovered after claiming ends the lease and changes
the database card in the same transaction: closed/completed becomes `done`,
closed/not-planned becomes `archived`, one valid status is adopted, and conflicting,
malformed, missing, or unavailable issue state becomes `triage`. No GitHub label,
state, or comment writes occur. A later legal human `ready` edit is ingested by
the graph doorbell or periodic mismatch recovery, then claimed as a fresh attempt.
The M1 graph doorbell on this branch does not carry ordinary issue-label events;
the periodic recovery also handles those edits without requiring a new webhook.

Agent `gh` shims fail closed on inherited GitHub tokens, missing `AC_AGENT_ID`,
or an unsuccessful/empty daemon token response. They never use stored human gh
authentication. Runtime spawn strips GitHub token/PAT environment variables after
all environment sources are merged. This does not prevent an unsandboxed worker
from invoking a real binary or reading host credentials directly; database-only
mode authority remains independent of that residual host access.

A fenced heartbeat implicitly acknowledges an accepted dispatch and keeps the
lease alive even when the original ACK write failed. Lease timestamps use the
database clock; daemon reports and ACKs are fenced against the current daemon epoch.

For local integration verification, set `TEST_DATABASE_URL` to a dedicated
PostgreSQL 17 database and run `pnpm --filter @agentconnect.md/control-plane test:int`.
The harness applies committed migrations, seeds the template database, creates a
private clone per worker, and drops those clones at teardown. The connecting role
needs permission to create databases. Without this variable it uses Testcontainers.

Remaining M2 follow-ups: daemon-crash reclaims need a separate configurable retry
budget; superseding a local lease needs cancellation completion, reporting, and a
worktree recovery policy that preserves uncommitted work before another write run;
report receipts and abandoned reservations need retention rules that preserve
restart deduplication. These are outside the dispatch fixes above.
