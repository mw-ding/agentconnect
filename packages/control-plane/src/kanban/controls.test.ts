import { describe, expect, it } from 'vitest'
import { restartComment, skipComment } from './controls.js'

describe('kanban control comment templates', () => {
  it('names the actor login for a skip and stays body-free otherwise', () => {
    expect(skipComment('maintainer')).toBe('skipped by @maintainer via AgentConnect')
    expect(skipComment(null)).toBe('skipped via AgentConnect')
  })

  it('renders a fixed restart comment', () => {
    expect(restartComment(7, null)).toBe('restarted via AgentConnect')
  })

  it('416r2: names the superseded pull request and the card branch, nothing else', () => {
    expect(restartComment(7, 21)).toBe(
      'restarted via AgentConnect; pull request #21 from the earlier work can no longer complete this card, ' +
        'so close it if it is still open and open a new one from `ac/card-7`'
    )
  })
})
