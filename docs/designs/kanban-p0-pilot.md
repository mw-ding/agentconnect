# GitHub Kanban — Phase 0 (zero-code pilot)

**Status:** Pilot / P0  
**Scope:** Configuration + agent skill only. **Do not start M1** from this doc.

Parent tracking: [issue #2](https://github.com/mw-ding/agentconnect/issues/2) §9 Phase 0 — validate board UX and worker prompts using GitHub labels and existing GitHub hooks, before Kanban MCP tools and control-plane automation land in later milestones.

Consolidated as-built design: [kanban-swarm.md](kanban-swarm.md) (this pilot doc stays the history).

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
  plus the wait for the next backoff step, against a 10-second request timeout, so a
  POST landing more than 10–15 minutes late leaves `todo` and `ready` both on GitHub
  while the DB stays `todo`, unflagged. A future periodic scan of unparked `todo`
  cards for an App-added `ready` would close it; that scan is an optional follow-up.
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

## M3 — Worker protocol and card tools

A dispatched turn that ends without a terminal tool call gets exactly one short
nudge in the same session and lease. The daemon waits for live background work to
finish first and keeps heartbeating while the nudge turn runs. The nudge asks for
exactly one of `kanbanComplete`, `kanbanRequestReview`, `kanbanBlock`, or `kanbanFail`.
A terminal from that turn keeps its own outcome and reason. Ignoring the nudge
reports `protocol_violation/no_terminal_call_after_nudge`; a refused or unstartable
nudge reports `protocol_violation/nudge_unavailable`. Protocol violations consume
the existing `protocolRetryLimit` budget. Errored, interrupted, superseded, and
stopping turns do not get a nudge. Admission still checks paused/draining state.

ACP errors retain their structured JSON-RPC code, message, data, and cause for a
pure daemon-side classifier. Rate limits (429), network errors, overload (529),
and server errors (5xx) report `transient` with a fixed `provider_*` reason code.
Authentication (401/403), invalid requests (400/invalid params), and context
overflow report counted `failed` outcomes. After those provider checks, only a
daemon-created ACP transport error (a prompt rejected by the local connection
closing or resetting, including agent process exit) reports `failed/agent_crashed`.
Free-text process/tool exit messages cannot establish a crash; provider-side EPIPE
remains `transient/provider_network`. Unknown errors keep `failed/turn_error`.
Neither initial-turn nor nudge-turn errors trigger another nudge. Error text stays
on the daemon; only the reason code reaches the control plane.

Consecutive provider transients derive their backoff from prior ended runs,
without a schema change: 1, 2, 4, 8, 16, 32, then 60 minutes. The eighth consecutive
provider transient moves the card to `triage`. These retries preserve failure and
protocol counters. Transient `nudge_deferred` and `dispatch_refused:*` runs are
skipped without counting or resetting the provider sequence; any other outcome
resets it. Non-provider transients retain their fixed one-minute cooldown.

`kanbanShow()` and `kanbanComment({text})` resolve the worker's own card from the
trusted session context. Neither accepts a card, agent, or lease argument, and
both refuse after a terminal has been recorded or the lease has ended.
`kanbanShow` obtains body-free metadata and at most 10 prior runs through the
strict `kanban/card` RPC, fenced by the authenticated daemon/epoch, agent placement,
open lease, card/board ids, and dispatch revision. The daemon reads the issue's
title, body, labels, links, sub-issues, dependencies, and last 10 comments directly
from GitHub. Each field is capped before normalization. The daemon normalizes a
copy for detection only — combining-mark runs are capped at 30 before NFKC/NFKD,
default-ignorable characters and Hangul fillers are stripped, and small capitals are
folded to ASCII — then slides `beginuntrustedexternalcontent` and
`enduntrustedexternalcontent` across the concatenated line skeletons, so a marker
split across any number of lines (or an empty `-----` line inside it) is removed in
linear time. The returned lines are the originals, so honest text is never re-shaped,
and a bare mention of the phrase without a begin/end marker survives. The assembled
block is hard-capped before the fences are added. Each call wraps the result in fresh
nonce-bearing untrusted-content fences; only the END line with that exact nonce closes
the block. An unavailable lease check fails the tool call.

`kanbanComment` posts up to 4,000 characters per note, with at most 10 successful
or in-flight notes per lease. A failed post releases its slot. It works in read
mode too, like the final summary. Each read or progress post requests a fresh
lease check through the daemon-owned issues token path, without falling back to a
cached token on refusal or outage. The grant stays out of the agent environment.
Progress markers use `ac-kanban-note:`; the final summary's `ac-kanban-lease:`
lookup ignores them. The final summary retains its existing exactly-once outbox
behavior. Workers still cannot mutate any `ac/*` label.

## M3 — App installation tokens and webhook delivery

Operator steps (create, install, secrets, verify): [runbooks/kanban-github-app.md](../runbooks/kanban-github-app.md).

App mode is on only when `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_B64`, and
`GITHUB_APP_SLUG` are all set (a partial set, or a blank slug, fails boot; the slug is how the bot recognises its own comments, so refusal comments need it). `GITHUB_APP_CLIENT_ID`,
when set, is the App JWT issuer. Install that App on the board repository
(`mw-ding/agentconnect` for this pilot) and grant:

- Issues: read and write
- Contents: read and write
- Pull requests: read and write
- Metadata: read

While a run is open, the daemon's git credential for that repository is an
installation token scoped with `repository_ids` to the board. Read mode is
`contents`, `issues`, and `pull_requests` at read (plus `metadata: read`), so the
token itself cannot write. Write mode is those three at write; `workflows: write`
follows contents write. Card reads use `issues: read`. Label writes and the
daemon-owned final poster use `issues: write` and never enter the agent
environment. If the App is not configured, the card store and poster keep the
injected PAT (`kanbanAccessToken`) and log that they are doing so. That option
is dev/test only; a production board uses the App installation token.

Webhook delivery: point the App's webhook at the relay's `POST /webhooks/github`.
The relay checks `X-Hub-Signature-256` with `GITHUB_APP_WEBHOOK_SECRET`, replaced
outright by the control plane's deployment secret `github.webhookSecret` once a
snapshot arrives. Subscribe to `issues`, `issue_comment`, `label`, and, when the
App can, `sub_issues` and `issue_dependencies` (both ride the Issues permission).
Status moves arrive as `issues` actions `labeled`, `unlabeled`, `closed`, and
`reopened`. A verified delivery becomes a body-free Kanban doorbell on the
relay-to-control-plane WebSocket; a bad signature is 401 and puts nothing on the
wire.

Known gap: the control plane's installation-token cache for a Kanban run is
keyed by installation, repository, and permission levels, not by lease. A grant
minted for one run can be reused for a later run of the same mode on that
repository until it is within 15 minutes of expiry. The daemon cache is keyed
by the open lease and mode, so a read run does not reuse a write grant; this
control-plane cache is not.

M3 hardening (daemon and relay):

- **Agent environment.** The daemon launches every agent from an explicit allowlist
  (`agentBaseEnvironment` in `runtimes/agent-env.ts`): process basics, locale, temp
  dirs, XDG roots, proxy and CA settings, toolchain homes, provider keys, and the
  `LC_`, `ANTHROPIC_`, `OPENAI_`, `CLAUDE_`, `CODEX_`, `GEMINI_`, and `DEEPSEEK_`
  families. Runtime env, per-agent env, and injected `AC_*` variables are added
  explicitly. Non-allowlisted variables such as `DATABASE_URL`, `PGPASSWORD`,
  `DB_PASSWORD`, `AWS_*`, App key material, and the relay token are dropped. Names
  inside the allowlisted prefix families (an `OPENAI_DB_PASSWORD`, say) and provider
  credential keys such as `OPENCLAW_GATEWAY_PASSWORD` still pass. The e2e harness uses
  the same shape (`test/kanban-agent-env.ts`), and unit tests plant a sentinel for each
  dropped secret.
- **Webhook dedupe.** The relay claims an `X-GitHub-Delivery` id in flight and marks
  it seen only after the reply is out and no CP doorbell was dropped. A dropped
  forward or a 5xx forgets the id, so GitHub's redelivery is processed. A copy that
  arrives while the first is in flight gets a retryable 503, not a silent 202. A
  caller that hangs up during the PR-feedback write never claims the id, and a claim
  left unsettled for 5 minutes counts as abandoned, so no GUID stays wedged.
- **Dedupe versus CP redelivery.** The CP redelivers through GitHub's API, which keeps
  the GUID and cannot carry a header. The relay therefore forgets an id when it
  reports a failure the CP redelivers for (`daemon_offline`, `rejected:draining`,
  `rejected:not_holder`, `review_request_required`), so the redelivery is not
  answered as a duplicate inside the 10-minute TTL. Other hooks of the same delivery
  that already ran are deduplicated at the CP on `(hookId, deliveryKey)`.
- **Comment outbox schema.** `kanban_terminals` columns added after its first shape
  come from the versioned local-store migration (v59), not only
  `CREATE TABLE IF NOT EXISTS`. v60 clears any `attemptedAt` written from local time.
- **Clock skew.** The marker lookup's `since` bound is GitHub's `Date` header, read
  by a GET just before the first POST. It is never this daemon's clock. When that
  header is unreadable, the retry scans every comment page with no bound and, past
  the page limit, parks the row instead of posting a duplicate.
- **UTC session pin.** `withUtcSession` edits the connection URL's `options` as text,
  so empty-host libpq URLs (`postgresql:///db?host=/var/run/postgresql`) are pinned
  too. A value that is not a `postgres://` URL throws instead of passing through
  unpinned. `prisma/seed.ts` opens its client through `createPrisma`.

Known gaps (M3):

- **Failed outbox rows are never cleaned up.** A comment that exhausts its undecided
  marker lookups moves to state `failed` and stays in the daemon's SQLite store. The
  only signal is the error log line; nothing alerts and nothing retires the row.
- **An unbounded marker scan is capped.** With no readable GitHub clock, an issue
  with more than five pages (500) of comments parks the row for a human, rather than
  finding a marker beyond that.
- **The agent allowlist drops ambient variables it does not know.** A host variable an
  agent needs (for example `SSH_AUTH_SOCK` or a cloud-provider key) must be set in the
  runtime or agent env; it is no longer inherited from the daemon.
- **The pre-POST clock read is best-effort.** If that GET fails the POST still goes
  out, and a lost response is then recovered by the unbounded scan above.

Known gaps (M3 worker additions):

- **A daemon restart does not resume a nudge.** Its spent flag and lease are in
  memory. The durable lease reservation prevents the restarted daemon from
  executing the same dispatch again; the existing orphan/reaper path applies.
- **Progress notes are not durable or exactly-once.** A POST that GitHub accepts
  before the response is lost may appear even though the tool reports failure.
  Retrying can duplicate that progress note. This does not affect the separate
  terminal summary marker. The per-lease cap bounds acknowledged and in-flight
  notes, rather than ambiguous writes GitHub accepted without acknowledgement.
- **Dispatch and worker E2Es have different token coverage.** The dispatch E2E
  (`kanban-dispatch.e2e.test.ts`) runs App-only when `GITHUB_APP_ID`,
  `GITHUB_APP_PRIVATE_KEY_B64`, `GITHUB_APP_SLUG`, and `GITHUB_APP_WEBHOOK_SECRET`
  are complete: card/comment tokens are installation tokens, and a mint failure
  fails the run. The installation id comes from a real App delivery via
  smee → relay. `KANBAN_E2E_SMEE_URL` selects the App's smee channel;
  `KANBAN_E2E_REQUIRE_APP=1` requires doorbell, token, and comment modes to be
  `real`. With all four App vars unset, PAT/dev mode remains labeled `injected`.
  See the [GitHub App runbook](../runbooks/kanban-github-app.md). The worker M3
  E2E (`kanban-worker-m3.e2e.test.ts`) still uses an injected PAT and fake ACP
  agent, exercising real GitHub issues, Postgres, daemon admission, nudge turns,
  the MCP control socket, and fenced card reads. It does not validate a real App
  installation or a provider's live ACP error format.
- **Provider-outage triage is quiet.** When run-accounting trips
  `transient_limit` (a provider outage routed to `ac/status:triage`), the only
  signal beyond the label is a warn log line — the card's `needsAttention` flag
  is not set and no body-free issue comment is posted, matching `failure_limit`.
  Surfacing the outage for humans is a follow-up.
- **Classifier status precedence.** A nested `data.status`/`cause` code beats the
  top-level code (`{code:529, data:{status:400}}` → `provider_invalid_request`),
  and 400 is checked before the overload/rate-limit text, so a message that
  carries both a 400 and "rate limit exceeded" reads fatal. Both are the
  conservative direction (counted, bounded by `failureLimit`), but using the
  top-level code first is a follow-up.
- **Progress-note lease id is public before the summary.** `kanbanComment`
  publishes `ac-kanban-note:<leaseId>:<n>`, so the lease id is on the issue
  before the final summary. Anyone (or the agent via `kanbanShow` comment
  bodies) could post `ac-kanban-lease:<leaseId>` and spoof the final-comment
  marker, which matches any author; that only matters after a failed or
  ambiguous final POST inside the lookup window. Stripping `ac-kanban-lease:`
  from note/summary text, or a non-reversible note marker, is a follow-up.

- **Homoglyph confusables remain an accepted gap.** Cyrillic and other look-alike
  letters require confusables tables; the entire GitHub block remains untrusted.
- **A line that quotes a begin/end marker is over-redacted.** Detection removes every
  line whose letters touch `beginuntrustedexternalcontent` or `enduntrustedexternalcontent`,
  so legitimate prose that reproduces the fence delimiters — an issue discussing the fence
  itself, or a sentence wrapped as `…untrusted` / `external content…` — loses the whole
  line, and a single-line comment can vanish entirely. The nonce END line remains the real
  boundary, so this is safe but more aggressive than strictly necessary.

## M1 — Board configuration and issue import

Interactive organization owners manage boards with `POST`, `PATCH`, and `DELETE`
under `/api/v1/orgs/:orgId/kanban/boards`; members list and read only boards
permitted by the shared resource visibility policy. Restricted boards require a
current member audience, with the organization Owner exception. Each create or
update rechecks repository identity through a live installation belonging to the
organization. Board configuration changes produce body-free audit events.

An enabled board imports issues on human `opened`, `transferred`, or `labeled`
doorbells when a live issue read carries any `ac/status:*` label. Other labels
alone do not import. A single valid status is retained for a write-capable author;
missing, malformed, conflicting, or `running` initial status becomes `triage`.
The author's live GitHub repository role must be `admin`, `maintain`, or `write`;
unknown permission and other roles always become `triage`. The same live check
applies to whoever added the current status label (its latest `labeled` issue
event) and to the latest transferrer: each must be a human, not the App identity
its agents share, with write access, or the card imports as `triage`. The upsert
itself refuses any status past `triage`/`todo` without that verified human
authority, and never takes a mode. The safety label write
precedes the idempotent card upsert, so a failed write cannot leave a ready card.
One `ac/agent:<slug>` resolves to an unrestricted agent name within the board's
organization, and only when the status was kept and a human writer added every
current `ac/agent:*` label; otherwise, or for unknown, conflicting, or malformed
assignment labels, the card stays unassigned.
The `(boardId, issue)` and B1 idempotency-key constraints serialize concurrent
imports and orchestrator creates without duplicate cards or creation audits.

Known gaps (M1 import): a missed opened/transferred webhook is recovered by GitHub
redelivery, not by an installation-wide issue enumeration. The live tests use a
PAT as the injected installation-token source; production uses the App token.

Known gaps update (M1 board CRUD): board writes now use the shared membership
locks and member-removal audience repair. A repository rename keeps its numeric
identity; changing that identity is refused while the board has cards, so old
issue numbers cannot silently refer to another repository. Human status and
assignment synchronization beyond mismatch-parked cards and periodic drift repair
remain for the stacked M1 follow-up.

## M4 — Human controls (B5 pause/resume, skip, restart) and the synthesizer (B3)

Interactive organization owners pause and resume a board with
`POST /api/v1/orgs/:orgId/kanban/boards/:boardId/pause` and `.../resume`, and
skip or restart a card with
`POST /api/v1/orgs/:orgId/kanban/boards/:boardId/cards/:cardId/skip` and
`.../restart`, all owner + interactive-OIDC gated like the run-mode setters.
A paused board claims nothing (`AND NOT "paused"` beside `"enabled"` in the
claim), but its reaper, reports, heartbeats, label sync, graph promotion and
doorbells keep running, and open leases finish normally; resume re-arms the
dispatcher. Skip archives the card (closing the issue `not_planned`), revokes any
open lease with a dispatch-revision bump so a late report fails the fence, and
posts one body-free comment; dependents of a skipped card do not auto-promote.
Restart moves a card from triage/blocked/review/done/archived/ready/running back
to `ready`; a `todo` card is refused, so a restart never lifts a card past its
open blockers or a pending synthesis — resetting the failure counters, block recurrence, cooldown, block
kind and the attention flag — revokes any open lease, reopens a closed issue,
writes the status label and one comment, then re-arms the dispatcher.

Skip/restart CAS a per-card control version in their move transaction. Queued
GitHub writes drop superseded versions. SQL, pure and explain claims exclude
pending label/control writes. A failed acknowledged restart remains ready and
unclaimable until the existing label sync reopens the issue and writes ready;
skip repair closes and archives. Every control write and repair uses the same
`control:<cardId>:<controlVersion>` comment key, with the control's commit time as
the marker search cutoff. Stored kind, actor login and commit time let repair
reconstruct the body-free comment; repeated repair and lost write responses do
not duplicate it (#598). Controls committed before that additive migration lack
these facts, so their repair still writes status alone. A deleted or transferred
issue never takes the write, so its card stays unclaimable until a human resolves it; the claim explanation says so. Sync and dispatch projections share the
in-process status queue. Multiple CP processes still lack a shared write queue.
Skip clears promotion intent. Without a GitHub card store, pause/resume work
and skip/restart answer `404 kanban controls unavailable`.

Restart starts a new work episode and validates a linked PR with the read-only
reader (same repository, open, unmerged, exact card head). Any failure drops it.
A validated number travels in trusted dispatch data; comment text never
authorizes closing a PR. The CP's PR token stays read-only. Write-run token scope
tightening is a separate follow-up. An older PR reported again is refused by
the episode binding with `pr_unbound`. The close target is spent once a work run
reports `completed` or `review_requested`, or binds a PR; a failed run's retry
keeps it, and a reopen from `done`/`archived` clears it with the episode.

Recovered gap (#590, completed by #598): restart keeps `ac/card-<n>`. Before
sending a later write-mode work claim with no linked PR or stored close target,
the dispatcher looks up open PRs by that head branch with the read-only PR token.
It names a single same-repository, open, unmerged PR created before this work
episode for closing, even if restart's read failed or the revoked run never
reported it. A PR from the current episode stays eligible to bind and is never
named. Lookup failure ends the claim as a non-counting transient for retry; the
lease is checked again before dispatch. This adds one bounded list request on
such claims and no PR-number migration. An absent reader or ambiguous matches
still require human recovery. Episode binding and completion fences remain in
force. Within the CP process that ended a run, its contract re-check now holds the
card's claim from before the run end's commit until the re-check settles, for at most
5 minutes. A verify or rework claim there cannot start while the re-check is pending,
so a `pr_unbound` flag it raises lands first (#600/#601, fixed by #602). Another
replica, a restart before the re-check settles, or a re-check that outlives the
5-minute hold can still race it and fail closed; see
[kanban-lane3-api.md](kanban-lane3-api.md) for the bounds.

Version skew (#590): `supersededPrNumber` is an optional `kanban/dispatch` field.
A daemon older than #416 reads CP frames tolerantly (`decodeCpEnvelope` strips
unknown keys), so it accepts such a dispatch, silently drops the field, and runs
without the close instruction. Nothing fails: the superseded PR stays open, and
once that run reports `completed` or `review_requested`, or binds a PR, the CP
spends the close target, so no later dispatch closes it either. Upgrade every
daemon before restarting a card whose linked PR is still open.

Known gaps (M4 controls): a half-landed synthesis promotion is not adopted by
the attributed pending-promotion recovery (the graph reconciler's adoption rule
still only reads `blockedBy`), so it escalates to a human like any other
unattributed promotion. The skip comment names the actor's GitHub login only when
a linked `github_repo_identity` row exists; otherwise it omits the login. Board
pause/resume and card skip/restart leave body-free audit rows (`board_paused`,
`board_resumed`, `card_skipped`, `card_restarted`). The claim predicate now
reports `board_paused` immediately after `board_disabled` (Lane 3 API v1.5).

M4 controls continuation: synthesis re-evaluates the parent on an `issues.closed`
or `issues.reopened` doorbell, assigns the configured organization agent, and
writes `ac/agent:<slug>` beside `ac/status:ready`. Skip, restart and synthesis
status moves enqueue body-free notifications in the same PostgreSQL transaction;
headless boards stay silent. An existing worktree holding `ac/card-<n>` is
preserved and a competing session is refused. A removed worktree registration can
be pruned and its committed card branch resumed. The daemon cannot prove that an
existing session directory is inactive, so the operator must retire it before
another session can acquire its branch. A session with no local `ac/card-<n>`
(a fresh session clone, or a worktree on another daemon) first checks whether
`origin` has the branch. If it does, the session fetches it and starts from it.
This applies to the cold preparation of a session pod too. Otherwise the session
creates the branch from the default branch. A fresh card checkout preserves an existing local card branch. An existing
read-mode checkout safely switches to the requested card branch: it fetches
origin's branch when present, otherwise starts from the default branch. The switch
sets no upstream and writes no per-card fetch refspec (the worktree tier's config
is the root's, shared by every worktree), and checks local-only commits with
`rev-list --count`, so it runs on host Git and the sandboxed tier alike. On
reachable disk, card preparation also removes only older daemons' exact
`+refs/heads/ac/card-<n>:refs/remotes/origin/ac/card-<n>` fetch entries and single
`origin` / `refs/heads/ac/card-<n>` upstream pairs for those branches or the
requested card. Wildcard, differently mapped and unforced refspecs, other
remotes and custom upstreams stay intact. Cleanup runs before an already-on-card
return and on fresh worktrees; shared root config is cleaned for all its
worktrees. It is best effort, never resets commits, and skips off-disk shim
repositories, where the old config writes were refused. Exact legacy-shaped
user entries cannot be distinguished without historical ownership metadata.
Dirty, detached, locked and foreign-held state fails closed; local-only card commits
are never reset. Commits never pushed stay in the clone that made them.

Known validation limits (M4 controls): the live suite uses GitHub scratch issues,
real PostgreSQL, a real daemon with a fake ACP runtime, and interactive OIDC
fixtures. Branch creation, preserved commits, removed registrations and live
worktree exclusion are covered by real-git daemon tests; no live remote write
agent is provisioned. Slack delivery is tested with fakes only.

Known gaps (M4 Lane 3b: comment commands and PR completion contracts):

- Label-driven unblock and reopen for non-parked cards belong to #194's label sync
  (merged into this branch). This lane only puts the existing parked-card label
  ingest behind the shared live write check (`authorizeHumanKanbanAction`). A `done`
  card relabelled or reopened by hand is now ingested through the label sync;
  `/kanban reopen` still covers explicit reopens.
- The repository's own App bot is refused as a command sender. The CP has no
  agent-to-GitHub-user mapping, so an agent running under a person's own token could
  not be told apart from that person. Kanban agents only receive installation tokens.
- The CP writes labels, reopen, or close after its commit, best effort, like every CP
  status write.
  - A comment command whose label write fails stays unsettled and is re-applied on
    the next delivery of that comment.
  - Both PR-contract moves (`done` and held `triage`) set `labelWritePending` in the
    settlement transaction. A failed label write is repaired by the reconciler, including
    held cards; a successful repair clears the flag without clearing the human hold.
  - A tick that claims a just-unblocked card before its labels land parks it as a
    `github_state_mismatch`.
- `pr_checks_green` reads GitHub check runs only. Legacy commit statuses are not read,
  because the App has no `statuses` permission. A head with no check runs, or more
  than 300, is never green.
- The card-to-PR link is `linkedPrNumber` from the worker's report, and it only counts
  when the PR is bound to the card: App-authored, head `ac/card-<n>` in the board's
  repository, base the default branch, created inside the card's work episode. The write
  worker now creates and reuses that branch (#416), so those contracts can complete cards.
  Upgrade the daemon before enabling them; older session branches still wait in `review`
  on `pr_unbound`, flagged once with `needsAttention` and one body-free comment.
- A missed `pull_request`/`check_suite` doorbell is recovered by the redelivery sweep
  (24 h look-back) and the 60 s sweep: 25 review cards per board per tick, with a
  rotating cursor. A board with hundreds of cards in review can take several minutes
  to converge.
- Transition notifications (3a's outbox) for comment-command and PR-contract moves are
  not wired yet. 3a's notifier has since landed (merged into this branch), but the
  move paths still call `onApplied` / `onSettled` hooks, which only poke the
  dispatcher today.

Human status and assignment edits now synchronize on every card, not only
mismatch-parked ones. A human `User` (never a bot, App, or unknown actor) who
labels, unlabels, closes, or reopens the issue is adopted through
`planLabelReconcile`: one legal status moves the card, several status labels are
drift repaired to one with an explanatory comment, and a missing label restores
the committed status. A leased card accepts only `blocked`, `triage`, and
`archived`; every other edit reverts with the explanatory comment. An
`ac/agent:<slug>` change maps to an assignee through the organization's agents;
on a leased card it kills the lease (never transfers it), bumps the dispatch
revision, posts a "reassigned from X to Y" comment, and the next dispatch opens
a fresh session. Reopening a `done` card via a label moves it back through the
state machine. A periodic drift reconciler, driven by the same 60-second tick,
repairs a CP status write that failed (a card left with `labelWritePending` is
re-applied) and re-checks a completed blocker's dependents on `issues.closed`.
Every transition writes one body-free `kanban_card_change` audit row.

Known gaps update (M1 label sync permission): a human edit is adopted only after
a live, uncached check that the actor holds `admin`, `maintain`, or `write` on
the repository; a failed lookup counts as no access. An edit by a `triage`,
`read`, or non-collaborator actor is consumed without a transition: the status
label (or a closed issue) is restored to the committed status, a refused
`ac/agent:<slug>` add or removal is undone, and one fixed-template comment
explains the revert. Edits by the deployment App bot, any other bot, an App
acting on a user's behalf, or an unknown actor are ignored without a lookup.
Agents have no GitHub identity of their own: they write only through App
installation tokens, so the App check covers them.

Known gaps update (M1 label sync attribution): an edit is adopted only when the
visible issue events attribute the live label to a human writer; when the events
API lags the live labels, the pass is deferred and neither adopts, reverts, nor
advances the cursor. A deferred card is retried on later passes and fails closed
10 minutes after its first deferral: a `ready` or `running` card moves to `triage`;
other statuses remain unchanged, including `review`. Any active work or verify lease
is revoked and its dispatch revision fenced, even when the status stays the same.
A late report cannot complete the card, stamp approval, or clear the hold. The card is flagged
with `needsAttention`, its status label is projected with one timeout comment,
and a claim neither takes the card nor clears the flag. Failed label writes
remain eligible for repair; only a cleanly attributed human writer edit releases
the hold.

The close reason (`archived` versus `done`) comes from the live issue's
`stateReason`, rather than the visible `closed` event's `state_reason`. A later
close whose event is still lagging can therefore supply the reason for an earlier
attributed close. This pre-existing gap has low impact: both outcomes are terminal
and non-dispatchable.

Roll out the CP before the relay: the strict doorbell schema on an older CP
rejects the new fields. During the CP-before-relay window, a `labeled` doorbell
without a sender or label imports as unassigned `triage` (fail closed). The
relay's optional `at` timestamp lets sync ignore a superseded doorbell and judge
the newer visible label event through the normal attribution path.
An agent using a writer's own host `gh` credentials is indistinguishable from
that human (the shared-GitHub-login limit): label attribution trusts the events
API's actor, which reports the credential's login, not the process behind it.

Known gaps update (M5 projection): every committed status change now reaches the
Projects v2 `Status` field, but the mirror stays one-way. Edits made in the
Project UI are not reconciled; the card's next committed status change overwrites
them. Contract: [kanban-lane4-api.md](kanban-lane4-api.md) `## 4a`.

Known gaps (M3 orchestrator): the orchestrator tools (kanbanList/Create/Link/
Unblock/Assign) are role-gated on `board.orchestratorAgentId`. The daemon files
the issue body directly with a purpose-bound `kanban_orchestrator_write` token,
and the CP registers only metadata; a daemon crash between the file and the
commit_create is a documented window (an in-memory pending map re-commits the
same issue within a process, but a restart can file a duplicate). The GitHub
sub_issues and issue-dependencies (`blocked_by`) WRITE endpoints are not exposed
on every repository (they 404 on user-owned repos), so those link writes are
best-effort and validated by the CP tests rather than live. The per-epic
`epicMaxCards` budget is a lifetime counter that archiving a child never
refunds; `epicMaxActive` bounds concurrent children at claim time. See
docs/designs/kanban-lane2-orchestrator.md for the frame, codes, and B2 semantics.

Known gaps (M5 board view, Lane 4b): the console cannot clear `needsAttention` yet; that waits on Lane 3's restart route. Titles are fetched per visit with one REST read per card (at most 100 per request), so a very large board costs one GitHub call per visible card until a GraphQL batch or an ETag cache is justified; the CP never caches them.
Known gaps correction (Vera #528 review, Lane 4b follow-up): the line above understated the cost — the console polled titles every 60 s for every card including done/archived, about 60x per hour. After the fix the console fetches titles once per visible card set only (rendered, non-terminal cards; never done/archived or collapsed columns; no polling), and the CP caches titles in memory for 60 s (bounded, single-flight, ETag-revalidated) with an abort flag that stops the remaining workers on a rate-limit/5xx failure; the cache is memory-only, never persisted or logged. The card list is capped at 500 cards per board view. The dry run reads the live connection registry of the CP replica that serves it, so on a multi-replica deployment `daemon_offline` can differ from what the dispatching replica sees. The board adopts main’s shared claim predicate, including open leases, review routing, attention flags, and epic and cross-board daemon capacity.
