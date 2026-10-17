import { describe, expect, it } from 'vitest'
import type { LabelEvent } from './card-store.js'
import {
  attributeLabel,
  labelAdder,
  labelAddedByWriter,
  latestLabelEvent,
  latestTransferEvent
} from './label-attribution.js'
import { isManagedLabel, liveManagedLabels, replayManagedLabels, setsEqual } from './label-sync.js'

const APP = 'agentconnect'
const user = (login: string) => ({ type: 'User', login })
const bob = user('bob')
const mallory = user('mallory')
const app = { type: 'Bot', login: `${APP}[bot]` }
const ev = (
  id: number,
  event: string,
  label: string | undefined,
  actor: LabelEvent['actor'] = bob,
  extra: Partial<LabelEvent> = {}
): LabelEvent => ({ id, event, ...(label !== undefined ? { label: { name: label } } : {}), actor, ...extra })

describe('label-attribution (Lane 1a)', () => {
  it('picks the latest labeled/unlabeled event for the exact label, case-insensitively', () => {
    const events = [ev(1, 'labeled', 'ac/status:ready'), ev(2, 'unlabeled', 'AC/STATUS:READY')]
    expect(latestLabelEvent(events, 'ac/status:ready')?.id).toBe(2)
    expect(latestLabelEvent(events, 'ac/status:todo')).toBeUndefined()
  })

  it('ties equal ids by created_at regardless of array order', () => {
    const events = [
      ev(9, 'labeled', 'ac/status:ready', user('bob'), { created_at: '2026-10-17T12:00:00Z' }),
      ev(9, 'unlabeled', 'ac/status:ready', user('bob'), { created_at: '2026-10-17T12:00:01Z' })
    ]
    expect(latestLabelEvent(events, 'ac/status:ready')?.event).toBe('unlabeled')
    expect(latestLabelEvent([...events].reverse(), 'ac/status:ready')?.event).toBe('unlabeled')
  })

  it('finds the latest transfer event, or undefined', () => {
    const events = [ev(1, 'labeled', 'ac/status:ready'), ev(2, 'transferred', undefined, user('rita'))]
    expect(latestTransferEvent(events)?.id).toBe(2)
    expect(latestTransferEvent([ev(1, 'labeled', 'ac/status:ready')])).toBeUndefined()
  })

  it('returns null when a removal is newer than the add', () => {
    const events = [ev(1, 'labeled', 'ac/status:ready'), ev(2, 'unlabeled', 'ac/status:ready')]
    expect(labelAdder(events, 'ac/status:ready', APP)).toBeNull()
  })

  it('returns null with no event (lag) or an unrelated event', () => {
    expect(labelAdder([], 'ac/status:ready', APP)).toBeNull()
    expect(labelAdder([ev(1, 'labeled', 'ac/status:todo')], 'ac/status:ready', APP)).toBeNull()
  })

  it.each([
    ['our App', { type: 'Bot', login: `${APP}[bot]` } as LabelEvent['actor'], {}],
    ['another bot', { type: 'Bot', login: 'renovate[bot]' } as LabelEvent['actor'], {}],
    ['a [bot] user login', user('helper[bot]'), {}],
    ['no actor', null, {}],
    ['an App on behalf of a user', user('bob'), { performed_via_github_app: { slug: 'x' } }]
  ])('returns null for a %s add', (_name, actor, extra) => {
    expect(labelAdder([ev(1, 'labeled', 'ac/status:ready', actor, extra)], 'ac/status:ready', APP)).toBeNull()
  })

  it('returns the login for a human add, including a case-variant label name', () => {
    expect(labelAdder([ev(1, 'labeled', 'AC/STATUS:READY', user('bob'))], 'ac/status:ready', APP)).toBe('bob')
  })

  it('attributes a re-add by a different actor after a removal', () => {
    const events = [
      ev(1, 'labeled', 'ac/status:ready', user('bob')),
      ev(2, 'unlabeled', 'ac/status:ready', user('bob')),
      ev(3, 'labeled', 'ac/status:ready', user('rita'))
    ]
    expect(labelAdder(events, 'ac/status:ready', APP)).toBe('rita')
  })

  it('labelAddedByWriter requires live write access and returns the login and level', async () => {
    const events = [ev(1, 'labeled', 'ac/status:ready', user('bob'))]
    const calls: string[] = []
    const writer = async (login: string) => {
      calls.push(login)
      return login === 'bob' ? { write: true, level: 'write' as const } : { write: false, level: 'read' as const }
    }
    await expect(labelAddedByWriter(events, 'ac/status:ready', APP, writer)).resolves.toEqual({
      login: 'bob',
      level: 'write'
    })
    expect(calls).toEqual(['bob'])
  })

  it('labelAddedByWriter fails closed when the adder is not a live writer', async () => {
    const events = [ev(1, 'labeled', 'ac/status:ready', user('rita'))]
    const writer = async () => ({ write: false, level: 'read' as const })
    await expect(labelAddedByWriter(events, 'ac/status:ready', APP, writer)).resolves.toBeNull()
  })
})

describe('attributeLabel (Lane 1b per-label latest visible event)', () => {
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
