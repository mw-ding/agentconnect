import { describe, expect, it } from 'vitest'
import { restartComment, skipComment } from './controls.js'

describe('kanban control comment templates', () => {
  it('names the actor login for a skip and stays body-free otherwise', () => {
    expect(skipComment('maintainer')).toBe('skipped by @maintainer via AgentConnect')
    expect(skipComment(null)).toBe('skipped via AgentConnect')
  })

  it('renders a fixed restart comment', () => {
    expect(restartComment()).toBe('restarted via AgentConnect')
  })
})
