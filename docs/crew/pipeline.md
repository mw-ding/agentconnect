# Crew PR pipeline

## Overview

The crew coordinates contributor work through GitHub events: one issue, one branch,
one pull request (PR), and one squash merge. Issues describe the work; PR evidence,
reviews, and labels record its progress. Roles re-read the current head commit,
checks, and state before acting, ignoring stale events and duplicate work.

## Stages

1. **Spec:** The coordinator agrees the goal, numbered acceptance criteria,
   dependencies, and scope with maintainers, with research as needed. Spec PRs use
   `crew:spec`, receive review only, and require the maintainer merge override.
2. **Handoff:** The coordinator marks a buildable issue `crew:ready` and assigns it
   to start the builder.
3. **Build:** The builder implements and tests on one branch, opens a non-draft PR
   with `Closes #n` and acceptance evidence, and marks it `crew:in-review`.
4. **CI:** Both `CI OK` and `Conventional PR` must be green at the current head.
   Real failures return to the builder on the same branch; cancelled or superseded
   runs are ignored. Three unsuccessful CI-fix attempts trigger escalation.
5. **Review pass:** A fresh reviewer checks implementation, design, correctness,
   security, scope, and test coverage against the issue, spec, and PR claims.
6. **Validation pass:** After review passes, a separate fresh validator, without
   seeing the review output, checks out the head and independently exercises each
   acceptance criterion, reruns tests, and verifies the claimed evidence.
7. **Verdict:** The reviewer-validator posts one formal verdict per head SHA,
   containing both passes. `APPROVE` requires both to pass; otherwise the result is
   `REQUEST_CHANGES`, with validation skipped if review failed.
8. **Iterate:** Requested changes return to the builder on the same branch, then
   repeat CI, review, and validation. There are at most three verdict rounds; a
   third changes verdict escalates to the coordinator for a maintainer decision.
9. **Merge:** Only the synthesizer merges, serially and by squash, after rechecking
   the gate at the current head. Dependencies determine merge order. Conflicting
   crew branches receive a merge of the default branch, followed by CI and a
   review of conflict resolutions plus rerun acceptance tests; semantic conflicts
   need builder work or escalation.
10. **Close-out:** The builder cleans up the worktree and build output. The
    coordinator updates tracking, unblocks dependencies, and assigns the next
    ready issue.

An explicit rereview can request another verdict at the same head. A resume resets
the round count. A draft becoming ready needs a push to trigger fresh CI; existing
merge conflicts must be resolved before PR CI can run.

## Roles

| Role               | Responsibility                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Coordinator        | Owns specs, issues, assignment, tracking, escalations, and dispatch of steering commands.                                                 |
| Builder            | Owns implementation, tests, the PR evidence, CI fixes, requested changes, and cleanup.                                                    |
| Reviewer-validator | Arranges separate review and independent validation passes, then posts the formal verdict using an account distinct from the PR author's. |
| Synthesizer        | Rechecks the merge gate, performs serial squash merges, and coordinates merges of the default branch into conflicting crew PRs.           |
| Researcher         | Supplies research for specs when asked by the coordinator; does not open PRs unless asked.                                                |

## Labels

- `crew:ready`: An issue is specified and ready for assignment to a builder.
- `crew:in-review`: A built PR is awaiting CI, review, or validation.
- `crew:changes`: The latest verdict requests changes from the builder or contributor.
- `crew:approved`: The review and validation verdict passes at its recorded head.
- `crew:escalated`: Work is paused pending a maintainer decision after escalation.
- `crew:hold`: Work is explicitly paused; automated stage work stops.
- `crew:external`: The PR comes from an outside contributor.
- `crew:spec`: The PR proposes a spec and follows the review-only path.

## Steering commands

Put the command on the **first line** of a PR conversation comment or inline review
comment. Only commands from the **maintainers' accounts** are accepted, checked
against the commenter. The coordinator is the single dispatcher: it acknowledges
the command through a review, then signals the owner. Duplicate command IDs,
edited comments, unknown commands, and other commenters do not trigger actions.

| Command                | Owner              | Effect                                                                                                                                                                                       |
| ---------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/crew hold`           | Coordinator        | Adds the hold label; automated stage work stops.                                                                                                                                             |
| `/crew resume`         | Coordinator        | Removes hold and escalation, records a resume marker, resets verdict rounds, and restarts the current stage.                                                                                 |
| `/crew rework: <note>` | Builder            | Restarts work on the same branch with the note and any inline file/line location, via a steering changes-request review; this does not count as a verdict round.                             |
| `/crew rereview`       | Reviewer-validator | Requests fresh review and independent validation at the current head, even if a verdict already exists there.                                                                                |
| `/crew merge-ok`       | Synthesizer        | Records a maintainer override as a head-bound approving review; permits merge without validation or despite escalation, but still requires green CI and mergeability. Required for spec PRs. |
| `/crew escalate`       | Coordinator        | Adds escalation, posts a blocker summary, and asks maintainers for a decision.                                                                                                               |

While held, only resume, escalate, and merge-ok commands are dispatched. Clear a
hold before merging. Resume re-requests review when no verdict exists, returns
changes to the builder, or re-signals the synthesizer for an approved head.

Issue comments do not steer work. Use assignment, labels, or the coordinator for
issues. For outside PRs, the coordinator may need to attach a steering watch first.
Automated output goes in review bodies, with file/line citations rather than inline
comments. Automated text never starts a line with a steering command.

## Merge gate

The synthesizer rechecks all of the following immediately before merging:

- A formal reviewer approval at the **current head SHA**, with passing review and
  validation sections and a matching verdict marker, or a maintainer
  `/crew merge-ok` approval marker bound to that head. No later changes-request
  review may supersede it.
- Required checks, including `CI OK` and `Conventional PR`, are green at that head.
  An override never bypasses CI.
- The PR is non-draft, mergeable, and targets the default branch.
- Neither `crew:hold` nor `crew:escalated` blocks the PR. A maintainer override can
  bypass escalation; a hold must be cleared.
- The issue is linked with `Closes #n`; spec PRs and outside PRs are exempt.

Only the synthesizer squash-merges, under a repository-wide merge lock and with a
head-commit match. If the head moves, merging stops until CI and review catch up.
The role restriction is a crew convention; shared maintainer accounts do not
independently enforce which role performs a merge.

## Evidence

Write the PR body once at creation with these sections in order:

1. **Context:** Explain why the change is needed and include `Closes #n` for the
   linked issue, subject to the exceptions above.
2. **Changes Made:** Describe the changes per file.
3. **Testing Done:** List the tests and scenarios exercised.
4. **Test Output:** Include real output excerpts and relevant artifacts.
5. **Acceptance Evidence:** Provide a table with one row per numbered criterion:
   criterion, how met, and proof. Give test results, command output, or artifact
   links; explain any justified N/A.
6. **Risks / Not Done:** State gaps, follow-ups, and deliberate exclusions.

Finish with the crew's hidden builder metadata marker followed by the builder's
signature as the last line. Put later evidence in a fix-round review note rather
than editing the PR body, which can rerun checks. Each fix note links findings to
changed commits and proof.

A formal verdict contains the head SHA and round, a review section with a
pass/changes result and severity-ranked findings citing file/line and the violated
spec clause or PR claim, and a validation section. Validation maps each acceptance
criterion from the builder's claim to independent commands, output, or artifacts
and an agrees/disagrees/unverified result, listing anything not independently
checked. Validation passes only when all criteria agree or have justified N/A,
with no contradicted claims; a failed review explicitly marks validation skipped.
The formal result is `APPROVE` only when both passes pass.

Review bodies carry hidden role, pass, head SHA, round, and verdict markers so
automation can identify the evidence. These records are append-only; a newer head
supersedes older evidence. Narrative acknowledgements, fixes, and escalations use
comment reviews; the formal verdict supplies the transition signal.

## Outside contributors

Your PR receives the same review and independent validation as crew-built work.
The reviewer-validator marks it external and sends requested changes to you;
builders never push to your fork branch. Validation runs untrusted code in an
isolated sandbox without tokens or credentials. A maintainer may need to approve
workflow runs before CI and review can proceed, especially for first-time
contributors; contact the coordinator if approval is pending.
