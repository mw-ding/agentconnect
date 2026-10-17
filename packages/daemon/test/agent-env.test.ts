import { afterEach, describe, expect, it } from 'vitest'
import { AcpHost } from '../src/acp/acp-host.js'
import type { SpawnRequest } from '../src/acp/spawn-driver.js'
import { agentBaseEnvironment } from '../src/runtimes/agent-env.js'
import { runtimeHomeEnvironment } from '../src/runtimes/runtime-home.js'

const SECRETS = {
  DATABASE_URL: 'postgres://u:p@db/x',
  PGPASSWORD: 'pg-secret',
  FOO_PASSWORD: 'foo-secret',
  AWS_ACCESS_KEY_ID: 'AKIAPLANTED',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  GITHUB_APP_PRIVATE_KEY_B64: 'pem-b64',
  GITHUB_APP_WEBHOOK_SECRET: 'whsec',
  RELAY_TOKEN: 'relay-secret'
}
const ALLOWED = {
  PATH: '/usr/bin',
  HOME: '/home/u',
  USER: 'u',
  LOGNAME: 'u',
  SHELL: '/bin/sh',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'C',
  TERM: 'xterm',
  TMPDIR: '/tmp',
  TZ: 'UTC',
  HTTPS_PROXY: 'http://proxy',
  ANTHROPIC_API_KEY: 'anthropic-key'
}

describe('agentBaseEnvironment', () => {
  it('passes allowlisted variables and drops planted daemon secrets', () => {
    const env = agentBaseEnvironment({ ...ALLOWED, ...SECRETS, RANDOM_AMBIENT: 'x' })
    expect(env).toEqual(ALLOWED)
    for (const name of Object.keys(SECRETS)) expect(env).not.toHaveProperty(name)
  })

  it('keeps Windows-cased process keys', () => {
    expect(agentBaseEnvironment({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows', DATABASE_URL: 'x' })).toEqual({
      Path: 'C:\\bin',
      SystemRoot: 'C:\\Windows'
    })
  })
})

describe('runtimeHomeEnvironment', () => {
  it('drops planted secrets from the host env but keeps explicit env', () => {
    const env = runtimeHomeEnvironment(
      'x',
      '/h',
      { AC_AGENT_ID: 'a', MY_TOKEN: 'explicit' },
      { ...ALLOWED, ...SECRETS }
    )
    for (const name of Object.keys(SECRETS)) expect(env).not.toHaveProperty(name)
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      AC_AGENT_ID: 'a',
      MY_TOKEN: 'explicit',
      HOME: '/h'
    })
  })
})

describe('AcpHost spawn environment', () => {
  const saved = { ...process.env }
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
    Object.assign(process.env, saved)
  })

  it('hands the driver an allowlisted ambient env plus the explicit runtime and agent env', async () => {
    Object.assign(process.env, ALLOWED, SECRETS)
    let request: SpawnRequest | undefined
    const host = new AcpHost(
      { command: 'noop', args: [], env: [{ name: 'RUNTIME_VAR', value: 'rt' }] },
      {
        onUpdate: () => {},
        env: { AC_AGENT_ID: 'agent-1', AGENT_SECRET: 'configured' },
        driver: {
          launch: async (req) => {
            request = req
            throw new Error('captured')
          }
        }
      }
    )
    await expect(host.start()).rejects.toThrow('captured')
    const env = request!.env
    for (const name of Object.keys(SECRETS)) expect(env).not.toHaveProperty(name)
    expect(env).toMatchObject({
      PATH: process.env.PATH,
      HOME: ALLOWED.HOME,
      LANG: ALLOWED.LANG,
      RUNTIME_VAR: 'rt',
      AC_AGENT_ID: 'agent-1',
      AGENT_SECRET: 'configured'
    })
  })
})
