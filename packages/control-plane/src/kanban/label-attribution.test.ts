import { describe, expect, it } from 'vitest'
import {
  attributeLabel,
  isManagedLabel,
  liveManagedLabels,
  replayManagedLabels,
  setsEqual
} from './label-attribution.js'
import type { LabelEvent } from './card-store.js'

const bob = { type: 'User', login: 'bob' }
const mallory = { type: 'User', login: 'mallory' }
const app = { type: 'Bot', login: 'agentconnect[bot]' }
const ev = (id: number, event: string, label: string, actor: LabelEvent['actor']): LabelEvent => ({
  id,
  event,
  label: { name: label },
  actor
})

describe('attributeLabel (per-label latest visible event)', () => {
  type Expected =
    { kind: 'add'; login: string; eventId: number } | { kind: 'removed'; eventId: number } | { kind: 'none' }
  it.each<[string, LabelEvent[], Expected]>([
    ['a plain add', [ev(1, 'labeled', 'ac/status:ready', bob)], { kind: 'add', login: 'bob', eventId: 1 }],
    [
      'latest event wins',
      [ev(1, 'labeled', 'ac/status:ready', mallory), ev(2, 'labeled', 'ac/status:ready', bob)],
      { kind: 'add', login: 'bob', eventId: 2 }
    ],
    [
      'a later removal beats an add',
      [ev(1, 'labeled', 'ac/status:ready', bob), ev(2, 'unlabeled', 'ac/status:ready', bob)],
      { kind: 'removed', eventId: 2 }
    ],
    [
      'a later re-add beats a removal',
      [
        ev(1, 'labeled', 'ac/status:ready', bob),
        ev(2, 'unlabeled', 'ac/status:ready', bob),
        ev(3, 'labeled', 'ac/status:ready', mallory)
      ],
      { kind: 'add', login: 'mallory', eventId: 3 }
    ],
    ['no visible event', [], { kind: 'none' }],
    ['unrelated labels are ignored', [ev(1, 'labeled', 'ac/status:todo', bob)], { kind: 'none' }],
    ['case-insensitive match', [ev(1, 'labeled', 'ac/status:Ready', bob)], { kind: 'add', login: 'bob', eventId: 1 }],
    ['a closed event is not a label edit', [ev(1, 'closed', '', bob)], { kind: 'none' }]
  ])('%s', (_name, events, expected) => {
    const result = attributeLabel(events, 'ac/status:ready')
    expect(result.kind).toBe(expected.kind)
    if (result.kind === 'add' && expected.kind === 'add') {
      expect(result.event.actor?.login).toBe(expected.login)
      expect(result.event.id).toBe(expected.eventId)
    } else if (result.kind === 'removed' && expected.kind === 'removed') {
      expect(result.eventId).toBe(expected.eventId)
    }
  })

  it('breaks id ties by created_at deterministically', () => {
    const a: LabelEvent = {
      id: 5,
      event: 'labeled',
      label: { name: 'ac/status:ready' },
      actor: mallory,
      created_at: '2026-10-17T00:00:01Z'
    }
    const b: LabelEvent = {
      id: 5,
      event: 'unlabeled',
      label: { name: 'ac/status:ready' },
      actor: bob,
      created_at: '2026-10-17T00:00:02Z'
    }
    expect(attributeLabel([a, b], 'ac/status:ready').kind).toBe('removed')
    expect(attributeLabel([b, a], 'ac/status:ready').kind).toBe('removed')
  })
})

describe('replayManagedLabels vs liveManagedLabels', () => {
  it('reproduces the live labels when the events are complete', () => {
    const events = [
      ev(1, 'labeled', 'ac/status:todo', bob),
      ev(2, 'labeled', 'ac/agent:worker', bob),
      ev(3, 'unlabeled', 'ac/status:todo', bob),
      ev(4, 'labeled', 'ac/status:ready', bob)
    ]
    const issue = { labels: ['ac/status:ready', 'ac/agent:worker'] }
    expect(setsEqual(replayManagedLabels(events), liveManagedLabels(issue))).toBe(true)
  })

  it('detects a live label whose latest visible event is a removal (event lag)', () => {
    const events = [
      ev(1, 'labeled', 'ac/status:ready', mallory),
      ev(2, 'unlabeled', 'ac/status:ready', app),
      ev(3, 'labeled', 'ac/status:blocked', bob),
      ev(4, 'unlabeled', 'ac/status:todo', bob)
    ]
    const issue = { labels: ['ac/status:ready'] }
    expect(setsEqual(replayManagedLabels(events), liveManagedLabels(issue))).toBe(false)
  })

  it('is case-insensitive and ignores non-managed labels', () => {
    const events = [ev(1, 'labeled', 'AC/status:ready', bob), ev(2, 'labeled', 'bug', bob)]
    const issue = { labels: ['ac/status:ready', 'bug'] }
    expect(setsEqual(replayManagedLabels(events), liveManagedLabels(issue))).toBe(true)
  })
})

describe('isManagedLabel', () => {
  it.each(['ac/status:ready', 'ac/agent:worker', 'AC/AGENT:x'])(`matches %s`, (name) => {
    expect(isManagedLabel(name)).toBe(true)
  })
  it.each(['bug', 'ac/mode:write', 'ac/statuss:ready'])(`ignores %s`, (name) => {
    expect(isManagedLabel(name)).toBe(false)
  })
})
