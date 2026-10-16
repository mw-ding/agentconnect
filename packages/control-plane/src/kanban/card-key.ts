// Kanban card idempotency key (issue #2 M1): sha256(epic, step, spec), so a retried orchestrator create never files twice.
import { createHash } from 'node:crypto'

export interface CardKeyInput {
  /** Stable ref of the epic the card decomposes, e.g. the parent issue id. */
  epic: string
  /** The decomposition step that produced the card. */
  step: string
  /** The card spec text; only its digest is stored, never the text. */
  spec: string
}

export function cardIdempotencyKey(input: CardKeyInput): string {
  // JSON array framing keeps ("a","bc") and ("ab","c") distinct; the tag versions the encoding.
  return createHash('sha256')
    .update(JSON.stringify(['kanban-card/v1', input.epic, input.step, input.spec]))
    .digest('hex')
}
