import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const docUrl = new URL('../docs/crew/pipeline.md', import.meta.url)
const headings = [
  'Overview',
  'Stages',
  'Roles',
  'Labels',
  'Steering commands',
  'Merge gate',
  'Evidence',
  'Outside contributors'
]
const labels = [
  'crew:ready',
  'crew:in-review',
  'crew:changes',
  'crew:approved',
  'crew:escalated',
  'crew:hold',
  'crew:external',
  'crew:spec'
]
const commands = ['hold', 'resume', 'rework', 'rereview', 'merge-ok', 'escalate']

test('crew pipeline contributor documentation exists', () => {
  assert.ok(existsSync(docUrl), 'docs/crew/pipeline.md must exist')
})

test('crew pipeline headings match the required order', () => {
  const doc = readFileSync(docUrl, 'utf8')
  const actual = [...doc.matchAll(/^## (.+)$/gm)].map((match) => match[1])
  assert.deepEqual(actual, headings)
})

test('crew pipeline mentions exactly the canonical eight labels', () => {
  const doc = readFileSync(docUrl, 'utf8')
  const actual = new Set(doc.match(/\bcrew:[\w-]+/g) ?? [])
  assert.deepEqual(actual, new Set(labels))
})

test('crew pipeline mentions exactly the canonical six steering commands', () => {
  const doc = readFileSync(docUrl, 'utf8')
  const actual = new Set([...doc.matchAll(/\/crew\s+([\w-]+)/g)].map((match) => match[1]))
  assert.deepEqual(actual, new Set(commands))
})
