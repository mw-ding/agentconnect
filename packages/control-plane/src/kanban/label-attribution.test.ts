import { describe, expect, it } from 'vitest'
import type { LabelEvent } from './card-store.js'
import { labelAdder, labelAddedByWriter, latestLabelEvent, latestTransferEvent } from './label-attribution.js'

const APP = 'agentconnect'

const user = (login: string) => ({ type: 'User', login })
const ev = (
  id: number,
  event: string,
  label: string | undefined,
  actor: LabelEvent['actor'] = user('bob'),
  extra: Partial<LabelEvent> = {}
): LabelEvent => ({ id, event, ...(label !== undefined ? { label: { name: label } } : {}), actor, ...extra })

describe('label-attribution', () => {
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
