import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { attestHumanAuthority, isAttestedHumanAuthority, type KanbanHumanAuthority } from './human-authority.js'

describe('human authority provenance', () => {
  it('attests only the frozen original, never a literal, spread, JSON, or prototype copy', () => {
    const authority = attestHumanAuthority('alice', 'write')
    expect(isAttestedHumanAuthority(authority)).toBe(true)
    expect(Object.isFrozen(authority)).toBe(true)
    // @ts-expect-error -- an authority literal lacks the module-private type brand.
    const forged: KanbanHumanAuthority = { login: 'alice', permission: 'admin' }
    for (const value of [
      forged,
      { ...authority },
      JSON.parse(JSON.stringify(authority)),
      Object.create(authority),
      null,
      'alice'
    ]) {
      expect(isAttestedHumanAuthority(value)).toBe(false)
    }
    expect(() => Object.assign(authority, { permission: 'admin' })).toThrow(TypeError)
  })

  it('limits production minter references to the importer and authority module', async () => {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const files = await readdir(root, { recursive: true })
    const references: string[] = []
    for (const file of files) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file.startsWith('generated/')) continue
      if (/\battestHumanAuthority\b/.test(await readFile(`${root}/${file}`, 'utf8'))) references.push(file)
    }
    expect(references.sort()).toEqual(['kanban/human-authority.ts', 'kanban/importer.ts'])
  })
})
