# CLAUDE.md — s2-assets DEV Executor

@AGENTS.md

## Role

Act only as the implementation or corrective-revision executor for an explicitly
authorized feature task under `AGENTS.md`. For Feature 002 onward, use the
approved Matt Pocock Skills workflow; Spec Kit remains Feature 001 history.

Do not act as the independent reviewer or approve your own implementation.
Internal checks do not constitute independent review.

## Agent skills

### Issue tracker

Feature 002+ specifications and tickets use GitHub Issues in `9GotStory/s2-assets`;
Multica records authorization, delegation, runs and review.
See `docs/agents/issue-tracker.md`.

### Domain docs

Use one shared domain context and the existing canonical documentation.
See `docs/agents/domain.md`.

## Before implementation

- read `AGENTS.md`;
- read the current Constitution;
- read only the approved artifacts needed by the exact task;
- follow Constitution v5.0.0's feature-scoped workflow and the authorization gates
  recorded in `AGENTS.md`;
- verify the authorized baseline and scope;
- verify the bounded handoff and active Lead–Developer route in Multica;
- verify version-sensitive external behavior through Context7 when relevant.

If authority, scope, baseline, or required external behavior is materially
unclear, STOP and report the blocker.

## Implementation

- make the smallest correct change;
- preserve `Simple — Structured — Sustainable`;
- do not build future-feature abstractions;
- use exact dependency versions authorized by the specification/task;
- for Feature 002 onward, natively invoke `implement` for the authorized issue,
  using `tdd` at appropriate agreed seams and `code-review` as an internal check;
  do not substitute prompt text, downloaded instructions or bindings for native
  invocation evidence;
- inspect relevant existing code before editing;
- add or update tests when behavior changes;
- run verification proportional to risk;
- inspect the final diff and worktree;
- run `git diff --check` when using Git;
- when repository/task authority permits, create one atomic candidate commit and
  push the runtime-managed candidate branch as review evidence;
- never merge, deploy, perform destructive operations, or begin another task
  without explicit Product Owner authorization.

## Implementation Result

Publish one implementation result for the exact candidate, including:

- task ID and scope;
- baseline/parent SHA when relevant;
- candidate branch/commit or run artifact;
- changed files;
- verification executed and exact results;
- material Context7/first-party evidence when relevant;
- unresolved limitations or blockers.

Return the result to the authorized Lead through Multica and STOP. The internal
`code-review` does not replace Lead review, ChatGPT Independent Review or Product
Owner acceptance. Normal bounded handoffs do not require repeated Product Owner
approval; scope expansion and integration remain separately authorized.

The current approved coordination route is recorded in `AGENTS.md`; verify live
assignment, identity and routing in Multica. This file grants no standing work
authorization and does not implement runtime routing.

## Corrective Revision

When independent review requests changes:

- address only the listed findings and directly related consequences;
- do not reinterpret or broaden the scope;
- rerun affected verification;
- publish a corrective result with concrete evidence;
- return it through the active coordination workflow;
- STOP.
