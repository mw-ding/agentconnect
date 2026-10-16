// Agent gh invocations use only fresh daemon-issued tokens and never fall back to human credentials.
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

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
  const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
  const executableEntry = existsSync(cliEntry) ? realpathSync(cliEntry) : cliEntry
  // Dev daemons run under tsx with a .ts argv[1] — route through the tsx CLI
  // (the git-credential shim precedent; plain `node entry.ts` dies on
  // .js-suffixed imports).
  const argv = [q(realpathSync(process.execPath))]
  if (executableEntry.endsWith('.ts')) {
    const req = createRequire(import.meta.url)
    argv.push(q(req.resolve('tsx/cli')))
  }
  argv.push(q(executableEntry))
  const cli = argv.join(' ')
  const body = `#!/bin/sh
# agentconnect gh wrapper — regenerated on daemon start; NO secrets.
# Per-repo, per-invocation GH_TOKEN via the daemon socket (issue #457).

SELF_DIR=${q(dir)}

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
_check_host() {
  case "$1" in
    [Gg][Ii][Tt][Hh][Uu][Bb].[Cc][Oo][Mm]) ;;
    *)
      echo "agentconnect: agent gh is limited to github.com; refusing host $1" >&2
      exit 1
      ;;
  esac
}
[ -n "\${GH_HOST-}" ] && _check_host "$GH_HOST"

# The command group, found like cobra's stripFlags: at the root every flag but help/version takes a value.
_GROUP=""
_skip=""
for _a in "$@"; do
  if [ -n "$_skip" ]; then _skip=""; continue; fi
  case "$_a" in
    --) break ;;
    --help|--version|-h|--*=*) ;;
    --*|-?) _skip=1 ;;
    -*) ;;
    *) _GROUP="$_a"; break ;;
  esac
done
# Value-taking flags per group; an unlisted flag is parsed as boolean, which can only over-refuse, never miss a host.
case "$_GROUP" in
  api)
    _LONG_VALUES=" cache field header hostname input jq method preview raw-field repo template "
    _SHORT_VALUES="FHRXfpqt"
    ;;
  auth)
    _LONG_VALUES=" git-protocol hostname remove-scopes repo scopes user "
    _SHORT_VALUES="Rhprsu"
    ;;
  *)
    _LONG_VALUES=" assignee base body body-file branch field header hostname input jq json label limit milestone owner project raw-field ref repo reviewer search state template title "
    _SHORT_VALUES="LRbqt"
    ;;
esac

# Parse argv like pflag: every real --hostname (or auth -h) must be github.com; repo falls back to positional, GH_REPO, origin.
_REPO=""
_want=""
for _a in "$@"; do
  case "$_want" in
    host) _check_host "$_a"; _want=""; continue ;;
    repo) _REPO="$_a"; _want=""; continue ;;
    skip) _want=""; continue ;;
  esac
  case "$_a" in
    --) break ;;
    --*=*)
      _name="\${_a%%=*}"
      case "\${_name#--}" in
        hostname) _check_host "\${_a#*=}" ;;
        repo) _REPO="\${_a#*=}" ;;
      esac
      ;;
    --?*)
      case "\${_a#--}" in
        hostname) _want=host ;;
        repo) _want=repo ;;
        *) case "$_LONG_VALUES" in *" \${_a#--} "*) _want=skip ;; esac ;;
      esac
      ;;
    -?*)
      # A shorthand group like -ih: boolean letters until one takes a value, which is the rest or the next argument.
      _rest="\${_a#-}"
      while [ -n "$_rest" ]; do
        _c="\${_rest%"\${_rest#?}"}"
        _rest="\${_rest#?}"
        case "$_SHORT_VALUES" in
          *"$_c"*)
            case "$_rest" in =?*) _rest="\${_rest#=}" ;; esac
            _kind=skip
            [ "$_c" = R ] && _kind=repo
            [ "$_c" = h ] && [ "$_GROUP" = auth ] && _kind=host
            if [ -z "$_rest" ]; then
              _want="$_kind"
            elif [ "$_kind" = host ]; then
              _check_host "$_rest"
            elif [ "$_kind" = repo ]; then
              _REPO="$_rest"
            fi
            break
            ;;
        esac
        # A boolean shorthand followed by =value consumes the rest of the group.
        case "$_rest" in =*) break ;; esac
      done
      ;;
  esac
done
if [ -z "$_REPO" ]; then
  case "\${1-}:\${2-}" in
    repo:archive|repo:clone|repo:delete|repo:edit|repo:fork|repo:set-default|repo:sync|repo:unarchive|repo:view)
      _REPO_COMMAND="\${2-}"
      ;;
  esac
fi
if [ -z "$_REPO" ] && [ -n "$_REPO_COMMAND" ]; then
  _arg_index=0
  _skip_value=""
  for _a in "$@"; do
    _arg_index=$((_arg_index + 1))
    [ "$_arg_index" -le 2 ] && continue
    if [ -n "$_skip_value" ]; then
      _skip_value=""
      continue
    fi
    [ "$_a" = "--" ] && break
    case "$_REPO_COMMAND:$_a" in
      clone:-u|clone:--upstream-remote-name|edit:--add-topic|edit:--default-branch|edit:-d|edit:--description|edit:-h|edit:--homepage|edit:--remove-topic|edit:--squash-merge-commit-message|edit:--visibility|fork:--fork-name|fork:--org|fork:--remote-name|sync:-b|sync:--branch|sync:-s|sync:--source|view:-b|view:--branch|view:-q|view:--jq|view:--json|view:-t|view:--template)
        _skip_value=1
        continue
        ;;
    esac
    case "$_a" in
      --*=*|-*) continue ;;
    esac
    case "$_a" in
      */*) _REPO="$_a" ;;
    esac
    break
  done
fi
if [ -z "$_REPO" ]; then _REPO="$GH_REPO"; fi
if [ -z "$_REPO" ]; then
  _REPO=$(git remote get-url origin 2>/dev/null || true)
fi

# Daemon stdout is token-only; errors never permit stored gh authentication.
_TOKEN=$(AGENTCONNECT_ROOT=${q(root)} ${cli} gh-token "$AC_AGENT_ID" "$_REPO")
_RC=$?
if [ "$_RC" -ne 0 ] || [ -z "$_TOKEN" ]; then
  echo "agentconnect: daemon could not provide GitHub credentials; refusing stored gh authentication" >&2
  exit 1
fi
GH_TOKEN="$_TOKEN" exec "$REAL_GH" "$@"

`
  writeFileSync(join(dir, 'gh'), body, { mode: 0o755 })
  return dir
}
