import { createHash } from 'node:crypto'

// The Kanban B1 idempotency key (issue #2): the CP keys a card on it and the daemon stamps it into the issue it files.

export interface KanbanCardKeyInput {
  /** Stable ref of the epic the card decomposes (see `kanbanCardKeyEpic`). */
  epic: string
  /** The decomposition step that produced the card. */
  step: string
  /** The card spec (the orchestrator passes its sha256 digest); only the key's digest is stored, never the text. */
  spec: string
}

export function kanbanCardKey(input: KanbanCardKeyInput): string {
  // JSON array framing keeps ("a","bc") and ("ab","c") distinct; the tag versions the encoding.
  return createHash('sha256')
    .update(JSON.stringify(['kanban-card/v1', input.epic, input.step, input.spec]))
    .digest('hex')
}

/** The epic ref is the epic's issue NUMBER on the board (stable within one repo), or `board:<id>` for a top-level card. */
export function kanbanCardKeyEpic(boardId: string, epicIssueNumber?: number): string {
  return epicIssueNumber !== undefined ? String(epicIssueNumber) : `board:${boardId}`
}

/** The orchestrator's create key from its wire fields; prepare, commit, and the daemon's marker all use this one helper. */
export function kanbanOrchestrateCardKey(req: {
  boardId: string
  epicIssueNumber?: number | undefined
  step: string
  specDigest: string
}): string {
  return kanbanCardKey({
    epic: kanbanCardKeyEpic(req.boardId, req.epicIssueNumber),
    step: req.step,
    spec: req.specDigest
  })
}

const MARKER_RE = /<!-- agentconnect:kanban-card-key:([0-9a-f]{64}) -->/

/** A hidden body marker carrying the B1 key (a digest, never secret), so a crash-retry can find its own filed issue. */
export function kanbanCardKeyMarker(key: string): string {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('kanban card key must be 64 lowercase hex')
  return `<!-- agentconnect:kanban-card-key:${key} -->`
}

/** The B1 key a filed issue body carries, or null. */
export function parseKanbanCardKeyMarker(body: string | null | undefined): string | null {
  return body ? (MARKER_RE.exec(body)?.[1] ?? null) : null
}
