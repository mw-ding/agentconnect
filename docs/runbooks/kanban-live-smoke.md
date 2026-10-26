# Kanban live-board smoke runbook

A recorded, prod-shaped smoke of the live board: a card on the board repo
goes `ac/status:ready`, the App webhook reaches the relay and the CP
doorbell, the dispatcher leases it to a daemon, a real agent reaches a
terminal tool, the daemon-owned summary is posted by the App bot, and the
Status read-back shows the result. This is the M-live check from
[kanban-p0-pilot.md](../designs/kanban-p0-pilot.md) (M1 import, M2 dispatch,
M3 App tokens and webhook, M4 board reads).

Unlike the in-process E2E (`kanban-dispatch.e2e.test.ts`), the CP, relay,
daemon and smee forwarder are real, separate OS processes outside the Vitest
harness. App setup is not repeated here: do
[kanban-github-app.md](kanban-github-app.md) first.

[`scripts/kanban-live-smoke.sh`](../../scripts/kanban-live-smoke.sh)
automates everything below; this page is the checklist it implements and what
to record. Failures are not fixed in this run: see
[Failures](#failures).

## Prerequisites

- Node >= 24.12.0 and pnpm 11 (see the repo `CLAUDE.md`), `gh`, `curl`,
  `openssl`, `perl`.
- A Postgres server you can create a database on. The script creates its own
  fresh database (`ac_kanban_smoke_607` by default) and never touches others.
  No Docker is needed.
- The Kanban App installed on the board repo, its webhook pointing at a smee
  channel (the interim channel in the App runbook), and
  [the App runbook's Verify steps](kanban-github-app.md#verify) passing.
- A coding agent CLI logged in on the daemon host. The smoke uses `claude`
  through the `claude-acp` runtime; the daemon downloads the ACP adapter on
  first use.
- Packages built, so the processes are the shipped entry points and the
  daemon's `gh` shim can load the protocol package:

  ```bash
  pnpm install
  pnpm --filter @agentconnect.md/control-plane prisma:generate
  pnpm --filter '@agentconnect.md/daemon...' --filter '@agentconnect.md/relay...' \
    --filter '@agentconnect.md/control-plane...' build:package
  ```

- Secrets in the environment only. Never write them to a file, an issue or a
  log:

  | Variable                     | What                                                                         |
  | ---------------------------- | ---------------------------------------------------------------------------- |
  | `GITHUB_APP_ID`              | App ID (App settings, or `GET /app`)                                         |
  | `GITHUB_APP_SLUG`            | `agentconnect-kanban`                                                        |
  | `GITHUB_APP_CLIENT_ID`       | Client ID (the JWT issuer, preferred over the App ID)                        |
  | `GITHUB_APP_INSTALLATION_ID` | Installation id of the board repo                                            |
  | `GITHUB_APP_WEBHOOK_SECRET`  | the App webhook secret                                                       |
  | `GITHUB_APP_PRIVATE_KEY_B64` | base64 of the App `.pem`                                                     |
  | `GITHUB_TOKEN`               | a **human** token that can write to the repo (creates the card, adds labels) |

  The card must be filed and labeled by a human writer: the importer checks
  the author's and the status-label adder's live repo role, and a bot never
  qualifies
  ([M1 import](../designs/kanban-p0-pilot.md#m1--board-configuration-and-issue-import)).

Pilot values (not secret): board repo `mw-ding/agentconnect` (repo id
`1332342098`), App slug `agentconnect-kanban`, Client ID
`Iv23liSDlzlB6NpYYLbc`, installation id `175256932`. The App ID is `5471608`;
confirm any value you are handed with `GET /app` (see
[Troubleshooting](#troubleshooting)).

## The prod-shaped local stack

`scripts/kanban-live-smoke.sh up` starts, each in its own process group with
redacted output in `$SMOKE_DIR/logs/<name>.log`. The default `SMOKE_DIR` is
`${XDG_RUNTIME_DIR:-$HOME/.cache}/kanban-live-smoke`, created mode 0700; the
script refuses a state dir that is a symlink or not owned by you, before it
sources `state.env`. The human `GITHUB_TOKEN` is not passed to these processes:

| Process | Command                                                                       | Port                         |
| ------- | ----------------------------------------------------------------------------- | ---------------------------- |
| CP      | `node packages/control-plane/dist/index.js`                                   | `18080` (`SMOKE_CP_PORT`)    |
| relay   | `node packages/relay/dist/index.js`                                           | `18090` (`SMOKE_RELAY_PORT`) |
| smee    | `smee-client --url <channel> --target http://127.0.0.1:18090/webhooks/github` | none                         |
| daemon  | `node packages/daemon/dist/index.js run --root $SMOKE_DIR/daemon-root`        | none                         |

The scratch database URL is `SMOKE_ADMIN_URL` with only its path replaced
(query string kept); the script refuses any name but `ac_kanban_smoke_*`
before it migrates or seeds. Every REST call to the CP uses curl timeouts
(3 s connect, 15 s total).

Use ports that are free on your host; another relay or smee client may
already be running and is none of this run's business.

The CP runs in App mode (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_B64`,
`GITHUB_APP_SLUG` all set, no PAT fallback) with `OIDC_ISSUER` unset, so it
serves the loopback no-auth devAuth principal in the default org. The relay
takes `GITHUB_APP_WEBHOOK_SECRET` and a generated `RELAY_TOKEN` that the CP
shares. The daemon connects to the CP with a freshly minted daemon API key.

### What is provisioned, and how

Everything the interactive console flow would create is either seeded
directly in the scratch database or read back over the real CP REST API.
`scripts/kanban-live-smoke-helper.mts` does the seeding.

| Item                                        | How                                                                                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Database                                    | `CREATE DATABASE`, then `prisma migrate deploy`. The default org and owner come from the CP's own startup (`ensureDefaultTenant`).                                                                                 |
| GitHub installation row                     | **Seeded** (`github_installation`: installation id, account `mw-ding`, `User`, selected repos). The install-callback flow needs a browser sign-in.                                                                 |
| Board                                       | **Seeded** (`kanban_board`: org, repo id, `mw-ding/agentconnect`, default read mode). `POST .../kanban/boards` is `interactiveOnly` (OIDC), so devAuth gets 403 `INTERACTIVE_AUTH_REQUIRED`. Read back with `GET`. |
| Daemon row, agent row, daemon API key       | **Seeded** (`daemon`, `agent` with runtime `claude-acp`, `api_key` with `principalType: daemon`, hashed with the run's `API_KEY_PEPPER`).                                                                          |
| Daemon `config.json` and local `agent.json` | Written by the helper under `$SMOKE_DIR/daemon-root`. `config.json` is created mode 0600 under a 0700 root and carries the daemon key; the dir is outside the repo and removed by `drop-db`.                       |
| Card, labels                                | Real GitHub API calls as the human token.                                                                                                                                                                          |
| Everything after the card exists            | Real: GitHub App webhook, smee, relay, CP import and dispatch, daemon, ACP agent, App-token comment.                                                                                                               |

A deployment with OIDC sign-in should create the installation and board
through the console instead and skip the seeding. Nothing else in the run
changes.

Run the stack up with:

```bash
scripts/kanban-live-smoke.sh up
```

It ends with `stack up`. Check the relay link and daemon before filing a
card:

```bash
curl -fsS http://127.0.0.1:18090/readyz # {"status":"ready","relayId":"..."}
curl -fsS "http://127.0.0.1:18080/api/v1/orgs/org_default00000000000000000/daemons"
```

The daemon `status` must be `ready`; `up` fails if it is not within 60 s.

## The run

`scripts/kanban-live-smoke.sh run` does steps 1 to 4 and writes the evidence;
the steps can be run one at a time with `card`, `watch` and `evidence`.
`watch` stops at the CP terminal status, but the bot summary comment lands
after that, so `evidence` first polls (default 120 s, `SMOKE_SUMMARY_WAIT_SEC`)
for a comment containing `ac-kanban-lease:` authored by
`${GITHUB_APP_SLUG}[bot]` and fails if none appears.

1. **File a card and move it to ready.** Create an issue titled
   `[kanban-live-smoke] #607 recorded run <timestamp>` whose body asks the
   worker for a one-line summary and a Kanban terminal tool call
   (`kanbanComplete` or `kanbanRequestReview`). Add `ac/status:triage` and
   `ac/agent:<agent-name>` in a second call (inline labels emit their events
   out of order), wait for the card to appear on the board, then replace the
   status label with `ac/status:ready`. Create missing `ac/*` labels first;
   existing ones are left alone.

2. **Webhook, relay, doorbell, dispatch.** GitHub delivers each event to
   smee, smee forwards to the relay's `POST /webhooks/github`, the relay
   verifies `X-Hub-Signature-256` and rings the CP with a body-free doorbell
   (`github ingress: kanban doorbell <guid> repo <id> (issues:labeled)` in
   the relay log), and the CP dispatcher leases the card to the daemon.
   Record the `X-GitHub-Delivery` GUID of the ready move (the first `labeled`
   delivery after the move; the helper lists them from the App's
   `GET /app/hook/deliveries`) and the lease id (`kanban: lease <id>` in the
   daemon log, `"leaseId"` in the CP's `kanban: run reported` line, and the
   `ac-kanban-lease:<id>` marker in the summary comment).

3. **Worker run and terminal.** The card goes `ready` to `running` (the
   daemon ACKs and the CP writes the `ac/status:running` label), the agent
   reads the card with the Kanban tools and calls a terminal tool, and the
   card ends `done`, `review`, `blocked` or `triage`. The daemon posts the
   final summary with an App installation token. Check that the comment
   author is `agentconnect-kanban[bot]`:

   ```bash
   N=664 # the card's issue number
   gh api "repos/mw-ding/agentconnect/issues/$N/comments" \
     --jq '.[] | {url: .html_url, login: .user.login, type: .user.type}'
   ```

4. **Status read-back.** The board in this run has no Projects v2 Status
   field configured, so Status is the `ac/status:*` label and the CP card
   row. Read both:

   ```bash
   BOARD_ID=... # from $SMOKE_DIR/state.env
   curl -fsS "http://127.0.0.1:18080/api/v1/orgs/org_default00000000000000000/kanban/boards/$BOARD_ID/cards?numbers=$N"
   gh api "repos/mw-ding/agentconnect/issues/$N" \
     --jq '{state, state_reason, labels: [.labels[].name]}'
   ```

   A board with `projectNodeId` and `statusFieldId` also projects Status to
   the org Project field; read it with the Projects v2 GraphQL API or the
   console board view and record that instead.

## Evidence template

`scripts/kanban-live-smoke.sh evidence` prints this and writes it to
`$SMOKE_EVIDENCE` (default `$SMOKE_DIR/evidence.md`). Paste it, with the
process logs, into the issue; never paste secrets.

```text
Run:           <UTC timestamp>, branch/commit <sha>
Stack:         CP :<port>, relay :<port>, smee <channel>, daemon <root>, board <boardId>
Card:          https://github.com/<repo>/issues/<n>   (created <t>, moved to ready <t>)
Delivery GUID: <X-GitHub-Delivery of the ready move>   (+ doorbell line from relay.log)
Lease id:      <uuid>
Terminal:      done | review | blocked | triage   (CP card read)
Bot comment:   <issuecomment URL>   author=agentconnect-kanban[bot] type=Bot
Status:        CP card JSON + issue state/labels (or the Project Status field value)
Result:        PASS | FAIL (with the follow-up issue link)
```

## Cleanup

```bash
scripts/kanban-live-smoke.sh down    # stops cp, relay, smee, daemon (only pids whose process group and args still match); closes the card if it is still open
scripts/kanban-live-smoke.sh drop-db # drops the scratch database and the daemon root
```

Capture the evidence before `drop-db`. Labels the run created are listed in
`$SMOKE_DIR/state.env` (`CREATED_LABEL_*`); delete them by hand if you do not
want them. Never stop anything you did not start.

## Troubleshooting

- **`GET /app` or `/app/hook/deliveries` returns 404 "Integration not
  found".** The JWT `iss` is wrong. Use the Client ID (the CP does when
  `GITHUB_APP_CLIENT_ID` is set) or the real App ID from `GET /app`. A
  mistyped App ID passes CP boot (the Client ID is the issuer) but not this
  lookup.
- **Board create returns 403 `INTERACTIVE_AUTH_REQUIRED`.** Expected without
  OIDC; see the provisioning table.
- **Card never leaves `triage`/never imports.** Check, in order: smee log
  shows `202` forwards; relay log has a `kanban doorbell` line (401 means a
  secret mismatch, 404 means no relay webhook secret, see the
  [App runbook](kanban-github-app.md#troubleshooting)); the card author and
  label adder are human writers; the agent name in `ac/agent:<name>` matches
  the seeded agent.
- **`kanban graph doorbell failed ... the doorbell label add is not yet
visible in the issue events`** (CP warn). GitHub's issue events lag the
  webhook; the import retries and the redelivery sweep covers it. Only a
  problem if the card never imports.
- **Lease fails with `runtime "claude" not available`.** The agent's runtime
  id must be the daemon's ACP id, `claude-acp`, not `claude`.
- **The agent's `gh` fails with `ERR_MODULE_NOT_FOUND ...
@agentconnect.md/protocol/dist/index.js`.** The daemon was run from source
  without the packages built. Build them (Prerequisites). Left alone, the
  Claude turn can sit in plan mode on `ExitPlanMode` and the lease stays
  `running` until the stale-lease reaper takes it.
- **The ready move does nothing.** Dispatch needs the card imported first
  and a live daemon (`status: ready`). `watch` treats `triage` as terminal
  only after it has seen `ready` or `running`, because the import lands in
  `triage` before the ready label is processed.
- **Daemon `EMFILE: too many open files, watch` warnings.** The host's
  inotify limit is exhausted by other processes, so file watchers are
  degraded (the run still worked here). Raise `fs.inotify.max_user_watches` /
  `max_user_instances` if it matters.
- **A fresh smee client can replay recent channel history.** The relay log
  may show doorbell GUIDs from earlier deliveries; evidence lists only the
  GUIDs of the card under test. The channel is shared: any other relay or CP
  subscribed to it sees the same deliveries, so use one board repo per
  concurrent run.
- **No `ac/status:*` label change after the terminal.** Look at the CP log
  for `kanban: run reported` and at the daemon log for the lease line; a
  terminal the model never called is nudged once, then the run ends `failed`.

## Failures

A failed or surprising step in this smoke is a finding, not something to fix
in the same change. Capture the evidence and logs, then file a follow-up
issue (title, observed versus expected, delivery GUID, lease id, log
excerpts) that says `Refs #607`, and link it from the evidence comment.
