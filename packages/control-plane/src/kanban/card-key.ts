// Kanban card idempotency key (issue #2 M1): sha256(epic, step, spec), so a retried orchestrator create never files twice.
import { kanbanCardKey } from '@agentconnect.md/protocol'

export interface CardKeyInput {
  /** Stable ref of the epic the card decomposes; the orchestrator uses the epic's issue number (`kanbanCardKeyEpic`). */
  epic: string
  /** The decomposition step that produced the card. */
  step: string
  /** The card spec text; only its digest is stored, never the text. */
  spec: string
}

// One implementation in the protocol package, so the daemon's body marker and the CP's key can never drift.
export function cardIdempotencyKey(input: CardKeyInput): string {
  return kanbanCardKey(input)
}
