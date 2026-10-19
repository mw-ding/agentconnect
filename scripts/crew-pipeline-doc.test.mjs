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

function section(doc, heading) {
  return doc.split(`## ${heading}\n`)[1]?.split(/^## /m)[0].trim() ?? ''
}

test('crew pipeline documents exactly eight one-line label bullets under Labels', () => {
  const doc = readFileSync(docUrl, 'utf8')
  const lines = section(doc, 'Labels').split('\n').filter(Boolean)
  assert.equal(lines.length, 8, 'Labels must contain exactly eight one-line bullets')
  const actual = lines.map((line) => {
    const match = /^- `(crew:[^`\r\n]+)`: ([^`\r\n]+)$/.exec(line)
    assert.ok(match, 'Each label bullet must name exactly one backticked label with a description')
    assert.ok(match[2].trim(), 'Each label needs a nonempty description')
    return match[1]
  })
  assert.deepEqual(new Set(actual), new Set(labels))
  const mentioned = [...doc.matchAll(/`(crew:[^`\r\n]+)`/g)].map((match) => match[1])
  assert.deepEqual(new Set(mentioned), new Set(labels))
})

test('crew pipeline documents exactly six steering command rows with owners and effects', () => {
  const doc = readFileSync(docUrl, 'utf8')
  const rows = section(doc, 'Steering commands')
    .split('\n')
    .filter((line) => /^\| `/.test(line))
  assert.equal(rows.length, 6, 'Steering commands must contain exactly six command rows')
  const actual = rows.map((row) => {
    const match = /^\| `\/crew ([\w-]+)(?:: <note>)?` +\| ([^|]+)\| ([^|]+)\|$/.exec(row)
    assert.ok(match, 'Each command row needs a backticked command, owner, and effect')
    assert.ok(match[2].trim() && match[3].trim(), 'Command owners and effects must be nonempty')
    return match[1]
  })
  assert.deepEqual(new Set(actual), new Set(commands))
  const mentioned = [...doc.matchAll(/`\/crew ([^`\r\n]+)`/g)].map((match) => {
    return match[1].split(/[:\s]/)[0]
  })
  assert.deepEqual(new Set(mentioned), new Set(commands))
})
