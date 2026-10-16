# Kanban P0 pilot smoke (manual)

Validates label UX, hook dispatch, and worker prompts **without** platform code changes. Run against a real org with relay, GitHub App, placed worker agent, hook, and skill enabled.

## Preconditions

- [ ] Board repo exists; GitHub App installed with access (org or user-account installation that covers the repo).
- [ ] Labels from [../references/label-protocol.md](../references/label-protocol.md) created (or run `scripts/pilot-smoke.sh` for checks only).
- [ ] Worker agent `<slug>` placed; skill `kanban-label-protocol` enabled via skill source on this repo’s `skills/` path.
- [ ] GitHub hook per [../references/hook-config.md](../references/hook-config.md): `issues:labeled`, `labelFilter=["ac/agent:<slug>"]`.
- [ ] `gh` CLI authenticated with permission to create issues and edit labels on the board repo.
- [ ] Smoke issue is **authored by** a user with live write/admin on the board repo (relay authorizes the **issue author**, not the label adder).

## Steps

1. **Create throwaway issue** (as a write-capable user — that author must keep write access):

   ```bash
   export REPO=owner/kanban-board
   export SLUG=worker-alpha
   ISSUE_URL=$(gh issue create --repo "$REPO" --title "P0 smoke $(date +%s)" --body "Pilot smoke card; safe to delete.")
   echo "$ISSUE_URL"
   ```

2. **Set status ready (human path)** — assignee label still **off**:

   ```bash
   gh issue edit "$ISSUE_URL" --repo "$REPO" --add-label "ac/status:ready"
   ```

3. **Dispatch worker** — add assignee label **alone** (this edit adds only that one label), as a **human** (your user, not the App). Do **not** combine with `--add-label` for status (or any other label) in the same command, and do **not** put `ac/agent:` on `gh issue create --label`:

   ```bash
   gh issue edit "$ISSUE_URL" --repo "$REPO" --add-label "ac/agent:${SLUG}"
   ```

   **Expected:** AgentConnect opens or continues a **per-issue** session; worker reads the issue and follows `SKILL.md` (final answer starts with `Kanban: …`; **daemon** posts that reply — worker must not `gh issue comment`). Bundling agent + status in one edit (or at create) can start **two+** turns.

   **Observe in Console:** hook run / session activity on that agent; GitHub thread shows the daemon-posted worker reply.

4. **Worker termination** — after the daemon posts e.g. `Kanban: complete` with a summary, **you** remove the assignee label **before** status moves (stops re-dispatch), then apply status (agent must not `gh issue edit` status labels in P0):

   ```bash
   gh issue edit "$ISSUE_URL" --repo "$REPO" --remove-label "ac/agent:${SLUG}"
   gh issue edit "$ISSUE_URL" --repo "$REPO" --remove-label "ac/status:ready" --add-label "ac/status:done"
   gh issue close "$ISSUE_URL" --repo "$REPO" --reason completed
   ```

   **Expected:** No new worker turn when adding `ac/status:done` (assignee label gone). If you forget to remove `ac/agent:${SLUG}`, the status add **will** re-dispatch; the skill tells the worker to no-op with an **empty** final answer on `running` / parked / finished cards (daemon posts nothing), but remove-first is the preferred P0 control.

5. **Cleanup**

   ```bash
   gh issue delete "$(basename "$ISSUE_URL")" --repo "$REPO" --yes
   ```

   Or leave the issue closed for audit.

## Negative check (known gap)

As a human, add `ac/agent:<slug>` and confirm dispatch works. Then (optional) use automation that applies labels as a **bot** identity, or observe that when the **App** adds labels, **no** new hook run occurs.

| Action                                                              | Expected in P0                                                                                             |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Human adds `ac/agent:<slug>` alone (own action)                     | Hook matches; session runs                                                                                 |
| Human adds `ac/agent:<slug>` with another label, or at issue create | **2+** deliveries / turns possible (one per label; daemon dedupes per delivery only) — forbid in pilot     |
| Human adds `ac/status:*` while `ac/agent:<slug>` still on card      | Hook matches again (re-dispatch) — avoid by removing assignee first; worker no-ops empty on running/parked |
| Bot/App adds `ac/agent:<slug>` or `ac/status:*`                     | **No** dispatch (bot veto)                                                                                 |
| Worker edits labels with a **bot** App/`gh` identity                | Label may change but **does not** re-dispatch (bot veto); still violates one-writer protocol — do not use  |
| Worker edits labels with a **user** PAT                             | Label event is `senderType: User` and **will** re-dispatch if assignee label remains — forbid in pilot     |
| Issue authored by read-only user; maintainer adds `ac/agent:<slug>` | **No** dispatch (issue-author authz)                                                                       |

Document this gap when reporting pilot results (see [hook-config.md](../references/hook-config.md)).

## Optional script

[`pilot-smoke.sh`](pilot-smoke.sh) prints preconditions and example `gh` commands; it does not call AgentConnect APIs.
