#!/usr/bin/env bash
# Recorded prod-shaped Kanban live-board smoke (#607): card -> webhook -> dispatch -> terminal -> Status. See docs/runbooks/kanban-live-smoke.md.
# Usage: scripts/kanban-live-smoke.sh up|card|watch|evidence|down|run   (run = up + card + watch + evidence; stack stays up until `down`)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${SMOKE_DIR:-${XDG_RUNTIME_DIR:-${HOME:?HOME is required}/.cache}/kanban-live-smoke}"
while [ "${#DIR}" -gt 1 ] && [ "${DIR%/}" != "$DIR" ]; do DIR="${DIR%/}"; done # trailing slashes would hide a symlink from -L
REPO="${SMOKE_REPO:-mw-ding/agentconnect}"
CP_PORT="${SMOKE_CP_PORT:-18080}"
RELAY_PORT="${SMOKE_RELAY_PORT:-18090}"
SMEE_URL="${SMOKE_SMEE_URL:-https://smee.io/wYHF8fyjxvqpq6yg}"
AGENT_NAME="${SMOKE_AGENT_NAME:-kanban-smoke}"
ORG_ID="org_default00000000000000000"
STATE="$DIR/state.env"
EVIDENCE="${SMOKE_EVIDENCE:-$DIR/evidence.md}"
TIMEOUT_SEC="${SMOKE_TIMEOUT_SEC:-420}"
SUMMARY_WAIT_SEC="${SMOKE_SUMMARY_WAIT_SEC:-120}"
CURL_OPTS=(--connect-timeout 3 --max-time 15)

export SMOKE_ADMIN_URL="${SMOKE_ADMIN_URL:-postgresql://postgres@127.0.0.1:54454/postgres}"
export SMOKE_DB_NAME="${SMOKE_DB_NAME:-ac_kanban_smoke_607}"
export SMOKE_REPO_ID="${SMOKE_REPO_ID:-1332342098}" SMOKE_REPO="$REPO" SMOKE_CP_URL="http://127.0.0.1:${CP_PORT}" SMOKE_DAEMON_ROOT="$DIR/daemon-root" SMOKE_AGENT_NAME="$AGENT_NAME"
export SMOKE_REPO_OWNER="${REPO%%/*}"

log() { printf '%s smoke: %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() {
  log "ERROR: $*" >&2
  exit 1
}
need() { [ -n "${!1:-}" ] || die "$1 is required (env only; never put it in a file)"; }

# Masks secret env values and token shapes in whatever a process prints (line-buffered, so logs stay live).
redact() {
  perl -ne 'BEGIN { $| = 1; @s = grep { length } map { $ENV{$_} } qw(GITHUB_APP_WEBHOOK_SECRET GITHUB_APP_PRIVATE_KEY_B64 GITHUB_TOKEN API_KEY_PEPPER RELAY_TOKEN) }
    for my $v (@s) { s/\Q$v\E/[REDACTED]/g } s/gh[psour]_[A-Za-z0-9]+/[REDACTED]/g; s/github_[p]at_\w+/[REDACTED]/g; print'
}

# The state dir holds sourced state and the daemon key: private, owned by us, never a symlink.
ensure_dir() {
  case "/$DIR/" in */./* | */../*) die "$DIR has a . or .. component; use a plain path" ;; esac # -L on link/. tests the target, not the link
  [ ! -L "$DIR" ] || die "$DIR is a symlink; refusing to use it"
  [ -d "$DIR" ] || { mkdir -p "$(dirname "$DIR")" && mkdir -m 700 "$DIR"; }
  [ -O "$DIR" ] || die "$DIR is not owned by the current user; refusing to use it"
  chmod 700 "$DIR"
}

save() { printf '%s=%q\n' "$1" "$2" >> "$STATE"; }
# shellcheck disable=SC1090
load() { if [ -f "$STATE" ]; then . "$STATE"; fi; }
gh_human() { GH_TOKEN="$GITHUB_TOKEN" gh "$@"; }
cp_get() { curl -fsS "${CURL_OPTS[@]}" "http://127.0.0.1:${CP_PORT}/api/v1/orgs/${ORG_ID}$1"; }
helper() { (cd "$ROOT/packages/control-plane" && exec env -u GITHUB_TOKEN ./node_modules/.bin/tsx ../../scripts/kanban-live-smoke-helper.mts "$@"); }

# Starts a long-lived process (in <cwd>, without the human token) in its own process group; redacted output goes to $DIR/logs/<name>.log.
# The pid file holds the pid and <marker>, a substring of the process args that `down` requires before it signals.
start_bg() {
  local name="$1" cwd="$2" marker="$3"
  shift 3
  mkdir -p "$DIR/logs" "$DIR/pids"
  # The inner 2>&1 and </dev/null keep a caller's pipe from staying open on the long-lived children.
  (cd "$cwd" && exec setsid env -u GITHUB_TOKEN "$@") < /dev/null > >(redact >> "$DIR/logs/$name.log" 2>&1) 2>&1 &
  printf '%s\n%s\n' "$!" "$marker" > "$DIR/pids/$name"
  log "started $name (pid $!, log $DIR/logs/$name.log)"
}

wait_http() {
  local url="$1" name="$2" i
  for i in $(seq 1 90); do
    curl -fsS "${CURL_OPTS[@]}" -o /dev/null "$url" 2> /dev/null && return 0
    sleep 1
  done
  die "$name did not come up at $url (see $DIR/logs)"
}

preflight() {
  local v
  for v in GITHUB_APP_ID GITHUB_APP_SLUG GITHUB_APP_INSTALLATION_ID GITHUB_APP_WEBHOOK_SECRET GITHUB_APP_PRIVATE_KEY_B64 GITHUB_TOKEN; do need "$v"; done
  [[ "$GITHUB_APP_SLUG" =~ ^[A-Za-z0-9-]+$ ]] || die "GITHUB_APP_SLUG has unexpected characters"
  export GITHUB_APP_ID GITHUB_APP_SLUG GITHUB_APP_INSTALLATION_ID GITHUB_APP_WEBHOOK_SECRET GITHUB_APP_PRIVATE_KEY_B64 GITHUB_TOKEN
  for v in node gh curl openssl setsid; do command -v "$v" > /dev/null || die "$v is required$([ "$v" = setsid ] && echo ' (util-linux; Linux only)')"; done
  [ -x "$ROOT/packages/control-plane/node_modules/.bin/tsx" ] || die "run pnpm install first"
  for v in control-plane relay daemon; do
    [ -f "$ROOT/packages/$v/dist/index.js" ] || die "$v is not built; run: pnpm --filter '@agentconnect.md/daemon...' --filter '@agentconnect.md/relay...' --filter '@agentconnect.md/control-plane...' build:package"
  done
  [ -d "$ROOT/packages/control-plane/src/generated/prisma" ] || die "run: pnpm --filter @agentconnect.md/control-plane prisma:generate"
  gh_human api user --jq .login > /dev/null || die "GITHUB_TOKEN is not a valid human token"
}

cmd_up() {
  preflight
  ensure_dir
  : > "$STATE"
  API_KEY_PEPPER="$(openssl rand -hex 32)"
  RELAY_TOKEN="$(openssl rand -hex 32)"
  export API_KEY_PEPPER RELAY_TOKEN
  SMOKE_DAEMON_ID="$(node -e 'console.log(crypto.randomUUID())')"
  SMOKE_AGENT_ID="$(node -e 'console.log(crypto.randomUUID())')"
  SMOKE_BOARD_ID="$(node -e 'console.log(crypto.randomUUID())')"
  export SMOKE_DAEMON_ID SMOKE_AGENT_ID SMOKE_BOARD_ID
  save DAEMON_ID "$SMOKE_DAEMON_ID"
  save AGENT_ID "$SMOKE_AGENT_ID"
  save BOARD_ID "$SMOKE_BOARD_ID"
  # The helper parses the admin URL, swaps only the path, keeps the query, and refuses any name but ac_kanban_smoke_*.
  DATABASE_URL="$(helper scratch-url)"
  export DATABASE_URL
  log "database $SMOKE_DB_NAME: create, migrate, seed"
  helper create-db
  (cd "$ROOT/packages/control-plane" && ./node_modules/.bin/prisma migrate deploy > /dev/null)
  helper seed

  # CP in App mode (all three GITHUB_APP_* set), no OIDC: loopback no-auth with the default org.
  start_bg cp "$ROOT/packages/control-plane" "$ROOT/packages/control-plane/dist/index.js" \
    env NODE_ENV=production PORT="$CP_PORT" HOST=127.0.0.1 node "$ROOT/packages/control-plane/dist/index.js"
  wait_http "http://127.0.0.1:${CP_PORT}/readyz" control-plane

  cp_get "/kanban/boards/$SMOKE_BOARD_ID" > /dev/null || die "seeded board is not readable over REST (see $DIR/logs/cp.log)"
  log "board $SMOKE_BOARD_ID for $REPO is readable over the CP REST API"

  start_bg relay "$ROOT/packages/relay" "$ROOT/packages/relay/dist/index.js" \
    env NODE_ENV=production PORT="$RELAY_PORT" HOST=127.0.0.1 CP_URL="http://127.0.0.1:${CP_PORT}" \
    RELAY_NAME=kanban-smoke-relay DAEMON_DIAL_URL="ws://127.0.0.1:${RELAY_PORT}" node "$ROOT/packages/relay/dist/index.js"
  wait_http "http://127.0.0.1:${RELAY_PORT}/readyz" relay
  start_bg smee "$ROOT" "--target http://127.0.0.1:${RELAY_PORT}/webhooks/github" \
    "$ROOT/packages/control-plane/node_modules/.bin/smee" --url "$SMEE_URL" --target "http://127.0.0.1:${RELAY_PORT}/webhooks/github"
  start_bg daemon "$ROOT" "$ROOT/packages/daemon/dist/index.js run --root $DIR/daemon-root" node "$ROOT/packages/daemon/dist/index.js" run --root "$DIR/daemon-root"
  local ready=0 deadline=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$(cp_get /daemons 2> /dev/null | node -pe 'try{JSON.parse(require("fs").readFileSync(0))[0]?.status}catch{""}')" = "ready" ]; then
      ready=1
      break
    fi
    sleep 1
  done
  [ "$ready" = 1 ] || die "daemon did not reach status ready within 60s (checked after each request) (see $DIR/logs/daemon.log)"
  log "stack up: cp :$CP_PORT relay :$RELAY_PORT smee -> $SMEE_URL daemon root $DIR/daemon-root"
}

ensure_label() {
  local name="$1"
  if gh_human api "repos/$REPO/labels/$(node -pe 'encodeURIComponent(process.argv[1])' "$name")" > /dev/null 2>&1; then return; fi
  gh_human api "repos/$REPO/labels" -f name="$name" -f color=ededed > /dev/null && save "CREATED_LABEL_$(printf '%s' "$name" | tr -c 'A-Za-z0-9' _)" "$name"
}

cmd_card() {
  preflight
  load
  local stamp title body n
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  title="[kanban-live-smoke] #607 recorded run $stamp"
  body="Scratch card for the #607 live-board smoke. No repository changes are requested. Reply with a one-line summary, then call the Kanban terminal tool (kanbanComplete, or kanbanRequestReview if you want a human to look)."
  ensure_label "ac/status:triage"
  ensure_label "ac/status:ready"
  ensure_label "ac/agent:$AGENT_NAME"
  save CARD_AT "$(date -u +%FT%TZ)"
  n="$(gh_human api "repos/$REPO/issues" -f title="$title" -f body="$body" --jq .number)"
  save ISSUE "$n"
  # Labels go in a second call (see kanban-live.ts): inline labels emit their events out of order.
  gh_human api -X PUT "repos/$REPO/issues/$n/labels" -f "labels[]=ac/status:triage" -f "labels[]=ac/agent:$AGENT_NAME" > /dev/null
  log "card #$n created; waiting for the import (App webhook -> relay -> CP)"
  local i
  for i in $(seq 1 60); do
    cp_get "/kanban/boards/$BOARD_ID/cards?numbers=$n" | node -e 'process.exit(JSON.parse(require("fs").readFileSync(0)).cards.length ? 0 : 1)' && break
    [ "$i" -lt 60 ] || die "card #$n was not imported in 60s (webhook not reaching the relay? see $DIR/logs)"
    sleep 2
  done
  save READY_AT "$(date -u +%FT%TZ)"
  gh_human api -X PUT "repos/$REPO/issues/$n/labels" -f "labels[]=ac/status:ready" -f "labels[]=ac/agent:$AGENT_NAME" > /dev/null
  log "card #$n moved to ac/status:ready"
}

card_json() { cp_get "/kanban/boards/$BOARD_ID/cards?numbers=$ISSUE" | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0)).cards[0])'; }

cmd_watch() {
  preflight
  load
  [ -n "${ISSUE:-}" ] || die "no card; run: $0 card"
  # The import lands in triage before the ready label is processed, so triage only counts as terminal after ready/running was seen.
  local deadline=$((SECONDS + TIMEOUT_SEC)) status="" active=0
  while [ "$SECONDS" -lt "$deadline" ]; do
    status="$(card_json | node -pe 'JSON.parse(require("fs").readFileSync(0)).status')"
    log "card #$ISSUE status=$status"
    case "$status" in ready | running) active=1 ;; done | review | blocked) return 0 ;; triage) [ "$active" = 1 ] && return 0 ;; esac
    sleep 5
  done
  die "no terminal status in ${TIMEOUT_SEC}s (last: $status)"
}

# The bot summary lands after the CP sees the terminal, so wait (bounded) for an ac-kanban-lease: comment authored by the App bot.
wait_bot_summary() {
  local deadline=$((SECONDS + SUMMARY_WAIT_SEC)) found=""
  while :; do
    found="$(gh_human api "repos/$REPO/issues/$ISSUE/comments?per_page=100" \
      --jq ".[] | select(.user.login == \"${GITHUB_APP_SLUG}[bot]\" and (.body | contains(\"ac-kanban-lease:\"))) | .id" | head -n 1)"
    [ -z "$found" ] || return 0
    [ "$SECONDS" -lt "$deadline" ] || die "no ac-kanban-lease: comment by ${GITHUB_APP_SLUG}[bot] on #$ISSUE within ${SUMMARY_WAIT_SEC}s"
    log "waiting for the bot summary comment on #$ISSUE"
    sleep 5
  done
}

cmd_evidence() {
  preflight
  load
  [ -n "${ISSUE:-}" ] || die "no card; run: $0 card"
  wait_bot_summary
  local card comments issue_json deliveries
  deliveries="$(helper deliveries "$ISSUE" "$CARD_AT")"
  card="$(card_json)"
  comments="$(gh_human api "repos/$REPO/issues/$ISSUE/comments?per_page=100")"
  issue_json="$(gh_human api "repos/$REPO/issues/$ISSUE")"
  {
    echo "# Kanban live smoke evidence ($(date -u +%FT%TZ))"
    echo
    echo "- Card: https://github.com/$REPO/issues/$ISSUE"
    echo "- Board: $BOARD_ID (CP :$CP_PORT, relay :$RELAY_PORT, smee $SMEE_URL)"
    echo "- Card created $CARD_AT, moved to ready $READY_AT. Webhook deliveries for the card (X-GitHub-Delivery GUID, App deliveries API; the ready move is the first \`labeled\` after READY_AT):"
    printf '%s\n' "$deliveries" | sed 's/^/  - /'
    echo "- Relay doorbells for those GUIDs (verified by the relay, rung to the CP):"
    for guid in $(printf '%s\n' "$deliveries" | node -e 'for (const l of require("fs").readFileSync(0, "utf8").split("\n")) if (l) console.log(JSON.parse(l).guid)'); do
      grep -o "kanban doorbell $guid repo [0-9]* ([a-z_]*:[a-z_]*)" "$DIR/logs/relay.log" | sed 's/^/  - /' || true
    done
    echo "- CP run reports and daemon lease lines:"
    grep -h -o '"leaseId":"[0-9a-f-]*","outcome":"[a-z_]*","to":"[a-z_]*","msg":"kanban: run reported"' "$DIR/logs/cp.log" | sed 's/^/  - cp: /' || true
    grep -h 'kanban: lease' "$DIR/logs/daemon.log" | sed 's/^\[agentconnect\] /  - daemon: /' || true
    echo "- Lease ids (from the bot summary markers; also in the daemon log):"
    printf '%s' "$comments" | node -e 'for (const c of JSON.parse(require("fs").readFileSync(0))) for (const m of c.body.matchAll(/ac-kanban-lease:([0-9a-f-]{36})/g)) console.log("  - " + m[1] + " (comment " + c.id + ")")' | sort -u
    echo "- Terminal status (CP card read): $(printf '%s' "$card" | node -pe 'JSON.parse(require("fs").readFileSync(0)).status')"
    echo "- Bot comments (author login must be ${GITHUB_APP_SLUG}[bot]):"
    printf '%s' "$comments" | node -e 'for (const c of JSON.parse(require("fs").readFileSync(0))) console.log("  - " + c.html_url + " author=" + c.user.login + " type=" + c.user.type + "\n    > " + c.body.replace(/<!--[^>]*-->/g, "").trim().slice(0, 240).replace(/\n/g, "\n    > "))'
    echo "- GitHub read-back: state=$(printf '%s' "$issue_json" | node -pe 'const i=JSON.parse(require("fs").readFileSync(0)); i.state+"/"+i.state_reason+" labels="+i.labels.map(l=>l.name).join(",")')"
    echo
    echo '## CP card read (GET /api/v1/orgs/:orgId/kanban/boards/:boardId/cards?numbers=N)'
    echo '```json'
    printf '%s' "$card" | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0)),null,2)'
    echo '```'
  } | tee "$EVIDENCE"
  log "evidence written to $EVIDENCE"
}

cmd_down() {
  load
  local f pid marker info pgid args failed=0
  for f in "$DIR"/pids/*; do
    [ -e "$f" ] || continue
    { read -r pid && read -r marker; } < "$f" || true
    info="$(ps -ww -o pgid=,args= -p "${pid:-0}" 2> /dev/null || true)"
    read -r pgid args <<< "$info"
    if [ -z "$info" ] || [ "$pgid" != "$pid" ] || [ -z "$marker" ] || [[ "$args" != *"$marker"* ]]; then
      log "skipping $(basename "$f"): pid ${pid:-?} is not a live process of ours (stale entry)"
      rm -f "$f"
      continue
    fi
    if kill -TERM -- "-$pid" 2> /dev/null; then rm -f "$f"; else
      log "could not signal $(basename "$f") (pid $pid); keeping its pid file"
      failed=1
    fi
  done
  [ "$failed" = 0 ] || die "some processes were not stopped; fix and rerun: $0 down"
  sleep 2
  # A card that reached done is already closed as completed; only a still-open scratch card gets closed here.
  if [ -n "${ISSUE:-}" ] && [ -n "${GITHUB_TOKEN:-}" ] && [ "$(gh_human api "repos/$REPO/issues/$ISSUE" --jq .state)" = open ]; then
    gh_human api -X PATCH "repos/$REPO/issues/$ISSUE" -f state=closed -f state_reason=not_planned > /dev/null && log "closed card #$ISSUE as not_planned"
  fi
  log "stack stopped; state kept in $DIR. Labels this run created: $(grep -c '^CREATED_LABEL_' "$STATE" 2> /dev/null || true) (delete by hand if unwanted). DB $SMOKE_DB_NAME kept; drop with: $0 drop-db"
}

cmd_drop_db() {
  helper drop-db
  rm -rf "$DIR/daemon-root"
}

case "${1:-}" in
  up | card | watch | evidence | down | drop-db | run) ensure_dir ;;
esac
case "${1:-}" in
  up) cmd_up ;;
  card) cmd_card ;;
  watch) cmd_watch ;;
  evidence) cmd_evidence ;;
  down) cmd_down ;;
  drop-db) cmd_drop_db ;;
  run)
    cmd_up
    cmd_card
    cmd_watch
    cmd_evidence
    ;;
  *)
    sed -n 2,3p "$0"
    exit 2
    ;;
esac
