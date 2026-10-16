// The `gh` wrapper text, shared by the daemon's `run/bin/gh` and the sandbox image's own copy (issue #457).
// gh reads a STATIC GH_TOKEN fixed at spawn and has no credential-helper hook, so the wrapper goes first on PATH.
// Thin on purpose: locate the real gh, forward the whole argv to the token command, exec gh with what it printed.
// Which repo that token names is decided by `cp/gh-target.ts` on the Node side — sh must not parse `gh api` paths.
// Fail closed: agent gh uses only fresh daemon-issued github.com tokens and never falls back to human credentials.
// Secret-free (paths + agent id only): tokens transit a shell variable and the exec'd env, never argv, never disk.
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** Single-quote a value for sh, escaping any quote it carries. */
export const shQuote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`

export interface GhWrapperSpec {
  /** The wrapper's own directory, skipped while it locates the real gh. */
  selfDir: string
  /** Command line printing a fresh token for THIS invocation; it receives the agent's gh argv as `"$@"`. */
  tokenCommand: string
}

/** The wrapper script itself — ONE generator, so the daemon's copy and the runtime image's cannot drift. */
export function renderGhWrapper({ selfDir, tokenCommand }: GhWrapperSpec): string {
  return `#!/bin/sh
# agentconnect gh wrapper — generated, never edited; NO secrets.
# Per-repo, per-invocation GH_TOKEN over the daemon's credential channel (issue #457).

SELF_DIR=${shQuote(selfDir)}

# The real gh: first one on PATH outside our own bin dir.
REAL_GH=""
_OLDIFS=$IFS; IFS=:
for _d in $PATH; do
  [ "$_d" = "$SELF_DIR" ] && continue
  if [ -x "$_d/gh" ]; then REAL_GH="$_d/gh"; break; fi
done
IFS=$_OLDIFS
if [ -z "$REAL_GH" ]; then
  echo "agentconnect: gh is not installed on this machine" >&2
  exit 127
fi

# Only the daemon may supply invocation-scoped GitHub credentials.
if [ -n "$GH_TOKEN$GITHUB_TOKEN$GH_ENTERPRISE_TOKEN$GITHUB_ENTERPRISE_TOKEN" ]; then
  echo "agentconnect: refusing inherited GitHub token; agent gh requires daemon credentials" >&2
  exit 1
fi
if [ -z "$AC_AGENT_ID" ]; then
  echo "agentconnect: AC_AGENT_ID is required for agent gh credentials" >&2
  exit 1
fi
unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN

# The daemon token is a github.com token; never let a host selector carry it, or stored auth, elsewhere.
_HOST=""
_prev=""
for _a in "$@"; do
  [ "$_prev" = "--hostname" ] && _HOST="$_a"
  case "$_a" in
    --hostname=*) _HOST="\${_a#--hostname=}" ;;
  esac
  _prev="$_a"
done
for _h in "$_HOST" "\${GH_HOST-}"; do
  case "$_h" in
    ''|[Gg][Ii][Tt][Hh][Uu][Bb].[Cc][Oo][Mm]) ;;
    *)
      echo "agentconnect: agent gh is limited to github.com; refusing host $_h" >&2
      exit 1
      ;;
  esac
done

# Fresh token from the daemon; it resolves the target repo from the argv forwarded below
# (stdout = token only; stderr passes through so the agent can read WHY a repo was refused).
# Exit 2 = "not ours" (non-github.com target), exit 3 = refused; every failure stops before stored gh auth.
_TOKEN=$(${tokenCommand})
_RC=$?
if [ "$_RC" -eq 2 ]; then
  echo "agentconnect: agent gh credentials are limited to github.com; refusing a non-github.com target" >&2
  exit 1
fi
if [ "$_RC" -eq 3 ]; then
  exit 1
fi
if [ "$_RC" -ne 0 ] || [ -z "$_TOKEN" ]; then
  echo "agentconnect: daemon could not provide GitHub credentials; refusing stored gh authentication" >&2
  exit 1
fi
GH_TOKEN="$_TOKEN" exec "$REAL_GH" "$@"
`
}

export function ghShimDir(root: string): string {
  return join(root, 'run', 'bin')
}

/** (Re)write `run/bin/gh` and return the bin dir to prepend to agent PATHs. */
export function writeGhShim(root: string, cliEntry: string): string {
  const dir = ghShimDir(root)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700) // defeat a loose umask; best-effort on non-POSIX
  } catch {
    /* best-effort */
  }
  const executableEntry = existsSync(cliEntry) ? realpathSync(cliEntry) : cliEntry
  // Dev daemons run under tsx with a .ts argv[1] — route through the tsx CLI (the git-credential shim
  // precedent; plain `node entry.ts` dies on .js-suffixed imports).
  const argv = [shQuote(realpathSync(process.execPath))]
  if (executableEntry.endsWith('.ts')) {
    const req = createRequire(import.meta.url)
    argv.push(shQuote(req.resolve('tsx/cli')))
  }
  argv.push(shQuote(executableEntry))
  const body = renderGhWrapper({
    selfDir: dir,
    tokenCommand: `AGENTCONNECT_ROOT=${shQuote(root)} ${argv.join(' ')} gh-token "$AC_AGENT_ID" -- "$@"`
  })
  writeFileSync(join(dir, 'gh'), body, { mode: 0o755 })
  return dir
}
