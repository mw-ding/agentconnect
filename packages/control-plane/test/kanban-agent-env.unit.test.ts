import { describe, expect, it } from 'vitest'
import { isLeakedAgentEnvKey, stripLeakedAgentEnv } from './kanban-agent-env.js'

describe('stripLeakedAgentEnv', () => {
  it('removes GitHub App material, private keys, and webhook secrets', () => {
    const env = stripLeakedAgentEnv({
      PATH: '/usr/bin',
      SAFE_MODE: '1',
      GITHUB_APP_PRIVATE_KEY_B64: 'sentinel-private-key',
      GITHUB_APP_ID: '123',
      GITHUB_APP_SLUG: 'agentconnect',
      GITHUB_APP_WEBHOOK_SECRET: 'whsec-app',
      GITHUB_TOKEN: 'ghp_token',
      GH_TOKEN: 'ghs_token',
      GH_CONFIG_DIR: '/tmp/gh',
      MY_PRIVATE_KEY: 'pk',
      API_SECRET: 'sek',
      WEBHOOK_SECRET: 'whsec',
      SOMETHING_WEBHOOK_SECRET_VALUE: 'whsec-2',
      CLAUDECODE: '1',
      AC_GITCRED_SOCKET: '/tmp/sock'
    })
    expect(env.GITHUB_APP_PRIVATE_KEY_B64).toBeUndefined()
    expect(env.GITHUB_APP_ID).toBeUndefined()
    expect(env.GITHUB_APP_WEBHOOK_SECRET).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.MY_PRIVATE_KEY).toBeUndefined()
    expect(env.API_SECRET).toBeUndefined()
    expect(env.WEBHOOK_SECRET).toBeUndefined()
    expect(env.SOMETHING_WEBHOOK_SECRET_VALUE).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    expect(env.SAFE_MODE).toBe('1')
    expect(Object.keys(env).filter(isLeakedAgentEnvKey)).toEqual([])
  })
})
