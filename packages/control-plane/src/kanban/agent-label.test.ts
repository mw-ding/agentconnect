import { describe, expect, it } from 'vitest'
import { AGENT_LABEL_PREFIX, agentLabel, parseAgentLabel } from './agent-label.js'

describe('parseAgentLabel', () => {
  it.each([
    { name: 'no labels', labels: [], want: { kind: 'none' } },
    { name: 'only other labels', labels: ['bug', 'ac/status:ready', 'ac/mode:write'], want: { kind: 'none' } },
    {
      name: 'one assignee',
      labels: ['ac/status:ready', 'ac/agent:worker-1'],
      want: { kind: 'agent', slug: 'worker-1' }
    },
    { name: 'case-folded label', labels: ['AC/Agent:Worker-1'], want: { kind: 'agent', slug: 'worker-1' } },
    {
      name: 'duplicate spellings of one slug',
      labels: ['ac/agent:bob', 'ac/agent:BOB'],
      want: { kind: 'agent', slug: 'bob' }
    },
    {
      name: 'two assignees',
      labels: ['ac/agent:bob', 'ac/agent:alice'],
      want: { kind: 'conflict', slugs: ['bob', 'alice'] }
    },
    { name: 'empty slug', labels: ['ac/agent:'], want: { kind: 'malformed', labels: ['ac/agent:'] } },
    {
      name: 'illegal characters',
      labels: ['ac/agent:bob smith'],
      want: { kind: 'malformed', labels: ['ac/agent:bob smith'] }
    },
    { name: 'leading hyphen', labels: ['ac/agent:-bob'], want: { kind: 'malformed', labels: ['ac/agent:-bob'] } },
    {
      name: 'a valid and a malformed assignee',
      labels: ['ac/agent:bob', 'ac/agent:b@d'],
      want: { kind: 'malformed', labels: ['ac/agent:b@d'] }
    },
    {
      name: 'two valid plus a malformed assignee is a conflict',
      labels: ['ac/agent:bob', 'ac/agent:carol', 'ac/agent:b@d'],
      want: { kind: 'conflict', slugs: ['bob', 'carol'] }
    },
    {
      name: 'a 64-character slug',
      labels: [`ac/agent:${'a'.repeat(64)}`],
      want: { kind: 'malformed', labels: [`ac/agent:${'a'.repeat(64)}`] }
    },
    { name: 'a slug named conflict', labels: ['ac/agent:conflict'], want: { kind: 'agent', slug: 'conflict' } }
  ])('$name', ({ labels, want }) => {
    expect(parseAgentLabel(labels)).toEqual(want)
  })

  it('round-trips the label it parses', () => {
    expect(agentLabel('worker-1')).toBe(`${AGENT_LABEL_PREFIX}worker-1`)
    expect(parseAgentLabel([agentLabel('worker-1')])).toEqual({ kind: 'agent', slug: 'worker-1' })
  })
})
