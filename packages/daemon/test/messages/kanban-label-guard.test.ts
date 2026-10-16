import { describe, expect, it } from 'vitest'
import { isKanbanLabelMutation } from '../../src/messages/kanban-message.js'

describe('isKanbanLabelMutation', () => {
  it.each([
    'gh issue edit 42 --add-label ac/status:done',
    'gh issue edit 42 --remove-label "ac/agent:worker"',
    'gh label create ac/mode:write',
    'gh api repos/acme/web/issues/42/labels -f "labels[]=ac/status:ready"',
    'gh api --method POST repos/acme/web/issues/42/labels --input - {"labels":["ac/status:done"]}',
    'curl -X PATCH https://api.github.com/repos/acme/web/issues/42/labels -d \'["ac/mode:write"]\''
  ])('refuses a write that names an ac/* label: %s', (toolCall) => {
    expect(isKanbanLabelMutation(toolCall)).toBe(true)
  })

  it.each([
    'gh issue view 42 --comments',
    'gh label list',
    'gh api repos/acme/web/issues/42/labels -X GET',
    'gh issue comment 42 --body "status is ac/status:done; please do not change labels"',
    'gh issue edit 42 --add-label bug',
    'echo ac/status:ready > notes.txt'
  ])('allows a read or a write that does not change an ac/* label: %s', (toolCall) => {
    expect(isKanbanLabelMutation(toolCall)).toBe(false)
  })
})
