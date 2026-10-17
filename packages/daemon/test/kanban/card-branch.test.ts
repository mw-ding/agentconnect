import { describe, expect, it } from 'vitest'
import { kanbanCardBranch, KANBAN_CARD_BRANCH_PREFIX } from '../../src/kanban/card-branch.js'

describe('kanbanCardBranch', () => {
  it('names a branch after the card issue number', () => {
    expect(kanbanCardBranch(7)).toBe('ac/card-7')
    expect(kanbanCardBranch(1234)).toBe('ac/card-1234')
  })

  it('rejects non-positive or fractional issue numbers', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => kanbanCardBranch(bad)).toThrow(/positive issue number/)
    }
  })

  it('keeps the prefix stable for retention and prompt text', () => {
    expect(KANBAN_CARD_BRANCH_PREFIX).toBe('ac/card-')
  })
})
