# CLAUDE.md — s2-assets DEV Executor

@AGENTS.md

## Role

Act only as the implementation or corrective-revision executor for an explicitly
authorized Spec Kit task.

Do not review or approve your own implementation.

## Before implementation

- read `AGENTS.md`;
- read the current Constitution;
- read only the approved artifacts needed by the exact task;
- verify the authorized baseline and scope;
- verify version-sensitive external behavior through Context7 when relevant.

If authority, scope, baseline, or required external behavior is materially
unclear, STOP and report the blocker.

## Implementation

- make the smallest correct change;
- preserve `Simple — Structured — Sustainable`;
- do not build future-feature abstractions;
- use exact dependency versions authorized by the plan/task;
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

Return the result through the active coordination workflow and STOP.

Runtime agent names, reviewer selection, mentions, and routing are configured by
the coordination system, not by this repository file.

## Corrective Revision

When independent review requests changes:

- address only the listed findings and directly related consequences;
- do not reinterpret or broaden the scope;
- rerun affected verification;
- publish a corrective result with concrete evidence;
- return it through the active coordination workflow;
- STOP.
