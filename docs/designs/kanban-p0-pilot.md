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
event history that needs more than 10 page reads (newest page first), or a read
failure leaves the card parked. Agent
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
human doorbell for the card, an ingested move, or a new claim resets the backoff.
A graph doorbell does not reset it for a card whose promotion is still pending.
With 100 parked cards, the first hour is capped at 25 reads per tick, and steady
state is about one read per card per hour.

If the graph promotion's ready-label write fails, recovery decides what landed. The
reconciler first reads the issue's newest event id (the events cursor). If the
`Link: rel="last"` page is empty, it walks back to the newest non-empty page. A read
that finds no event within the page bound fails before anything is written, so the
cursor never falls back to 0. The reconciler then moves the card from `todo` to
`ready` and opens the intent in one conditional write: `promotionPending`,
`promotionEventCursor`, `promotionStartedAt`, and `promotionWatchUntil` (10 minutes
out). That write refuses a card that already has an open intent or carries
`needsAttention`. The reconciler skips both kinds of card before it reads anything,
so a redelivered graph event can neither reset an open intent's caps, cursor, and
start time nor promote a card that is waiting for a human. A claim
therefore never sees a `ready` card without its intent, even across a crash. A
claim skips any card with the intent set, so the leftover of a crash after the ready
POST is never dispatched. The next recovery check is a minute out, so a tick cannot
settle the card while the write is running. When the ready POST returns success the
CP sets `promotionPostAccepted`. A successful write clears the intent. A failed one
moves the card back to `todo`, keeps the intent, restarts the watch 10 minutes from
the rollback, makes the next check due at once, and fails the doorbell. The write may
still have half-landed, or a timed-out POST may still commit on GitHub after the
rollback. For example, the ready
label was added and GitHub applied the `todo` removal, but the DELETE timed out. The
next tick re-reads due flagged cards within the recovery batch limit. While the
intent is open, the reconciler does not strip a leftover `todo` label, because that
would finish the write before attribution.

- **Attribution.** GitHub's add-labels response is only the issue's label list,
  with no event id, so the CP cannot capture a receipt for its own write. The CP and
  agents also act as the same App bot. Recovery therefore reads only the events
  after the cursor: managed (`ac/*`) label adds and removals, plus close and reopen.
  It reads the `Link: rel="last"` page first and walks backward, so a long history
  still reaches the cursor. An App `labeled ac/status:ready` is adopted only when
  `promotionPostAccepted` is set and the App's events in that window are exactly that
  add, optionally followed by an `unlabeled ac/status:todo`. These are the events
  our own write produces. A timed-out or refused POST never adopts an App ready-add,
  even when it is the only one. A second App ready-add, any other App `ac/*` write,
  or a writer that is neither a human `User` nor this App rejects the promotion. If
  the latest ready-add in the window came from a human `User`, the promotion is
  adopted, because a human finished it.
- **Shape.** The issue must be open and carry `ready` alone or `todo`+`ready`
  residue. The dispatch's `running` write then clears both labels.
- **Graph readiness.** Every blocker must still be closed as completed.

If the issue carries no `ready` label (the POST did not land, or a human moved the
card), the outcome depends on whether the POST was acknowledged. With
`promotionPostAccepted` set, nothing more can land, so the intent clears and the card
stays `todo`. Without it, the card is in the rolled-back watch until
`promotionWatchUntil`. An empty read inside the watch only counts as a check, and the
first empty read after the watch clears the intent. A late POST that lands inside the
watch, or after it but before that closing read, shows up as an App ready-add with
no acknowledged POST, so the next read escalates the card as `unattributed`. It is
never cleared silently. Once the intent clears, a redelivered graph doorbell promotes
the card again. Every other failed check hands the card to a human. The CP moves
the card back to `todo`, clears the intent, sets `needsAttention` with an
`attentionReason`, logs a warning, and posts a fixed, body-free issue comment so the
board shows it. The reasons are:

- `unattributed`: the window does not prove the add is ours.
- `unexpected_labels`: `ready` sits next to another status.
- `blockers_reopened`: a blocker reopened.
- `unresolved`: the result stayed inconclusive.

A thrown read, a window that does not yet show any ready-add, a window deeper than
10 pages, or a truncated graph is inconclusive. The card keeps its intent and retries
on the recovery backoff. Each deferred check counts in `promotionChecks`. After 12
checks, or 6 hours after the intent opened, the card escalates as `unresolved`. A
non-human doorbell does not reset the backoff or read early. A human status doorbell
reads at once and still counts toward the cap. A `needsAttention` card is parked like
a mismatch, so it is human-only: tick recovery and the label doorbell un-park it only
when a human `User` makes the latest status edit. That edit is either a fresh add of
`ac/status:ready` (the comment asks the human to remove and re-add it, because an
unattributed `ready` is often still on the issue) or another single status. No
automatic path clears the flag. The graph reconciler skips flagged cards, and the
promotion write refuses them, so closed blockers plus todo-only labels do not
re-promote one. A stale graph CAS cannot either, because escalation bumps the state
revision. Any
later status change clears the intent and the flag. They therefore cannot authorize
a future promotion once the card returns to `todo`.

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

- **Bots can pin a mismatch-parked card's recovery backoff at the minimum.** Any
  change in the recovery fingerprint restarts the backoff at 1 minute, whoever made
  it. A graph doorbell for a card that is not waiting on a promotion also resets
  it, and those ring for bot senders too. A bot that keeps relabeling a parked
  card, or editing its dependencies, therefore keeps it on 1-minute re-reads.
  Reads stay bounded by the 25-cards-per-board-per-tick cap, and a bot still cannot
  un-park the card. A pending promotion is not in this gap: a graph doorbell leaves
  its backoff alone. Fixing the parked-card case needs an attributed (events API)
  read before each reset, which costs the read the backoff exists to save.
- **The issue events API can lag the webhook.** A doorbell re-reads the card at once,
  but if the events API does not yet show the human's label event, attribution fails
  and the card is not un-parked by that doorbell. It is picked up on the next tick
  instead, about 60 seconds later because the doorbell reset the backoff, not when the
  webhook arrived. Attribution that cannot see the event fails closed; the same lag
  can likewise defer a half-landed promotion's adoption to a later tick.
- **A half-landed promotion trusts the agents not to replay its exact write.** The CP
  and its agents share the App identity, and the label POST returns no event id. An
  agent that adds `ac/status:ready`, and optionally removes `ac/status:todo`, in the
  seconds between the cursor read and an accepted POST is therefore indistinguishable
  from the CP's own write. A POST with an existing label adds no event, so the agent's
  add then stands alone in the window. That case is adopted. The resulting labels are
  the ones the CP was writing anyway, for a card whose blockers are all complete, and
  any second App ready-add or other App `ac/*` write in the window escalates the card
  instead. Closing this would need a per-write identity GitHub does not expose, such
  as a separate App for the control plane.
- **The late-landing watch is finite.** A timed-out POST that commits on GitHub after
  the watch's closing read leaves GitHub on `ready` and the card on `todo` with
  nothing pending or flagged. The relay ignores App senders, and the reconciler does
  not promote over existing `ready` labels. The window is 10 minutes from the rollback,
  plus the wait for the next backoff step, against a 10-second request timeout.
- **Escalation comments are best-effort.** If the comment POST fails, the card still
  carries `needsAttention` and a warning is logged, but nothing shows on the issue.
  The console does not surface the flag yet.
- **`sender.type === 'User'` does not prove a human.** An App acting with a
  user-to-server token, or a worker using a personal access token, is also reported
  as `User`, so it can ring the card-status doorbell. That only causes reads: un-park
  still requires the events API to attribute the edit to a person.

Remaining M2 follow-ups: daemon-crash reclaims need a separate configurable retry
budget; superseding a local lease needs cancellation completion, reporting, and a
worktree recovery policy that preserves uncommitted work before another write run;
report receipts and abandoned reservations need retention rules that preserve
restart deduplication. These are outside the dispatch fixes above.
