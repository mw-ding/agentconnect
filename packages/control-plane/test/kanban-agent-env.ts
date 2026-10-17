// Env handed to a Kanban e2e agent. Explicit allowlist: nothing the process inherited reaches the adapter unless named here.

const ALLOWED_AGENT_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TZ',
  'LANG',
  'LANGUAGE',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  // Model-provider auth and config the claude/codex adapters genuinely need.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_HOME'
])

const ALLOWED_AGENT_ENV_PREFIXES = ['LC_', 'XDG_']

export function isAllowedAgentEnvKey(key: string): boolean {
  return ALLOWED_AGENT_ENV_KEYS.has(key) || ALLOWED_AGENT_ENV_PREFIXES.some((p) => key.startsWith(p))
}

export function isLeakedAgentEnvKey(key: string): boolean {
  return !isAllowedAgentEnvKey(key)
}

/** Copy only allowlisted keys of `env`; anything else the process inherited is dropped. */
export function stripLeakedAgentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) if (isAllowedAgentEnvKey(key)) next[key] = value
  return next
}
