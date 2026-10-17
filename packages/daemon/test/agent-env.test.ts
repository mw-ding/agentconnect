import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
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

describe('agentBaseEnvironment families', () => {
  it.each([
    ['a *_PASSWORD', 'DB_PASSWORD'],
    ['a *_SECRET', 'STRIPE_SECRET'],
    ['a *_TOKEN', 'NPM_TOKEN'],
    ['a non-provider *_API_KEY', 'DATADOG_API_KEY'],
    ['an AWS_* credential', 'AWS_SESSION_TOKEN'],
    ['an AWS_* profile', 'AWS_PROFILE'],
    ['a GitHub token', 'GITHUB_TOKEN'],
    ['a gh token', 'GH_TOKEN'],
    ['an ssh agent socket', 'SSH_AUTH_SOCK'],
    ['a kube config', 'KUBECONFIG'],
    ['a daemon credential', 'AC_DAEMON_TOKEN'],
    ['an ambient AC_* variable', 'AC_AGENT_ID'],
    ['a relay setting', 'RELAY_URL'],
    ['a name that only contains an allowlisted one', 'MY_PATH'],
    ['a look-alike prefix without the underscore', 'LCX_ALL'],
    ['a prefix family lacking its separator', 'ANTHROPICKEY']
  ])('drops %s (%s)', (_label, name) => {
    expect(agentBaseEnvironment({ [name]: 'planted', PATH: '/bin' })).toEqual({ PATH: '/bin' })
  })

  it.each([
    'LC_ALL',
    'LC_CTYPE',
    'LC_MESSAGES',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_FOO',
    'OPENAI_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CODEX_HOME',
    'GEMINI_API_KEY',
    'HTTP_PROXY',
    'https_proxy',
    'NO_PROXY',
    'all_proxy',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
    'GOPATH',
    'XDG_RUNTIME_DIR'
  ])('passes %s', (name) => {
    expect(agentBaseEnvironment({ [name]: 'v' })).toEqual({ [name]: 'v' })
  })

  it('skips undefined values and tolerates an empty source', () => {
    expect(agentBaseEnvironment({ PATH: undefined, HOME: '/h' })).toEqual({ HOME: '/h' })
    expect(agentBaseEnvironment({})).toEqual({})
  })

  it('keeps every Windows-cased process key and drops a Windows-cased secret', () => {
    const keys = [
      'Path',
      'PATHEXT',
      'SystemRoot',
      'ComSpec',
      'Temp',
      'Tmp',
      'UserProfile',
      'AppData',
      'ProgramFiles(x86)'
    ]
    const source = Object.fromEntries(keys.map((key) => [key, 'v']))
    expect(agentBaseEnvironment({ ...source, Database_Url: 'x', Pgpassword: 'y' })).toEqual(source)
  })

  it('does not mutate the source environment', () => {
    const source = { ...ALLOWED, ...SECRETS }
    const before = { ...source }
    agentBaseEnvironment(source)
    expect(source).toEqual(before)
  })
})

describe('runtimeHomeEnvironment', () => {
  it('lets explicit env override the host env but pins the private HOME', () => {
    const env = runtimeHomeEnvironment('x', '/h', { LANG: 'C.UTF-8', HOME: '/evil' }, { ...ALLOWED, ...SECRETS })
    expect(env.LANG).toBe('C.UTF-8')
    expect(env.HOME).toBe('/h')
    expect(env.XDG_CONFIG_HOME).toBe(join('/h', '.config'))
  })

  it('drops host state roots and npm config overrides that would defeat HOME isolation', () => {
    const env = runtimeHomeEnvironment(
      'x',
      '/h',
      {},
      {
        ...ALLOWED,
        XDG_DATA_HOME: '/host/share',
        CODEX_HOME: '/host/codex',
        NPM_CONFIG_USERCONFIG: '/host/npmrc',
        npm_config_cache: '/host/cache'
      }
    )
    expect(env.XDG_DATA_HOME).toBe(join('/h', '.local', 'share'))
    expect(env).not.toHaveProperty('CODEX_HOME')
    expect(env).not.toHaveProperty('NPM_CONFIG_USERCONFIG')
    expect(env).not.toHaveProperty('npm_config_cache')
  })
})

describe('runtimeHomeEnvironment, planted secrets', () => {
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

  const launchEnv = async (opts: {
    runtimeEnv?: Array<{ name: string; value: string }>
    env?: Record<string, string>
    inherit?: boolean
  }) => {
    let request: SpawnRequest | undefined
    const host = new AcpHost(
      { command: 'noop', args: [], env: opts.runtimeEnv ?? [] },
      {
        onUpdate: () => {},
        env: opts.env ?? {},
        ...(opts.inherit === false ? { inheritProcessEnv: false } : {}),
        driver: {
          launch: async (req) => {
            request = req
            throw new Error('captured')
          }
        }
      }
    )
    await expect(host.start()).rejects.toThrow('captured')
    return request!.env
  }

  it('lets the runtime env override the ambient env, and the agent env override the runtime env', async () => {
    Object.assign(process.env, ALLOWED)
    const env = await launchEnv({
      runtimeEnv: [
        { name: 'LANG', value: 'runtime-lang' },
        { name: 'TZ', value: 'runtime-tz' }
      ],
      env: { TZ: 'agent-tz' }
    })
    expect(env.LANG).toBe('runtime-lang')
    expect(env.TZ).toBe('agent-tz')
    expect(env.PATH).toBe(process.env.PATH)
  })

  it('injects AC_* only from the explicit env, never from the ambient env', async () => {
    Object.assign(process.env, { AC_AGENT_ID: 'ambient', AC_DAEMON_TOKEN: 'ambient-token' })
    const env = await launchEnv({ env: { AC_AGENT_ID: 'explicit' } })
    expect(env.AC_AGENT_ID).toBe('explicit')
    expect(env).not.toHaveProperty('AC_DAEMON_TOKEN')
  })

  it('keeps no ambient variable when the launch does not inherit the process env', async () => {
    Object.assign(process.env, ALLOWED, SECRETS)
    const env = await launchEnv({ inherit: false, env: { AC_AGENT_ID: 'a' } })
    expect(env.AC_AGENT_ID).toBe('a')
    expect(env).not.toHaveProperty('HOME', ALLOWED.HOME)
    for (const name of Object.keys(SECRETS)) expect(env).not.toHaveProperty(name)
  })

  it('still strips a human GitHub token that arrives through the explicit env', async () => {
    Object.assign(process.env, { GITHUB_TOKEN: 'ambient' })
    const env = await launchEnv({ env: { GH_TOKEN: 'explicit', GITHUB_TOKEN: 'explicit', KEEP: 'yes' } })
    expect(env).not.toHaveProperty('GH_TOKEN')
    expect(env).not.toHaveProperty('GITHUB_TOKEN')
    expect(env.KEEP).toBe('yes')
  })
})

// Exercise the production HOME/env builder across an actual OS process boundary.
describe('real child environment integration', () => {
  it('never passes planted daemon credentials or the agent GitHub token to a real child', async () => {
    const saved = { ...process.env }
    try {
      Object.assign(process.env, SECRETS, { GITHUB_TOKEN: 'planted-agent-token', GH_TOKEN: 'planted-gh-token' })
      const env = runtimeHomeEnvironment('x', '/tmp/kanban-env-child', { AC_AGENT_ID: 'explicit-agent' })
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['-e', 'console.log(JSON.stringify(process.env))'],
        {
          env,
          timeout: 15_000
        }
      )
      const actual = JSON.parse(stdout) as Record<string, string>
      for (const name of [...Object.keys(SECRETS), 'GITHUB_TOKEN', 'GH_TOKEN']) expect(actual).not.toHaveProperty(name)
      expect(actual.AC_AGENT_ID).toBe('explicit-agent')
      expect(actual.HOME).toBe('/tmp/kanban-env-child')
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
      Object.assign(process.env, saved)
    }
  })
})
