# CLAUDE.md — s2-assets Claude Code Contract

@AGENTS.md

## Role

Claude Code is the only development tool for this repository. Each session
takes the single role its bounded handoff names (`AGENTS.md`, Sessions and
Gates): **author** or **Independent Reviewer**. For Feature 002 onward, use the
Matt Pocock Skills workflow; Spec Kit remains Feature 001 history.

A session that authored a candidate never reviews or approves it. Internal
checks do not constitute independent review. This file grants no standing work
authorization.

## Agent skills

### Issue tracker

Feature 002+ specifications, tickets and Product Owner decisions live in GitHub
Issues in `9GotStory/s2-assets`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary; labels never grant execution authority.
See `docs/agents/triage-labels.md`.

### Domain docs

Use one shared domain context and the existing canonical documentation.
See `docs/agents/domain.md`.

## Before work

- read `AGENTS.md`;
- read the current Constitution;
- read only the approved artifacts needed by the exact task;
- follow Constitution v6.0.0's workflow and the gates recorded in `AGENTS.md`;
- verify every item of the bounded handoff against the GitHub Issue and the
  repository: decision, role, baseline SHA, worktree/branch and candidate;
- verify version-sensitive external behavior through Context7 when relevant.

If authority, scope, baseline, or required external behavior is materially
unclear, STOP and report the blocker.

## Implementation

- make the smallest correct change;
- preserve `Simple — Structured — Sustainable`;
- do not build future-feature abstractions;
- use exact dependency versions authorized by the specification/task;
- for Feature 002 onward, work under the `implement` skill the Product Owner
  invoked (`/implement <issue>`) for the authorized issue, using `tdd` at
  appropriate agreed seams and `code-review` as an internal check; do not
  substitute prompt text, downloaded instructions or bindings for native
  invocation evidence;
- inspect relevant existing code before editing;
- add or update tests when behavior changes;
- run verification proportional to risk;
- inspect the final diff and worktree;
- run `git diff --check` when using Git;
- commit locally (`implement` commits by default), run the internal
  `code-review` from the baseline to that commit, and fold any fixes into one
  atomic candidate commit; then, when repository/task authority permits, push
  the task's candidate branch as review evidence;
- never merge, deploy, perform destructive operations, or begin another task
  without explicit Product Owner authorization.

## Implementation Result

Report one implementation result for the exact candidate, including:

- task ID, scope and authorizing Product Owner decision;
- baseline/parent SHA when relevant;
- candidate branch and commit;
- changed files;
- skills invoked;
- verification executed and exact results;
- material Context7/first-party evidence when relevant;
- unresolved limitations or blockers.

Return the result to the Product Owner and STOP. The internal `code-review`
does not replace Independent Review or Product Owner acceptance.

## Independent Review

In a session started to review a candidate it did not author:

- confirm the candidate and baseline SHAs in the handoff match the repository;
- invoke `code-review` from the baseline to the exact candidate;
- inspect tests, verification evidence and scope against the issue and approved
  authority; rerun verification proportional to risk;
- leave the candidate unchanged;
- report the verdict, PASS or CHANGES REQUESTED, with concrete findings tied to
  authority and the exact results of any verification rerun;
- return the result to the Product Owner and STOP.

## Corrective Revision

When independent review requests changes:

- address only the listed findings and directly related consequences;
- do not reinterpret or broaden the scope;
- rerun affected verification;
- report a corrective result with concrete evidence;
- return it to the Product Owner for the next Independent Review;
- STOP.
