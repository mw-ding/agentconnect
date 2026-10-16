# Kanban P0 pilot smoke (manual)

Validates label UX, hook dispatch, and worker prompts **without** platform code changes. Run against a real org with relay, GitHub App, placed worker agent, hook, and skill enabled.

## Preconditions

- [ ] Board repo exists; GitHub App installed with access.
- [ ] Labels from [../references/label-protocol.md](../references/label-protocol.md) created (or run `scripts/pilot-smoke.sh` for checks only).
- [ ] Worker agent `<slug>` placed; skill `kanban-label-protocol` enabled via skill source on this repo’s `skills/` path.
- [ ] GitHub hook per [../references/hook-config.md](../references/hook-config.md): `issues:labeled`, `labelFilter=["ac/agent:<slug>"]`.
- [ ] `gh` CLI authenticated with permission to create issues and edit labels on the board repo.

## Steps

1. **Create throwaway issue**

   ```bash
   export REPO=owner/kanban-board
   export SLUG=worker-alpha
   ISSUE_URL=$(gh issue create --repo "$REPO" --title "P0 smoke $(date +%s)" --body "Pilot smoke card; safe to delete.")
   echo "$ISSUE_URL"
   ```

2. **Set status ready (human path)**

   ```bash
   gh issue edit "$ISSUE_URL" --repo "$REPO" --add-label "ac/status:ready"
   ```

3. **Dispatch worker** — add assignee label as a **human** (your user, not the App):

   ```bash
   gh issue edit "$ISSUE_URL" --repo "$REPO" --add-label "ac/agent:${SLUG}"
   ```

   **Expected:** AgentConnect opens or continues a **per-issue** session; worker reads the issue and follows `SKILL.md` (structured terminal comment, asks human to flip status).

   **Observe in Console:** hook run / session activity on that agent; GitHub thread shows the worker reply.

4. **Worker termination** — after the agent posts e.g. `Kanban: complete` with a summary, **you** apply status (agent must not `gh issue edit` status labels in P0):

   ```bash
   gh issue edit "$ISSUE_URL" --repo "$REPO" --remove-label "ac/status:ready" --add-label "ac/status:done"
   gh issue close "$ISSUE_URL" --repo "$REPO" --reason completed
   ```

5. **Cleanup**

   ```bash
   gh issue delete "$(basename "$ISSUE_URL")" --repo "$REPO" --yes
   ```

   Or leave the issue closed for audit.

## Negative check (known gap)

As a human, add `ac/agent:<slug>` and confirm dispatch works. Then (optional) use automation that applies labels as a **bot** identity, or observe that when the **App** adds labels, **no** new hook run occurs.

| Action | Expected in P0 |
| --- | --- |
| Human adds `ac/agent:<slug>` | Hook matches; session runs |
| Bot/App adds `ac/agent:<slug>` or `ac/status:*` | **No** dispatch (bot veto) |
| Worker runs `gh issue edit --add-label ac/status:done` | Label may change on GitHub but **does not** re-dispatch; still violates one-writer protocol — do not use in pilot |

Document this gap when reporting pilot results (see [hook-config.md](../references/hook-config.md)).

## Optional script

[`pilot-smoke.sh`](pilot-smoke.sh) prints preconditions and example `gh` commands; it does not call AgentConnect APIs.
