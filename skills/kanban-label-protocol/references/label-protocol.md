# Label catalog and P0 cheat-sheet

Namespace prefix: `ac/` (AgentConnect Kanban). Create these as GitHub labels on the board repo before the pilot.

## Full label catalog

### Status (exclusive — keep exactly one `ac/status:*` on a card)

| Label                | Column / intent      | Typical next labels (human)                                                                                                     |
| -------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ac/status:triage`   | Inbox, needs sorting | `ac/status:todo` or `ac/status:archived`                                                                                        |
| `ac/status:todo`     | Backlog              | `ac/status:ready` when scoped                                                                                                   |
| `ac/status:ready`    | Runnable             | Add `ac/agent:<slug>` **last** to dispatch; may set `ac/status:running` only after removing assignee or accepting a re-dispatch |
| `ac/status:running`  | Active work          | Remove `ac/agent:<slug>` first, then `ac/status:review`, `ac/status:blocked`, or `ac/status:done`                               |
| `ac/status:blocked`  | Waiting              | Remove block cause, then `ac/status:ready` and re-add `ac/agent:<slug>` to re-dispatch                                          |
| `ac/status:review`   | Human review         | `ac/status:done` + close, or back to `ac/status:ready` + re-add assignee                                                        |
| `ac/status:done`     | Finished             | Close issue as **completed**                                                                                                    |
| `ac/status:archived` | Dropped              | Close issue as **not planned**                                                                                                  |

When changing status, **remove the previous `ac/status:*`** label so only one status applies.

### Assignee (at most one worker per card)

| Label             | Meaning                                                                         |
| ----------------- | ------------------------------------------------------------------------------- |
| `ac/agent:<slug>` | Card is assigned to worker `<slug>`; must match that agent’s hook `labelFilter` |

Do not stack multiple `ac/agent:*` labels on one issue in P0.

**Re-dispatch rule:** while `ac/agent:<slug>` stays on the issue, **any** human label add fires the hook again. Remove the assignee label before terminal or parked status moves (`running` / `review` / `blocked` / `done` / `archived`). Re-add it only when you intentionally want another worker turn.

## Human move cheat-sheet (P0)

| Goal                | Human actions                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Triage new work     | `ac/status:triage` → classify → `ac/status:todo` or `ac/status:ready`                                                                                                                   |
| Assign worker       | Ensure `ac/status:ready`, then add `ac/agent:<slug>` **last** (that add dispatches via hook)                                                                                            |
| Start work (visual) | Prefer leaving status at `ready`/`running` only if you accept a re-dispatch, **or** remove assignee first, set `ac/status:running`, then re-add assignee only if another turn is needed |
| Worker finished     | Read daemon-posted `Kanban:` final answer; **remove** `ac/agent:<slug>`; set `ac/status:done` or `ac/status:review`; close if done                                                      |
| Worker needs review | **Remove** `ac/agent:<slug>`; set `ac/status:review` after `Kanban: request_review`                                                                                                     |
| Worker blocked      | **Remove** `ac/agent:<slug>`; set `ac/status:blocked` after `Kanban: block kind=…`                                                                                                      |
| Unblock / re-run    | Address blocker → `ac/status:ready` → add `ac/agent:<slug>` again to dispatch                                                                                                           |
| Cancel card         | Remove assignee if present; `ac/status:archived` + close not planned                                                                                                                    |

Humans should **not** expect the worker or App to move `ac/status:*` labels in P0.

## Worker final-answer templates (daemon posts)

On GitHub hook turns the **daemon** posts the worker’s final answer. Workers must **not** `gh issue comment`. Start the final answer with one directive line.

### Complete

Final-answer body (daemon posts):

```text
Kanban: complete

Summary: <1–3 sentences on outcome>

<optional: PR link, commit, test command, files touched>
```

Human: remove `ac/agent:<slug>`; set `ac/status:done` (or `ac/status:review` if you want another pass), then close when appropriate.

### Request review

```markdown
Kanban: request_review

Summary: <what to review and where>
```

Human: remove `ac/agent:<slug>`; set `ac/status:review`.

### Block

```markdown
Kanban: block kind=needs_input

Summary: <what is missing and who can unblock>
```

`kind` must be one of:

| Kind          | Use when                                    |
| ------------- | ------------------------------------------- |
| `dependency`  | Waiting on another issue, team, or merge    |
| `needs_input` | Product/owner decision or clarification     |
| `capability`  | Task exceeds agent tools, access, or policy |
| `transient`   | Temporary external failure (retry later)    |

Human: remove `ac/agent:<slug>`; set `ac/status:blocked`.

### Quiet no-op (parked / finished)

If the card is already `done` / `archived` / `review` / `blocked` with no new human instruction, the worker ends **without** a `Kanban:` line (daemon may still post a brief ack if the runtime requires a final answer — prefer an empty or “no action” note, never a fresh complete/block/request_review).

## Future (not P0)

| Action         | P0                                                          | Later MCP             |
| -------------- | ----------------------------------------------------------- | --------------------- |
| complete       | final answer + human removes assignee + `ac/status:done`    | `kanbanComplete`      |
| request_review | final answer + human removes assignee + `ac/status:review`  | `kanbanRequestReview` |
| block          | final answer + human removes assignee + `ac/status:blocked` | `kanbanBlock`         |

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
