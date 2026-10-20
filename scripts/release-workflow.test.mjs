import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { parse } from 'yaml'

const workflowDirectory = new URL('../.github/workflows/', import.meta.url)
const workflows = Object.fromEntries(
  readdirSync(workflowDirectory)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => [name, parse(readFileSync(new URL(name, workflowDirectory), 'utf8'))])
)

test('release tags and release records cannot trigger another workflow run', () => {
  for (const [name, workflow] of Object.entries(workflows)) {
    const events = workflow.on
    assert.equal(typeof events, 'object', name)
    assert.ok(!Array.isArray(events), name)
    for (const event of ['create', 'release', 'workflow_run']) assert.ok(!(event in events), `${name}: ${event}`)
    if ('push' in events) {
      assert.ok(events.push?.branches?.length, `${name}: push must select branches explicitly`)
      assert.equal(events.push.tags, undefined, name)
    }
  }
})

test(
  'hook installation leaves CI alone and still installs hooks in a local clone',
  { skip: process.platform === 'win32' },
  (t) => {
    const repo = mkdtempSync(join(tmpdir(), 'ac-release-hooks-'))
    t.after(() => rmSync(repo, { recursive: true, force: true }))
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim()
    git('-c', 'init.templateDir=', 'init', '--quiet')
    const configPath = join(repo, '.git/config')
    const before = readFileSync(configPath, 'utf8')
    const script = fileURLToPath(new URL('setup-hooks.sh', import.meta.url))
    execFileSync('sh', [script], { cwd: repo, env: { ...env, CI: 'true' } })
    assert.equal(readFileSync(configPath, 'utf8'), before)
    execFileSync('sh', [script], { cwd: repo, env: { ...env, CI: '' } })
    assert.equal(git('config', '--local', '--get', 'core.hooksPath'), '.github/.githooks')
  }
)
