import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import { packageSkillBundle, SkillBundleValidationError } from './skill-bundle.js'

const modulePath = fileURLToPath(new URL('./skill-bundle.ts', import.meta.url))
const packageRoot = fileURLToPath(new URL('../..', import.meta.url))

const manifest = `---
name: deploy-helper
description: Deploy the service safely.
---

# Deploy helper
`

describe('packageSkillBundle', () => {
  it.each(['UTC', 'America/Los_Angeles', 'Pacific/Honolulu', 'Asia/Tokyo', 'Pacific/Kiritimati'])(
    'packages to the same digest under TZ=%s',
    (tz) => {
      // Date's local getters are fixed per process, so each zone needs its own node process
      const script = `
        import { packageSkillBundle } from ${JSON.stringify(modulePath)}
        process.stdout.write(packageSkillBundle(JSON.parse(process.argv[1]), 'deploy-helper').digest)
      `
      const files = [{ path: 'SKILL.md', encoding: 'utf8', content: manifest }]
      const out = execFileSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script, JSON.stringify(files)],
        { env: { ...process.env, TZ: tz }, cwd: packageRoot, encoding: 'utf8' }
      )
      expect(out).toBe(packageSkillBundle(files as never, 'deploy-helper').digest)
    },
    30_000
  )

  it('produces a deterministic official one-root .skill ZIP', () => {
    const files = [
      { path: 'scripts/deploy.sh', encoding: 'utf8' as const, content: '#!/bin/sh\necho deploy\n' },
      { path: 'SKILL.md', encoding: 'utf8' as const, content: manifest }
    ]
    const first = packageSkillBundle(files, 'deploy-helper')
    const second = packageSkillBundle([...files].reverse(), 'deploy-helper')

    expect(first.digest).toBe(second.digest)
    expect(first.manifest).toMatchObject({ name: 'deploy-helper', description: 'Deploy the service safely.' })
    expect(Object.keys(unzipSync(first.archive)).sort()).toEqual([
      'deploy-helper/SKILL.md',
      'deploy-helper/scripts/deploy.sh'
    ])
  })

  it('accepts canonical base64 assets', () => {
    const bundle = packageSkillBundle([
      { path: 'SKILL.md', encoding: 'utf8', content: manifest },
      { path: 'assets/pixel.bin', encoding: 'base64', content: Buffer.from([0, 1, 2, 255]).toString('base64') }
    ])
    expect(bundle.fileCount).toBe(2)
    expect(unzipSync(bundle.archive)['deploy-helper/assets/pixel.bin']).toEqual(new Uint8Array([0, 1, 2, 255]))
  })

  it.each(['../escape', '/absolute', 'scripts\\bad.sh', 'a/../../bad'])('rejects unsafe path %s', (path) => {
    expect(() =>
      packageSkillBundle([
        { path: 'SKILL.md', encoding: 'utf8', content: manifest },
        { path, encoding: 'utf8', content: 'bad' }
      ])
    ).toThrow(SkillBundleValidationError)
  })

  it('bounds paths by encoded bytes rather than JavaScript character count', () => {
    expect(() =>
      packageSkillBundle([
        { path: 'SKILL.md', encoding: 'utf8', content: manifest },
        { path: `assets/${'界'.repeat(90)}.txt`, encoding: 'utf8', content: 'too wide' }
      ])
    ).toThrow('unsafe skill file path')
  })

  it('requires SKILL.md name to match the suggested skill', () => {
    expect(() => packageSkillBundle([{ path: 'SKILL.md', encoding: 'utf8', content: manifest }], 'other')).toThrow(
      'SKILL.md name must match suggestion title'
    )
  })

  it('rejects file/ancestor collisions before producing an uninstallable bundle', () => {
    expect(() =>
      packageSkillBundle([
        { path: 'SKILL.md', encoding: 'utf8', content: manifest },
        { path: 'references/conflict', encoding: 'utf8', content: 'file' },
        { path: 'references/conflict/child.md', encoding: 'utf8', content: 'child' }
      ])
    ).toThrow('collides with a parent file')
  })

  it('uses compressed entry payload bytes for the same ratio gate as the daemon', () => {
    expect(() =>
      packageSkillBundle([
        { path: 'SKILL.md', encoding: 'utf8', content: manifest },
        { path: 'references/repeated.md', encoding: 'utf8', content: 'x'.repeat(66 * 1024) }
      ])
    ).toThrow('suspicious compression ratio')
  })
})
