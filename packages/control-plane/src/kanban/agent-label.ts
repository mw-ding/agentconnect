// Kanban assignee labels (issue #2 M1): `ac/agent:<slug>` names the card's worker by its org-unique Agent slug.

export const AGENT_LABEL_PREFIX = 'ac/agent:'

// Agent.name is the slug; GitHub label names compare case-insensitively, so the value is lowercased first.
const AGENT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

export type AgentLabelParse =
  | { kind: 'none' }
  | { kind: 'agent'; slug: string }
  /** Two or more distinct assignees: drift, so no single agent may be inferred. */
  | { kind: 'conflict'; slugs: string[] }
  /** An unparseable `ac/agent:*` label is present; treated like a conflict, never as unassigned. */
  | { kind: 'malformed'; labels: string[] }

export function agentLabel(slug: string): string {
  return `${AGENT_LABEL_PREFIX}${slug}`
}

/** Reduce an issue's labels to its one assignee slug, or say why there is none. */
export function parseAgentLabel(labels: readonly string[]): AgentLabelParse {
  const slugs: string[] = []
  const malformed: string[] = []
  for (const label of labels) {
    if (label.slice(0, AGENT_LABEL_PREFIX.length).toLowerCase() !== AGENT_LABEL_PREFIX) continue
    const slug = label.slice(AGENT_LABEL_PREFIX.length).trim().toLowerCase()
    if (AGENT_SLUG_RE.test(slug)) {
      if (!slugs.includes(slug)) slugs.push(slug)
    } else malformed.push(label)
  }
  if (slugs.length > 1) return { kind: 'conflict', slugs }
  if (malformed.length > 0) return { kind: 'malformed', labels: malformed }
  if (slugs.length === 1) return { kind: 'agent', slug: slugs[0]! }
  return { kind: 'none' }
}
