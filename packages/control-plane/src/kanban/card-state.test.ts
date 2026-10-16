import { describe, expect, it } from 'vitest'
import {
  KANBAN_STATUSES,
  KANBAN_TRANSITIONS,
  LEASED_HUMAN_STATUSES,
  canTransition,
  issueStateFor,
  isPromotionResidue,
  parseStatusLabels,
  planLabelReconcile,
  planRecovery,
  planStatusWrite,
  refuseRequest,
  statusLabel,
  type KanbanStatus,
  type ObservedIssue
} from './card-state.js'

// The full 8×8 matrix, written out so any table change is a deliberate test edit.
// prettier-ignore
const EXPECTED: Record<KanbanStatus, Record<KanbanStatus, boolean>> = {
  triage:   { triage: false, todo: true,  ready: true,  running: false, blocked: true,  review: false, done: false, archived: true },
  todo:     { triage: true,  todo: false, ready: true,  running: false, blocked: true,  review: false, done: false, archived: true },
  ready:    { triage: true,  todo: true,  ready: false, running: true,  blocked: true,  review: false, done: false, archived: true },
  running:  { triage: true,  todo: false, ready: true,  running: false, blocked: true,  review: true,  done: true,  archived: true },
  blocked:  { triage: true,  todo: true,  ready: true,  running: false, blocked: false, review: false, done: false, archived: true },
  review:   { triage: true,  todo: false, ready: true,  running: false, blocked: true,  review: false, done: true,  archived: true },
  done:     { triage: true,  todo: false, ready: true,  running: false, blocked: false, review: false, done: false, archived: false },
  archived: { triage: true,  todo: false, ready: false, running: false, blocked: false, review: false, done: false, archived: false }
}

const open = (...labels: string[]): ObservedIssue => ({ labels, state: 'open' })
const L = statusLabel

describe('Kanban transition table', () => {
  it('covers every status as a source with no unknown or self targets', () => {
    expect(Object.keys(KANBAN_TRANSITIONS).sort()).toEqual([...KANBAN_STATUSES].sort())
    for (const from of KANBAN_STATUSES) {
      for (const to of KANBAN_TRANSITIONS[from]) {
        expect(KANBAN_STATUSES).toContain(to)
        expect(to).not.toBe(from)
      }
    }
  })

  for (const from of KANBAN_STATUSES) {
    for (const to of KANBAN_STATUSES) {
      it(`${from} → ${to} is ${EXPECTED[from][to] ? 'legal' : 'illegal'}`, () => {
        expect(canTransition(from, to)).toBe(EXPECTED[from][to])
      })
    }
  }

  it('lets every status reach triage or itself be triage, so no card can be stranded', () => {
    for (const from of KANBAN_STATUSES) expect(from === 'triage' || canTransition(from, 'triage')).toBe(true)
  })

  it('only dispatch enters running', () => {
    expect(KANBAN_STATUSES.filter((from) => canTransition(from, 'running'))).toEqual(['ready'])
  })

  it('maps terminal statuses onto issue close reasons', () => {
    expect(issueStateFor('done')).toEqual({ state: 'closed', reason: 'completed' })
    expect(issueStateFor('archived')).toEqual({ state: 'closed', reason: 'not_planned' })
    for (const s of KANBAN_STATUSES.filter((s) => s !== 'done' && s !== 'archived')) {
      expect(issueStateFor(s)).toEqual({ state: 'open' })
    }
  })
})

describe('parseStatusLabels', () => {
  it('separates known statuses, malformed status labels, and unrelated labels', () => {
    expect(parseStatusLabels(['bug', L('ready'), 'ac/status:doing', L('ready'), 'ac/agent:ash'])).toEqual({
      statuses: ['ready'],
      malformed: ['ac/status:doing']
    })
  })
})

describe('planLabelReconcile', () => {
  it('is a silent no-op for the CP echo of its own write', () => {
    const plan = planLabelReconcile({ status: 'ready', leased: false }, open('bug', L('ready')))
    expect(plan).toEqual({ outcome: 'noop', status: 'ready', releaseLease: false, addLabels: [], removeLabels: [] })
  })

  it('accepts a legal human edit silently', () => {
    const plan = planLabelReconcile({ status: 'triage', leased: false }, open(L('ready')))
    expect(plan).toMatchObject({ outcome: 'accepted', status: 'ready', requested: 'ready', addLabels: [] })
    expect(plan.removeLabels).toEqual([])
    expect(plan.comment).toBeUndefined()
  })

  it('reverts an illegal human edit with a comment naming the allowed moves', () => {
    const plan = planLabelReconcile({ status: 'triage', leased: false }, open(L('done')))
    expect(plan).toMatchObject({
      outcome: 'reverted_illegal',
      status: 'triage',
      requested: 'done',
      addLabels: [L('triage')],
      removeLabels: [L('done')]
    })
    expect(plan.comment).toContain('`ac/status:triage` cannot move to `ac/status:done`')
  })

  describe('multiple status labels are drift', () => {
    it('repairs to the single acceptable request, with a comment', () => {
      const plan = planLabelReconcile({ status: 'ready', leased: false }, open(L('ready'), L('blocked')))
      expect(plan).toMatchObject({
        outcome: 'drift_repaired',
        status: 'blocked',
        addLabels: [],
        removeLabels: [L('ready')]
      })
      expect(plan.comment).toContain('exactly one status label')
    })

    it('repairs back to the CP status when several statuses are requested at once', () => {
      const plan = planLabelReconcile({ status: 'ready', leased: false }, open(L('blocked'), L('triage')))
      expect(plan).toMatchObject({
        outcome: 'drift_repaired',
        status: 'ready',
        addLabels: [L('ready')],
        removeLabels: [L('blocked'), L('triage')]
      })
      expect(plan.comment).toContain('kept `ac/status:ready`')
    })

    it('strips a malformed status label as drift', () => {
      const plan = planLabelReconcile({ status: 'todo', leased: false }, open(L('todo'), 'ac/status:doing'))
      expect(plan).toMatchObject({ outcome: 'drift_repaired', status: 'todo', removeLabels: ['ac/status:doing'] })
      expect(plan.comment).toContain('`ac/status:doing`')
    })

    it('always leaves exactly one status label, for every pair of labels and every snapshot', () => {
      for (const status of KANBAN_STATUSES) {
        for (const leased of [false, true]) {
          for (const a of KANBAN_STATUSES) {
            for (const b of KANBAN_STATUSES) {
              const labels = [L(a), L(b), 'bug']
              const plan = planLabelReconcile({ status, leased }, open(...labels))
              const after = [...labels.filter((l) => !plan.removeLabels.includes(l)), ...plan.addLabels]
              expect(parseStatusLabels(after).statuses).toEqual([plan.status])
              expect(after).toContain('bug')
              expect(plan.status === status || canTransition(status, plan.status)).toBe(true)
            }
          }
        }
      }
    })
  })

  it('restores a removed status label', () => {
    const plan = planLabelReconcile({ status: 'review', leased: false }, open('bug'))
    expect(plan).toMatchObject({ outcome: 'restored_missing', status: 'review', addLabels: [L('review')] })
    expect(plan.comment).toContain('no status label')
  })

  describe('while leased', () => {
    for (const requested of KANBAN_STATUSES.filter((s) => s !== 'running')) {
      const accepted = LEASED_HUMAN_STATUSES.has(requested)
      it(`${accepted ? 'accepts' : 'reverts'} running → ${requested}`, () => {
        const plan = planLabelReconcile({ status: 'running', leased: true }, open(L(requested)))
        if (accepted) {
          expect(plan).toMatchObject({ outcome: 'accepted', status: requested, releaseLease: true })
        } else {
          expect(plan).toMatchObject({
            outcome: 'reverted_leased',
            status: 'running',
            releaseLease: false,
            addLabels: [L('running')],
            removeLabels: [L(requested)]
          })
          expect(plan.comment).toContain('leased to a running agent')
        }
      })
    }

    it('accepts the same edit once the lease has ended', () => {
      expect(refuseRequest({ status: 'running', leased: true }, 'ready')).toBe('leased')
      expect(refuseRequest({ status: 'running', leased: false }, 'ready')).toBeUndefined()
    })

    it('still applies the transition table to the accepted set', () => {
      // The leased allow-list narrows the table; it never widens it.
      expect(refuseRequest({ status: 'archived', leased: true }, 'blocked')).toBe('illegal')
    })
  })

  describe('issue state follows status', () => {
    it('closes as completed when a card is accepted into done', () => {
      const plan = planLabelReconcile({ status: 'review', leased: false }, open(L('done')))
      expect(plan.issueState).toEqual({ state: 'closed', reason: 'completed' })
    })

    it('reopens an archived card moved back to triage', () => {
      const plan = planLabelReconcile(
        { status: 'archived', leased: false },
        { labels: [L('triage')], state: 'closed', stateReason: 'not_planned' }
      )
      expect(plan).toMatchObject({ outcome: 'accepted', status: 'triage', issueState: { state: 'open' } })
    })

    it.each([null, undefined])('repairs a closed card whose close reason is %s', (stateReason) => {
      const plan = planLabelReconcile(
        { status: 'done', leased: false },
        { labels: [L('done')], state: 'closed', stateReason }
      )
      expect(plan).toMatchObject({ outcome: 'noop', issueState: { state: 'closed', reason: 'completed' } })
    })

    it('corrects a wrong close reason', () => {
      const plan = planLabelReconcile(
        { status: 'archived', leased: false },
        { labels: [L('archived')], state: 'closed', stateReason: 'completed' }
      )
      expect(plan).toMatchObject({ outcome: 'noop', issueState: { state: 'closed', reason: 'not_planned' } })
    })
  })

  it('never puts issue content in a comment', () => {
    const plan = planLabelReconcile({ status: 'ready', leased: false }, open(L('blocked'), L('triage'), 'secret-label'))
    expect(plan.comment).not.toContain('secret-label')
  })
})

describe('planStatusWrite — CP-driven transitions', () => {
  it('writes exactly one status label, silently, and closes for done', () => {
    const plan = planStatusWrite('running', open(L('ready'), 'bug'))
    expect(plan).toMatchObject({ outcome: 'accepted', status: 'running', releaseLease: false })
    expect(plan.addLabels).toEqual([L('running')])
    expect(plan.removeLabels).toEqual([L('ready')])
    expect(plan.comment).toBeUndefined()
    expect(planStatusWrite('done', open(L('running'))).issueState).toEqual({ state: 'closed', reason: 'completed' })
  })

  it('is a no-op when GitHub already matches', () => {
    expect(planStatusWrite('ready', open(L('ready'))).outcome).toBe('noop')
  })

  it('differs from planLabelReconcile, which would read the stale label as a human request', () => {
    expect(planLabelReconcile({ status: 'running', leased: true }, open(L('ready'))).outcome).toBe('reverted_leased')
    expect(planStatusWrite('running', open(L('ready'))).outcome).toBe('accepted')
  })
})

describe('planRecovery — mismatch-parked cards', () => {
  it('moves on one legal open status label', () => {
    expect(planRecovery('blocked', open(L('ready'), 'bug'))).toEqual({ kind: 'move', to: 'ready' })
    expect(planRecovery('archived', open(L('triage')))).toEqual({ kind: 'move', to: 'triage' })
  })

  it('reports an illegal move instead of silently dropping it', () => {
    expect(planRecovery('archived', open(L('ready')))).toEqual({ kind: 'illegal', requested: 'ready' })
  })

  it.each<[KanbanStatus, ObservedIssue | null]>([
    ['blocked', null],
    ['blocked', { labels: [L('ready')], state: 'closed' }],
    ['blocked', open(L('ready'), L('blocked'))],
    ['blocked', open(L('ready'), 'ac/status:bogus')],
    ['blocked', open()],
    ['blocked', open(L('blocked'))],
    ['blocked', open(L('running'))]
  ])('ignores %s with %j', (from, observed) => {
    expect(planRecovery(from, observed)).toEqual({ kind: 'none' })
  })
})

describe('isPromotionResidue', () => {
  it('is exactly an open todo+ready pair', () => {
    expect(isPromotionResidue(open(L('todo'), L('ready'), 'bug'))).toBe(true)
    expect(isPromotionResidue({ labels: [L('todo'), L('ready')], state: 'closed' })).toBe(false)
    expect(isPromotionResidue(open(L('todo'), L('ready'), L('blocked')))).toBe(false)
    expect(isPromotionResidue(open(L('blocked'), L('ready')))).toBe(false)
    expect(isPromotionResidue(open(L('todo'), L('ready'), 'ac/status:bogus'))).toBe(false)
  })
})
