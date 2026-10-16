import { describe, expect, it } from 'vitest'
import { GITHUB_APP_EVENTS, GITHUB_APP_PERMISSIONS } from '../src/github-app.js'

describe('GitHub App manifest', () => {
  it('subscribes to the Kanban graph events without a new permission', () => {
    expect(GITHUB_APP_EVENTS).toContain('sub_issues')
    expect(GITHUB_APP_EVENTS).toContain('issue_dependencies')
    expect(Object.keys(GITHUB_APP_PERMISSIONS).sort()).toEqual(
      ['actions', 'checks', 'contents', 'deployments', 'emails', 'issues', 'metadata', 'pull_requests', 'workflows'].sort()
    )
    expect(GITHUB_APP_PERMISSIONS.issues).toBe('write')
  })
})
