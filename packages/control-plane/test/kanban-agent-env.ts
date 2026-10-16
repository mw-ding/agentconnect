// Env handed to a Kanban e2e agent. Strips credentials the process inherited so the adapter never sees them.

/** Existing token names, plus App material, private keys, and webhook secrets. */
const LEAKED_AGENT_ENV_KEY =
  /^(?:GH|GITHUB)_(?:.*_)?(?:TOKEN|PAT|AUTH_TOKEN)$|^GH_CONFIG_DIR$|^CLAUDECODE$|^AC_GITCRED_|GITHUB_APP_|PRIVATE_KEY|WEBHOOK_SECRET|_SECRET/i

export function isLeakedAgentEnvKey(key: string): boolean {
  return LEAKED_AGENT_ENV_KEY.test(key)
}

/** Copy `env` with leaked credential keys removed. */
export function stripLeakedAgentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env }
  for (const key of Object.keys(next)) if (isLeakedAgentEnvKey(key)) delete next[key]
  return next
}
