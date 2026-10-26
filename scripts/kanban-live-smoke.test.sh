#!/usr/bin/env bash
# Regression test: kanban-live-smoke.sh must refuse a symlinked/dotted SMOKE_DIR before sourcing state.env. Run: bash scripts/kanban-live-smoke.test.sh
set -u
SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/kanban-live-smoke.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fails=0

plant() { mkdir -p "$1" && printf 'touch %q\n' "$T/sourced" > "$1/state.env"; }
plant "$T/real"
mkdir -p "$T/real/sub"
ln -s "$T/real" "$T/link"

# check <name> <refuse|allow> <SMOKE_DIR>
check() {
  local name="$1" want="$2" dir="$3" out rc
  rm -f "$T/sourced"
  out="$(cd "$T" && HOME="$T/home" SMOKE_DIR="$dir" bash "$SCRIPT" down 2>&1)"
  rc=$?
  if [ "$want" = refuse ]; then
    if [ -e "$T/sourced" ] || [ "$rc" = 0 ] || [[ "$out" != *refus* && "$out" != *"component"* ]]; then
      echo "FAIL $name: expected refusal, rc=$rc sourced=$([ -e "$T/sourced" ] && echo yes || echo no): $out"
      fails=$((fails + 1))
      return
    fi
  elif [ ! -e "$T/sourced" ]; then
    echo "FAIL $name: expected state.env to be sourced: $out"
    fails=$((fails + 1))
    return
  fi
  echo "ok   $name"
}

check "link" refuse "$T/link"
check "link/" refuse "$T/link/"
check "link//" refuse "$T/link//"
check "link/." refuse "$T/link/."
check "link/./" refuse "$T/link/./"
check "./link/." refuse "./link/."
check "link/sub/.." refuse "$T/link/sub/.."
check "real/sub/.." refuse "$T/real/sub/.."
check "real (plain)" allow "$T/real"
check "real/ (trailing slash)" allow "$T/real/"

[ "$fails" = 0 ] || {
  echo "$fails failure(s)"
  exit 1
}
echo "all passed"
