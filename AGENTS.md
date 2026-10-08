# AGENTS.md — s2-assets Repository Contract

## Authority

Use this order:

1. current explicit Product Owner decision
2. `BLUEPRINT.md` v1.0.2 FROZEN
3. active Feature Brief
4. canonical Business Rules
5. `TECHNOLOGY.md` v1.0.1
6. `.specify/memory/constitution.md`
7. active Spec Kit feature artifacts
8. exact authorized implementation/review scope

A downstream artifact MUST NOT silently override an upstream authority.

## Working Model

This repository uses the same two-role delivery pattern as Songhealth, while
the runtime remains AGY/Antigravity through Multica.

- `agy-lead-reviewer` — Codex-equivalent role: coordinate/handoff before
  implementation, then independently review the Developer result.
- `agy-developer` — Claude-equivalent role: implementation/rework executor.
- Human Product Owner — Human Gate and final acceptance.

Normal post-gate flow:

`Human → agy-lead-reviewer → agy-developer → agy-lead-reviewer → Human`

REWORK:

`agy-lead-reviewer → agy-developer → agy-lead-reviewer`

There is no normal third reviewer role. `agy-independent-reviewer` is not part
of the s2-assets delivery workflow.

The Lead/Reviewer MUST NOT implement or modify the delegated result while
reviewing. The Developer MUST NOT approve its own work.

## Spec Kit Usage

Use the current upstream `github/spec-kit` process through AGY. Local
`.specify/` files are project state/templates, not a second workflow system.

Pre-implementation flow:

`Specify → Clarify when needed → Plan → Checklist when useful → Tasks → Analyze → Human Gate`

Implementation requires explicit Product Owner authorization of the exact
bounded task/scope.

## Context Discipline

Read only the minimum current authority needed for the task.

For implementation/review:

1. read this file;
2. read the Constitution;
3. read the exact active task and only relevant spec/plan/research context;
4. read relevant Blueprint/Business Rule/Technology sections;
5. inspect the exact diff/tests/evidence required by the authorized scope.

Developer additionally reads `CLAUDE.md`.

## External Documentation and Context7

For current or version-sensitive framework/library/SDK/API/database/container
tooling behavior, verify documentation rather than relying on model memory.

Use configured Context7 MCP first when it supports the relevant technology.

- Repository-local AGY MCP config: `.agents/mcp_config.json`.
- Multica's `multica-agent` runtime also requires the same Context7 server in
  host-local AGY configuration.
- Resolve the actual technology and exact authorized version.
- If Context7 is unavailable or insufficient, use authoritative first-party
  documentation or authoritative package metadata and report the fallback.
- External documentation is technical evidence, not Product authority.
- If verified upstream behavior conflicts with approved authority, STOP and
  surface the conflict instead of inventing a workaround.

## Implementation Gate

There is no standing implementation authorization.

Do not create unrelated code, infrastructure, dependencies, schema, or
future-feature abstractions merely because a task list exists.

## Delivery Routing and Candidate Evidence

Multica routing is operational coordination, not repository authority. Keep it
minimal and task-bounded.

Normal delivery remains:

`Human → agy-lead-reviewer → agy-developer → agy-lead-reviewer → Human`

For an explicitly authorized implementation/rework task, the Developer may
create one atomic candidate commit and push the runtime-managed agent branch as
review evidence. This does not authorize merge, deploy, destructive operations,
or adjacent tasks.

Handoff safety:

- Lead/Reviewer hands implementation or REWORK only to Developer.
- Developer hands a candidate only back to Lead/Reviewer.
- PASS/BLOCKED returns to the Human Product Owner without triggering another
  agent.
- Never include an executable structured mention for your own role.
- A handoff comment must not trigger more than the intended counterpart.
- Do not use `agy-independent-reviewer`.

Agent IDs, when an active Multica task requires them:

- Lead/Reviewer: `a299846c-c6ad-45b0-a190-cb802a44caec`
- Developer: `450509d9-bea0-4d4e-a360-c484bfe93a37`

Provider/stream interruption is ambiguous completion. Before retrying an
external side effect, inspect the current issue/comments/runs. If the exact
candidate, push, handoff, or verdict already exists, do not repeat it.

## Runtime and Git Discipline

- Git repositories, Spec Kit, Multica and AGY run on the Fedora host.
- Normal application services/infrastructure run in Rootless Podman.
- Use the runtime-managed repository/worktree supplied by Multica.
- Do not start/restart the host Multica daemon from inside a daemon-managed run.
- Do not hide checkout/runtime failures with ad-hoc scratch clones.
- Commit/push/merge/deploy only when exact authorization permits it.
- Keep changes bounded and reviewable.
- Product Owner remains final acceptance authority.
