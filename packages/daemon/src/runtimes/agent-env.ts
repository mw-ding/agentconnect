import { CLAUDE_MODEL_ALIAS_ENV } from './model-provider-config.js'

export const CERTIFICATE_ENV_KEYS = new Set([
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  // A probe may fetch through git; the same operator bundle has to reach it (§24.5).
  'GIT_SSL_CAINFO'
])

export const PROVIDER_ENV_KEYS = new Set([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_IDENTITY_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'META_API_KEY',
  'KIRO_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  // The OpenClaw acp bridge's gateway connection overrides — credentials for a
  // host configured via env instead of ~/.openclaw/openclaw.json.
  'OPENCLAW_GATEWAY_URL',
  'OPENCLAW_GATEWAY_TOKEN',
  'OPENCLAW_GATEWAY_PASSWORD',
  // Claude's alias→model declarations. A real launch inherits these from the host environment;
  // without them here the probe would read a picker the sessions do not have.
  ...CLAUDE_MODEL_ALIAS_ENV
])

export const AMBIENT_STATE_ENV = new Set([
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'MUSE_PROJECTS_HOME',
  'MUSE_SESSIONS',
  'MUSE_AUTH_PATH',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'COPILOT_HOME',
  'GEMINI_HOME',
  'CURSOR_CONFIG_DIR',
  'HERMES_HOME',
  'INTERPRETER_HOME',
  'KIRO_HOME',
  'ZEROCLAW_CONFIG_DIR',
  'ZEROCLAW_DATA_DIR',
  'AMP_SETTINGS_FILE',
  'PI_CODING_AGENT_DIR',
  'GROK_HOME',
  'GROK_AUTH_PATH',
  'QWEN_HOME',
  'QWEN_RUNTIME_DIR',
  'CLINE_DIR',
  'CLINE_DATA_DIR',
  'CLINE_PROVIDER_SETTINGS_PATH',
  'KIMI_CODE_HOME',
  'KIMI_SHARE_DIR',
  // Qoder (a Gemini-CLI fork) resolves its config + agents dirs from these; drop
  // the host values so the child falls back to the private HOME. Covers both the
  // international and CN brands plus the shared Gemini fallback.
  'QODER_CONFIG_DIR',
  'QODER_CLI_HOME',
  'QODERCN_CONFIG_DIR',
  'QODERCN_CLI_HOME',
  'GEMINI_CLI_HOME',
  // DeepSeek Harness state root; $DSH_PATH (the harness install location) is not
  // user state and stays inherited.
  'DSH_HOME',
  // OpenClaw state/config roots. The gateway connection overrides
  // ($OPENCLAW_GATEWAY_URL/_TOKEN/_PASSWORD) are credentials, not state — inherited.
  'OPENCLAW_HOME',
  'OPENCLAW_STATE_DIR',
  'OPENCLAW_CONFIG_PATH'
])

/** Names (upper-cased) every agent process may inherit: the process basics, locale, temp dirs, XDG roots and toolchain homes. */
const BASE_ENV = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TZ',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_DIRS',
  'XDG_DATA_DIRS',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'USERNAME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'HOMEDRIVE',
  'HOMEPATH',
  'SYSTEMDRIVE',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'NODE_USE_ENV_PROXY',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'GOPATH',
  'GOROOT',
  'GOBIN',
  'JAVA_HOME',
  'NVM_DIR',
  'VOLTA_HOME',
  'PNPM_HOME',
  'BUN_INSTALL',
  'PYENV_ROOT',
  'DSH_PATH'
])
/** Prefix families that configure the agent runtimes themselves (provider endpoints, keys, state roots). */
const RUNTIME_ENV_PREFIXES = ['LC_', 'ANTHROPIC_', 'OPENAI_', 'CLAUDE_', 'CODEX_', 'GEMINI_', 'DEEPSEEK_']

/**
 * The ambient environment an agent process inherits from the daemon: an explicit allowlist, so a
 * daemon-side secret (database URL, cloud keys, app private keys, relay token) never reaches an agent.
 * Per-agent configured env and injected AC_* variables are added explicitly by the caller.
 */
export function agentBaseEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    const upper = name.toUpperCase()
    if (
      BASE_ENV.has(upper) ||
      AMBIENT_STATE_ENV.has(name) ||
      CERTIFICATE_ENV_KEYS.has(name) ||
      PROVIDER_ENV_KEYS.has(name) ||
      /^(?:https?|all|no)_proxy$/i.test(name) ||
      RUNTIME_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      env[name] = value
    }
  }
  return env
}
