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

An organization owner sets mode through two control-plane routes:
`PUT /api/v1/orgs/:orgId/kanban/boards/:boardId/mode` with
`{ "mode": "read" | "write" }` sets the board default, and
`PUT /api/v1/orgs/:orgId/kanban/boards/:boardId/cards/:cardId/mode` with
`{ "mode": "read" | "write" | null }` sets or clears one card's override. Both accept
only an interactive OIDC session. Personal API keys, OAuth access tokens (including an
agent's `mcp:write` token), delegated agent invocations, daemon and relay keys, and
the no-auth devAuth stub are refused before the body is validated. Collaborators and
viewers are refused too, and a board or card outside the path organization reads as
`404`. The repository methods behind the routes, `PgKanbanBoardRepo.setDefaultMode`
and `setCardMode`, check owner membership again in the same write and take the
caller's user id only from that session. No daemon RPC or worker tool exposes them.
Clearing a card override restores the board default for the next claim. Configuration
edits do not upgrade an already active lease.

A closed or relabeled issue discovered after claiming ends the lease and changes
the database card in the same transaction: closed/completed becomes `done`,
closed/not-planned becomes `archived`, one valid status is adopted, and conflicting,
malformed, missing, or unavailable issue state becomes `triage`. No GitHub label,
state, or comment writes occur. One exception keeps the M1 promotion contract: an
open issue whose only status labels are `todo` and `ready` is unfinished promotion
residue, so the claim dispatches it and the `running` write clears both labels.

A later legal human status edit on a mismatch-parked card is ingested by a Kanban
doorbell or periodic mismatch recovery, then a `ready` card is claimed as a fresh
attempt. Recovery accepts an edit only when the issue is open, carries exactly one
valid status label, and the issue events show a GitHub `User` (not a `[bot]`
login and without `performed_via_github_app`) both added that label and made the
latest `ac/status:*` change. Any App, bot, or unknown actor, a missing event, an
event history beyond 10 pages, or a read failure leaves the card parked. Agent
label writes reach GitHub as the App bot because the `gh` shim fails closed, so an
agent can never un-park a card. A legal-looking edit the state machine forbids,
such as `archived` straight to `ready`, is logged rather than silently dropped;
the human must move it to `triage` first.

When a GitHub `User` adds or removes an `ac/status:*` label, or closes or reopens the
issue, the relay rings a body-free Kanban doorbell (`rc/github-graph` with event
`issues`, carrying only the issue id and number). Hook matching for that delivery
still runs. App and bot senders never ring it. On that doorbell, and on any
`sub_issues` or `issue_dependencies` doorbell naming the card, the control plane
resets the card's recovery backoff, re-reads that one issue, and pokes the board's
claim. A parked card that a human re-readies is therefore claimed when the webhook
arrives, subject to the usual claim gates (caps, cooldown, a live daemon), not after
its backoff. If the events API lags, it is claimed on the next tick (see Known gaps).

Every other `issues` labeled, unlabeled, closed, or reopened delivery (another label,
or an App or bot sender) is forwarded as a seen-only marker with no issue numbers. The
CP re-reads nothing for a marker; it only records that the delivery landed. The hook
redelivery sweep therefore treats those four `issues` actions on a board-watched repo
like the graph events. When a delivery's doorbell never landed (the relay pool was
unreachable, or the CP's read failed), the sweep asks GitHub to redeliver it. The
sweep runs every 10 minutes, needs a live relay, and asks at most three times per
delivery. A redelivered delivery also re-runs hook matching, which is idempotent on
its GUID. Until then, a non-terminal parked card still gets its next due tick, at most
the backoff ceiling below. A `done` or `archived` card is not in the tick scan, so it
depends on the redelivered webhook.

The backlog scan runs only on the 60-second tick; a report or claim poke never reads
GitHub, and a doorbell reads only the card it names. Each pass reads at most 25 due
cards per board. It excludes `ready`, `running`, `done`, and `archived` cards, so
closed issues never stay in the scan. A check that changes nothing pushes
`KanbanCard.recoveryCheckAt` out by 1, 2, 4, and so on up to 60 minutes
(`recoveryChecks` counts the steps). Each check stores a fingerprint of the issue
state and status labels it read (`recoveryObserved`). A check that sees a different
fingerprint restarts the backoff at 1 minute, even when no webhook arrived. A
doorbell for the card, an ingested move, or a new claim resets the backoff entirely.
With 100 parked cards, the first hour is capped at 25 reads per tick, and steady
state is about one read per card per hour.

If the graph promotion's ready-label write fails after the `todo`→`ready` CAS, the
reconciler compare-and-sets the card back to `todo`, flags it `promotionPending`, and
fails the doorbell. A claim therefore cannot mismatch the card into a stranded
`todo`. The write may still have half-landed. For example, the ready label was added
and GitHub applied the `todo` removal, but the DELETE timed out. The next tick
re-reads every flagged `todo` card. A lone `ready` label, or `todo`+`ready` residue,
is adopted as `ready` and claimed only when two further checks pass, and the
dispatch's `running` write then clears both labels.

- **Attribution.** The issue events must show that this deployment's App bot
  (`<slug>[bot]`) or a GitHub `User` added the `ready` label. The CP and its agents
  share that App identity, so the check also replays the `ac/status:*` and
  close/reopen events. The last human change must have left the issue open with
  only `todo` and/or `ready`. A human park (any other status, or closing the issue)
  therefore stands until a human undoes it, even if an agent later swaps in `ready`.
  Any other bot or App touching status, a history beyond 10 pages, or a read
  failure refuses adoption.
- **Graph readiness.** Every blocker must still be closed as completed.

Anything else clears the flag and leaves the card `todo`: nothing landed, the label is
not attributable, a blocker reopened, or a human moved the card elsewhere.
Any Kanban doorbell for the card (a human status relabel or a graph change) settles
the flag at once with the same checks and clears it even if the read fails, so a
human park observed by a webhook leaves nothing for a later bot write to adopt. The
graph reconciler never adopts a lone `ready` itself; a redelivered graph doorbell
reaches the same attributed repair. Any later status change also clears a stale
flag, so it can never promote a card that comes back to `todo`.

Agent `gh` shims fail closed on inherited GitHub tokens, missing `AC_AGENT_ID`, or an
unsuccessful/empty daemon token response. They never use stored human gh
authentication. The shim sets only `GH_TOKEN` (never `GH_ENTERPRISE_TOKEN`), and it
refuses a `GH_HOST` other than `github.com`, so the github.com installation token
cannot be sent to another host. It also refuses any real `--hostname` flag (or
`auth`'s `-h`) naming another host. To find those flags, it parses argv the way gh
does. Flags that take a value (`-f`/`--raw-field`, `-F`/`--field`, `-H`/`--header`,
`--input`, `-q`/`--jq`, `-t`/`--template`, and so on) consume it, shorthand groups and
`--` are honored, and a flag placed before the command name still counts. Text inside
another flag's value, such as `--raw-field '--hostname=github.com'`, is never read as
a host. Every real host flag must name `github.com`; the last one does not simply win.
The shim sees only the literal argv, so a user-defined gh alias or extension is not
inspected. Runtime spawn strips GitHub token/PAT environment variables and
`GH_CONFIG_DIR` after all environment sources are merged. This does not prevent an
unsandboxed worker from invoking a real binary or reading `~/.config/gh/hosts.yml`
directly. Database-only mode authority and human-only recovery stay independent of
that residual host access.

A fenced heartbeat implicitly acknowledges an accepted dispatch and keeps the
lease alive even when the original ACK write failed. Lease timestamps use the
database clock; daemon reports and ACKs are fenced against the current daemon epoch.

For local integration verification, set `TEST_DATABASE_URL` to a dedicated
PostgreSQL 17 database and run `pnpm --filter @agentconnect.md/control-plane test:int`.
The harness applies committed migrations, seeds the template database, creates a
private clone per worker, and drops those clones at teardown. The connecting role
needs permission to create databases. Without this variable it uses Testcontainers.

Known gaps: write mode is set only through the owner API routes above. The console
has no control for it yet, and a no-auth (devAuth) deployment cannot set it at all,
because no request there proves an interactive human. Every run in such a deployment
stays read-only. A human who wants an archived card dispatched must relabel it
`triage` and then `ready`; there is no issue comment explaining the refused move,
only a CP log line.

- **Bots can pin a card's recovery backoff at the minimum.** Any change in the
  recovery fingerprint restarts the backoff at 1 minute, whoever made it. Every
  `sub_issues` or `issue_dependencies` doorbell also resets it, and those ring for
  bot senders too. A bot that keeps relabeling a parked card, or editing its
  dependencies, therefore keeps it on 1-minute re-reads. Reads stay bounded by the
  25-cards-per-board-per-tick cap, and a bot still cannot un-park the card. Fixing
  this needs an attributed (events API) read before each reset, which costs the read
  the backoff exists to save.
- **The issue events API can lag the webhook.** A doorbell re-reads the card at once,
  but if the events API does not yet show the human's label event, attribution fails
  and the card is not un-parked by that doorbell. It is picked up on the next tick
  instead, about 60 seconds later because the doorbell reset the backoff, not when the
  webhook arrived. Attribution that cannot see the event fails closed; the same lag
  can likewise defer a half-landed promotion's adoption to a later tick.
- **`sender.type === 'User'` does not prove a human.** An App acting with a
  user-to-server token, or a worker using a personal access token, is also reported
  as `User`, so it can ring the card-status doorbell. That only causes reads: un-park
  still requires the events API to attribute the edit to a person.

Remaining M2 follow-ups: daemon-crash reclaims need a separate configurable retry
budget; superseding a local lease needs cancellation completion, reporting, and a
worktree recovery policy that preserves uncommitted work before another write run;
report receipts and abandoned reservations need retention rules that preserve
restart deduplication. These are outside the dispatch fixes above.
