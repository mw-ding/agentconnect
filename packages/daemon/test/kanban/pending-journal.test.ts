import { mkdtempSync, readFileSync, rmSync, writeFileSync, fsyncSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { loadPendingJournal, savePendingJournal } from '../../src/kanban/pending-journal.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), renameSync: vi.fn(actual.renameSync) }
})
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.clearAllMocks()
})
function journal() {
  const root = mkdtempSync(join(tmpdir(), 'ac-vera-journal-'))
  roots.push(root)
  return join(root, 'pending.json')
}

it('vera-349: fsyncs the file before rename and the directory afterwards', () => {
  const path = journal()
  savePendingJournal(path, new Map([['key', { issueNumber: 42, filedAt: Date.now() }]]))
  expect(JSON.parse(readFileSync(path, 'utf8')).key.issueNumber).toBe(42)
  const syncs = vi.mocked(fsyncSync).mock.invocationCallOrder
  const rename = vi.mocked(renameSync).mock.invocationCallOrder[0]!
  expect(syncs).toHaveLength(process.platform === 'win32' ? 1 : 2)
  expect(syncs[0]).toBeLessThan(rename)
  if (process.platform !== 'win32') expect(syncs[1]).toBeGreaterThan(rename)
})

it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '42', null])(
  'vera-349: rejects an invalid filed issue number %s',
  (issueNumber) => {
    const path = journal()
    writeFileSync(path, JSON.stringify({ key: { issueNumber, filedAt: Date.now() } }))
    expect(loadPendingJournal(path).size).toBe(0)
  }
)

it('vera-349: accepts only complete intents and past timestamps with small clock skew', () => {
  const path = journal()
  const now = Date.now()
  writeFileSync(
    path,
    JSON.stringify({
      good: { issueNumber: 42, filedAt: now },
      intent: { issueNumber: null, startedAt: now },
      futureFile: { issueNumber: 43, filedAt: now + 600_000 },
      futureIntent: { issueNumber: null, startedAt: now + 600_000 },
      noTime: { issueNumber: null },
      ambiguous: { issueNumber: null, filedAt: now }
    })
  )
  expect([...loadPendingJournal(path).keys()]).toEqual(['good', 'intent'])
})

it('vera-349: strips unknown journal fields and rejects future timestamps on either entry kind', () => {
  const path = journal()
  const now = Date.now()
  writeFileSync(
    path,
    JSON.stringify({
      safe: { issueNumber: 42, filedAt: now, title: 'never retain text', body: 'private' },
      futureStart: { issueNumber: 43, filedAt: now, startedAt: now + 600_000 },
      futureFile: { issueNumber: null, startedAt: now, filedAt: now + 600_000 }
    })
  )
  const pending = loadPendingJournal(path)
  expect([...pending.keys()]).toEqual(['safe'])
  expect(pending.get('safe')).toEqual({ issueNumber: 42, filedAt: now })
})
