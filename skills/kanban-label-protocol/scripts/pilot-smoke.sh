#!/usr/bin/env bash
# Kanban P0 — read-only precondition hints and example gh exports (no AgentConnect API calls).
set -euo pipefail

REPO="${REPO:-}"
SLUG="${SLUG:-worker-alpha}"

echo "Kanban P0 pilot smoke helper"
echo

if ! command -v gh >/dev/null 2>&1; then
  echo "FAIL: gh CLI not found. Install https://cli.github.com/"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "FAIL: gh not authenticated. Run: gh auth login"
  exit 1
fi
echo "OK: gh authenticated"

if [[ -z "$REPO" ]]; then
  echo "WARN: set REPO=owner/kanban-board to verify labels and repo access"
  echo "Example:"
  echo "  export REPO=owner/kanban-board SLUG=worker-alpha"
  echo "  $0"
  exit 0
fi

if ! gh repo view "$REPO" >/dev/null 2>&1; then
  echo "FAIL: cannot view repo $REPO"
  exit 1
fi
echo "OK: repo $REPO visible"

missing=()
for label in \
  ac/status:triage ac/status:todo ac/status:ready ac/status:running \
  ac/status:blocked ac/status:review ac/status:done ac/status:archived \
  "ac/agent:${SLUG}"; do
  if ! gh label list --repo "$REPO" --limit 500 --json name --jq ".[] | select(.name==\"$label\") | .name" | grep -qx "$label"; then
    missing+=("$label")
  fi
done

if ((${#missing[@]} > 0)); then
  echo "WARN: missing labels on $REPO:"
  printf '  - %s\n' "${missing[@]}"
  echo "Create them per references/label-protocol.md"
else
  echo "OK: Kanban status labels and ac/agent:${SLUG} present"
fi

echo
echo "Next: follow scripts/pilot-smoke.md (human adds ac/agent:${SLUG} to dispatch)."
echo "Known gap: bot/App label events do not dispatch hooks."
