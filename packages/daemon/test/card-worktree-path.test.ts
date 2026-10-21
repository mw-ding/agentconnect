import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cardWorktreeLocation } from '../src/workspace/card-worktree-path.js'

const OLD = 'abcdef0123456789abcdef01'
const NEXT = '0123456789abcdef01234567'

describe('card worktree path comparison', () => {
  it.each([
    [`/managed/${OLD}`, `/managed/${OLD}/.`, 'same'],
    [`/managed/unused/../${OLD}`, `/managed/${NEXT}`, 'managed'],
    [`/Managed/${OLD}`, `/managed/${NEXT}`, 'foreign'],
    [`/managed-extra/${OLD}`, `/managed/${NEXT}`, 'foreign'],
    [`/managed/nested/${OLD}`, `/managed/${NEXT}`, 'foreign'],
    ['/managed/not-a-session', `/managed/${NEXT}`, 'foreign'],
    [`/managed\\${OLD}`, `/managed/${NEXT}`, 'foreign']
  ])('compares POSIX %s with %s as %s', (worktree, cwd, expected) => {
    expect(cardWorktreeLocation(worktree, cwd, posix)).toBe(expected)
  })

  it.each([
    [`C:/Managed/${OLD}`, `c:\\managed\\${OLD}`, 'same'],
    [`C:/Managed/unused/../${OLD}/`, `c:\\managed\\${NEXT}`, 'managed'],
    [`C:/Managed/${OLD.toUpperCase()}`, `c:\\managed\\${NEXT}`, 'managed'],
    [`D:/managed/${OLD}`, `c:\\managed\\${NEXT}`, 'foreign'],
    [`C:/managed-extra/${OLD}`, `c:\\managed\\${NEXT}`, 'foreign'],
    [`C:/managed/nested/${OLD}`, `c:\\managed\\${NEXT}`, 'foreign'],
    ['C:/managed/not-a-session', `c:\\managed\\${NEXT}`, 'foreign'],
    [`//server/share/Managed/${OLD}`, `\\\\SERVER\\share\\managed\\${NEXT}`, 'managed'],
    [`//other/share/managed/${OLD}`, `\\\\server\\share\\managed\\${NEXT}`, 'foreign']
  ])('compares Windows %s with %s as %s', (worktree, cwd, expected) => {
    expect(cardWorktreeLocation(worktree, cwd, win32)).toBe(expected)
  })
})
