# Label catalog and P0 cheat-sheet

Namespace prefix: `ac/` (AgentConnect Kanban). Create these as GitHub labels on the board repo before the pilot.

## Full label catalog

### Status (exclusive — keep exactly one `ac/status:*` on a card)

| Label | Column / intent | Typical next labels (human) |
| --- | --- | --- |
| `ac/status:triage` | Inbox, needs sorting | `ac/status:todo` or `ac/status:archived` |
| `ac/status:todo` | Backlog | `ac/status:ready` when scoped |
| `ac/status:ready` | Runnable | Add `ac/agent:<slug>` to dispatch; may set `ac/status:running` when work starts |
| `ac/status:running` | Active work | `ac/status:review`, `ac/status:blocked`, or `ac/status:done` |
| `ac/status:blocked` | Waiting | Remove block cause, then `ac/status:ready` or `ac/status:running` |
| `ac/status:review` | Human review | `ac/status:done` + close, or back to `ac/status:running` |
| `ac/status:done` | Finished | Close issue as **completed** |
| `ac/status:archived` | Dropped | Close issue as **not planned** |

When changing status, **remove the previous `ac/status:*`** label so only one status applies.

### Assignee (at most one worker per card)

| Label | Meaning |
| --- | --- |
| `ac/agent:<slug>` | Card is assigned to worker `<slug>`; must match that agent’s hook `labelFilter` |

Do not stack multiple `ac/agent:*` labels on one issue in P0.

### Mode (optional, forward-looking)

| Label | Meaning |
| --- | --- |
| `ac/mode:write` | Reserved — write-capable execution mode when the platform honors it; safe to document on cards but P0 does not require it |

## Human move cheat-sheet (P0)

| Goal | Human actions |
| --- | --- |
| Triage new work | `ac/status:triage` → classify → `ac/status:todo` or `ac/status:ready` |
| Assign worker | Add `ac/agent:<slug>` (often while `ac/status:ready`); adding the assignee label dispatches via hook |
| Start work (visual) | Swap to `ac/status:running` (optional but helps the board) |
| Worker finished | Read worker comment; set `ac/status:done` or `ac/status:review`; close if done |
| Worker needs review | Set `ac/status:review` after `Kanban: request_review` |
| Worker blocked | Set `ac/status:blocked` after `Kanban: block kind=…` |
| Unblock | Address blocker → `ac/status:ready` or `ac/status:running` |
| Cancel card | `ac/status:archived` + close not planned |

Humans should **not** expect the worker or App to move `ac/status:*` labels in P0.

## Worker comment templates

Copy, fill in, and post **one** terminal comment per session turn.

### Complete

```markdown
Kanban: complete

Summary: <1–3 sentences on outcome>

```text
<optional: PR link, commit, test command, files touched>
```
```

Human: set `ac/status:done` (or `ac/status:review` if you want another pass), then close when appropriate.

### Request review

```markdown
Kanban: request_review

Summary: <what to review and where>
```

Human: set `ac/status:review`.

### Block

```markdown
Kanban: block kind=needs_input

Summary: <what is missing and who can unblock>
```

`kind` must be one of:

| Kind | Use when |
| --- | --- |
| `dependency` | Waiting on another issue, team, or merge |
| `needs_input` | Product/owner decision or clarification |
| `capability` | Task exceeds agent tools, access, or policy |
| `transient` | Temporary external failure (retry later) |

Human: set `ac/status:blocked`.

## Future (not P0)

| Action | P0 | Later MCP |
| --- | --- | --- |
| complete | comment + human `ac/status:done` | `kanbanComplete` |
| request_review | comment + human `ac/status:review` | `kanbanRequestReview` |
| block | comment + human `ac/status:blocked` | `kanbanBlock` |

## Bootstrapping labels with `gh`

One-time on the board repo (colors optional):

```bash
gh label create "ac/status:triage" --repo OWNER/REPO --description "Kanban: triage"
gh label create "ac/status:todo" --repo OWNER/REPO --description "Kanban: todo"
gh label create "ac/status:ready" --repo OWNER/REPO --description "Kanban: ready"
gh label create "ac/status:running" --repo OWNER/REPO --description "Kanban: running"
gh label create "ac/status:blocked" --repo OWNER/REPO --description "Kanban: blocked"
gh label create "ac/status:review" --repo OWNER/REPO --description "Kanban: review"
gh label create "ac/status:done" --repo OWNER/REPO --description "Kanban: done"
gh label create "ac/status:archived" --repo OWNER/REPO --description "Kanban: archived"
gh label create "ac/agent:WORKER_SLUG" --repo OWNER/REPO --description "Kanban assignee"
```

Replace `WORKER_SLUG` per worker agent.
