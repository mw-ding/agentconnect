import { describe, expect, it } from 'vitest'
import { isAllowedAgentEnvKey, isLeakedAgentEnvKey, stripLeakedAgentEnv } from './kanban-agent-env.js'

describe('stripLeakedAgentEnv', () => {
  it('drops planted credentials and unknown vars, keeps allowlisted ones', () => {
    const env = stripLeakedAgentEnv({
      PATH: '/usr/bin',
      HOME: '/home/x',
      LANG: 'C.UTF-8',
      LC_ALL: 'C',
      TERM: 'xterm',
      XDG_CONFIG_HOME: '/cfg',
      ANTHROPIC_API_KEY: 'sk-ant',
      OPENAI_API_KEY: 'sk-oai',
      NODE_OPTIONS: '--conditions=development',
      DATABASE_URL: 'postgres://u:p@h/db',
      PGPASSWORD: 'pg',
      FOO_PASSWORD: 'pw',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      AWS_ACCESS_KEY_ID: 'AKIA',
      AWS_SESSION_TOKEN: 'tok',
      GITHUB_APP_PRIVATE_KEY_B64: 'sentinel-private-key',
      GITHUB_APP_ID: '123',
      GITHUB_TOKEN: 'ghp_token',
      GH_TOKEN: 'ghs_token',
      GH_CONFIG_DIR: '/tmp/gh',
      API_SECRET: 'sek',
      WEBHOOK_SECRET: 'whsec',
      CLAUDECODE: '1',
      AC_GITCRED_SOCKET: '/tmp/sock',
      SAFE_MODE: '1'
    })
    for (const key of [
      'DATABASE_URL',
      'PGPASSWORD',
      'FOO_PASSWORD',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_ACCESS_KEY_ID',
      'AWS_SESSION_TOKEN',
      'GITHUB_APP_PRIVATE_KEY_B64',
      'GITHUB_APP_ID',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'GH_CONFIG_DIR',
      'API_SECRET',
      'WEBHOOK_SECRET',
      'CLAUDECODE',
      'AC_GITCRED_SOCKET',
      'SAFE_MODE'
    ])
      expect(env[key], key).toBeUndefined()
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/x',
      LANG: 'C.UTF-8',
      LC_ALL: 'C',
      TERM: 'xterm',
      XDG_CONFIG_HOME: '/cfg',
      ANTHROPIC_API_KEY: 'sk-ant',
      OPENAI_API_KEY: 'sk-oai',
      NODE_OPTIONS: '--conditions=development'
    })
    expect(Object.keys(env).some(isLeakedAgentEnvKey)).toBe(false)
    expect(isAllowedAgentEnvKey('DATABASE_URL')).toBe(false)
  })
})
