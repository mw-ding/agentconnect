import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ghShimDir, writeGhShim } from '../../src/cp/gh-shim.js'

describe('gh wrapper shim', () => {
  let root: string | undefined

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('routes a gh repo positional argument after value flags to that repository token', () => {
    root = mkdtempSync(join(tmpdir(), 'gh-shim-'))
    const realBin = join(root, 'real-bin')
    const repoCapture = join(root, 'repo.txt')
    const capabilityCapture = join(root, 'capability.txt')
    const tokenCapture = join(root, 'token.txt')
    const cliEntry = join(root, 'fake-cli.mjs')
    mkdirSync(realBin)

    writeFileSync(
      cliEntry,
      `import { writeFileSync } from 'node:fs'\n` +
        `writeFileSync(process.env.REPO_CAPTURE, process.argv[4] ?? '')\n` +
        `writeFileSync(process.env.CAPABILITY_CAPTURE, process.env.AC_GITCRED_CAPABILITY ?? '')\n` +
        `process.stdout.write('token-for-' + (process.argv[4] ?? 'workspace'))\n`
    )
    const realGh = join(realBin, 'gh')
    writeFileSync(realGh, `#!/bin/sh\nprintf '%s|%s' "$GH_TOKEN" "$GH_ENTERPRISE_TOKEN" > "$TOKEN_CAPTURE"\n`)
    chmodSync(realGh, 0o755)

    const shimDir = ghShimDir(root)
    const shim = join(writeGhShim(root, cliEntry), 'gh')
    execFileSync(shim, ['repo', 'view', '--json', 'nameWithOwner', 'acme/infra'], {
      env: {
        ...process.env,
        GH_TOKEN: '',
        GITHUB_TOKEN: '',
        GH_ENTERPRISE_TOKEN: '',
        GITHUB_ENTERPRISE_TOKEN: '',
        PATH: `${shimDir}:${realBin}`,
        AC_AGENT_ID: 'agent-1',
        AC_GITCRED_CAPABILITY: 'cap-agent-1',
        REPO_CAPTURE: repoCapture,
        CAPABILITY_CAPTURE: capabilityCapture,
        TOKEN_CAPTURE: tokenCapture
      }
    })

    expect(readFileSync(repoCapture, 'utf8')).toBe('acme/infra')
    expect(readFileSync(capabilityCapture, 'utf8')).toBe('cap-agent-1')
    expect(readFileSync(tokenCapture, 'utf8')).toBe('token-for-acme/infra|')
  })
  it.each([
    { name: 'inherited GH_TOKEN', env: { GH_TOKEN: 'human' }, exit: 0, token: 'app' },
    { name: 'inherited enterprise token', env: { GITHUB_ENTERPRISE_TOKEN: 'human' }, exit: 0, token: 'app' },
    { name: 'missing agent id', env: { AC_AGENT_ID: '' }, exit: 0, token: 'app' },
    { name: 'daemon refusal', env: {}, exit: 1, token: '' },
    { name: 'non-GitHub target', env: {}, exit: 2, token: '' },
    { name: 'empty daemon response', env: {}, exit: 0, token: '' },
    { name: 'token with failing response', env: {}, exit: 1, token: 'app' }
  ])('fails closed with $name without invoking stored human gh auth', ({ env, exit, token }) => {
    root = mkdtempSync(join(tmpdir(), 'gh-shim-'))
    const realBin = join(root, 'real-bin')
    mkdirSync(realBin)
    const invoked = join(root, 'invoked')
    const realGh = join(realBin, 'gh')
    writeFileSync(realGh, `#!/bin/sh\nprintf invoked > '${invoked}'\n`)
    chmodSync(realGh, 0o755)
    const cliEntry = join(root, 'fake-cli.mjs')
    writeFileSync(cliEntry, `process.stdout.write(${JSON.stringify(token)}); process.exit(${exit})`)
    const shimDir = writeGhShim(root, cliEntry)
    const result = spawnSync(join(shimDir, 'gh'), ['repo', 'view', 'acme/web'], {
      encoding: 'utf8',
      env: { PATH: `${shimDir}:${realBin}`, AC_AGENT_ID: 'agent-1', ...env }
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/agentconnect: .*credential|agentconnect: refusing inherited GitHub token/)
    expect(existsSync(invoked)).toBe(false)
  })

  it.each([
    { name: '--hostname flag', args: ['api', '--hostname', 'attacker.example.com', '/user'], env: {}, ok: false },
    { name: '--hostname= flag', args: ['api', '--hostname=attacker.example.com', '/user'], env: {}, ok: false },
    { name: 'GH_HOST', args: ['api', '/user'], env: { GH_HOST: 'attacker.example.com' }, ok: false },
    {
      name: 'github.com host',
      args: ['api', '--hostname', 'github.com', '/user'],
      env: { GH_HOST: 'GitHub.com' },
      ok: true
    },
    {
      name: 'a github.com decoy inside --raw-field after the real flag',
      args: ['api', '--hostname', 'attacker.example.com', '--raw-field', '--hostname=github.com', '/user'],
      env: {},
      ok: false
    },
    {
      name: 'a github.com decoy inside -f before the real flag',
      args: ['api', '-f', '--hostname=github.com', '--hostname=attacker.example.com', '/user'],
      env: {},
      ok: false
    },
    {
      name: 'a repeated real flag',
      args: ['api', '--hostname', 'attacker.example.com', '--hostname', 'github.com', '/user'],
      env: {},
      ok: false
    },
    { name: 'an empty real flag', args: ['api', '--hostname=', '/user'], env: {}, ok: false },
    {
      name: 'a boolean shorthand before the real flag',
      args: ['api', '-i', '--hostname', 'attacker.example.com', '/user'],
      env: {},
      ok: false
    },
    {
      name: 'a boolean long flag before the real flag',
      args: ['api', '--paginate', '--hostname', 'attacker.example.com', '/user'],
      env: {},
      ok: false
    },
    {
      name: 'the real flag before the command name',
      args: ['--hostname', 'attacker.example.com', 'api', '/user'],
      env: {},
      ok: false
    },
    { name: 'auth -h', args: ['auth', 'status', '-h', 'attacker.example.com'], env: {}, ok: false },
    { name: 'auth -h=', args: ['auth', 'token', '-h=attacker.example.com'], env: {}, ok: false },
    { name: 'auth grouped -ih', args: ['auth', 'login', '-ih', 'attacker.example.com'], env: {}, ok: false },
    { name: 'auth attached -h', args: ['auth', 'status', '-hattacker.example.com'], env: {}, ok: false },
    {
      name: 'auth boolean -f before the real flag',
      args: ['auth', 'setup-git', '-f', '--hostname', 'attacker.example.com'],
      env: {},
      ok: false
    },
    {
      name: 'hostname text inside --raw-field',
      args: ['api', '--raw-field', '--hostname=attacker.example.com', '/user'],
      env: {},
      ok: true
    },
    {
      name: 'hostname text inside -f, -F, -H, -q, --jq, --input, -t',
      args: [
        'api',
        '-f',
        '--hostname=attacker.example.com',
        '-F',
        '--hostname',
        '-H',
        '--hostname=attacker.example.com',
        '-q',
        '--hostname',
        '--jq',
        '--hostname=attacker.example.com',
        '--input',
        '--hostname',
        '-t',
        '--hostname',
        '/user'
      ],
      env: {},
      ok: true
    },
    {
      name: 'a flag value that is the bare flag name',
      args: ['api', '-f', '--hostname', 'x=1', '/user'],
      env: {},
      ok: true
    },
    {
      name: 'an attached shorthand value',
      args: ['api', '-f--hostname=attacker.example.com', '/user'],
      env: {},
      ok: true
    },
    {
      name: 'an inline long value',
      args: ['api', '--field=--hostname=attacker.example.com', '/user'],
      env: {},
      ok: true
    },
    {
      name: 'positional text after the -- terminator',
      args: ['api', '/user', '--', '--hostname', 'attacker.example.com'],
      env: {},
      ok: true
    },
    {
      name: 'hostname text inside another command flag value',
      args: ['issue', 'comment', '5', '--body', '--hostname=attacker.example.com'],
      env: {},
      ok: true
    },
    { name: '-h is help outside auth', args: ['api', '-h', 'attacker.example.com'], env: {}, ok: true }
  ])('scopes the daemon token to github.com ($name)', ({ args, env, ok }) => {
    root = mkdtempSync(join(tmpdir(), 'gh-shim-'))
    const realBin = join(root, 'real-bin')
    mkdirSync(realBin)
    const capture = join(root, 'capture')
    const realGh = join(realBin, 'gh')
    writeFileSync(realGh, `#!/bin/sh\nprintf '%s|%s' "$GH_TOKEN" "$GH_ENTERPRISE_TOKEN" > '${capture}'\n`)
    chmodSync(realGh, 0o755)
    const cliEntry = join(root, 'fake-cli.mjs')
    writeFileSync(cliEntry, `process.stdout.write('app')`)
    const shimDir = writeGhShim(root, cliEntry)
    const result = spawnSync(join(shimDir, 'gh'), args, {
      encoding: 'utf8',
      env: { PATH: `${shimDir}:${realBin}`, AC_AGENT_ID: 'agent-1', GH_REPO: 'acme/web', ...env }
    })
    if (ok) {
      expect(result.status).toBe(0)
      expect(readFileSync(capture, 'utf8')).toBe('app|')
    } else {
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/limited to github\.com/)
      expect(existsSync(capture)).toBe(false)
    }
  })
})
