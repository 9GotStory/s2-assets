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

## Spec Kit Usage

Use the current upstream `github/spec-kit` process through the AI agent selected
for the task. Local `.specify/` files are project state/templates, not a second
workflow system.

Pre-implementation delivery follows:

`Specify → Clarify when needed → Plan → Checklist when useful → Tasks → Analyze → Human Gate`

Implementation may begin only after the Product Owner explicitly authorizes the
bounded task or scope.

Repository governance defines authority and engineering invariants. Runtime
agent assignment, delegation, mentions, retries, and reviewer routing belong to
the active coordination system and MUST NOT be hardcoded here.

## Context Discipline

Read only the minimum current authority needed for the task.

For implementation or review:

1. read this file;
2. read the Constitution;
3. read the exact active task and only relevant spec/plan/research context;
4. read relevant Blueprint, Business Rule, and Technology sections;
5. inspect the exact diff, tests, and evidence required by the authorized scope.

Implementation executors additionally read `CLAUDE.md` when applicable.

## External Documentation and Context7

For current or version-sensitive framework/library/SDK/API/database/container
tooling behavior, verify documentation rather than relying on model memory.

Use configured Context7 MCP first when it supports the relevant technology.

- Repository-local AGY MCP config is `.agents/mcp_config.json`.
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

For an explicitly authorized implementation or corrective-revision task, the
implementation author may create one atomic candidate commit and push the
runtime-managed candidate branch for review evidence unless the Product Owner
explicitly forbids it.

That authorization does NOT include merge, deploy, destructive operations, or
starting adjacent tasks.

## Independent Delivery Invariants

- The implementation author MUST NOT approve their own work.
- Independent review MUST inspect repository evidence rather than rely only on
  implementation summaries.
- Review findings must be concrete, bounded, and tied to approved authority.
- Corrective work must remain inside the same authorized scope.
- Final acceptance belongs to the Human Product Owner.
- Runtime coordination details are operational metadata, not repository
  requirements or architecture.

## Runtime and Git Discipline

- Git repositories, Spec Kit, Multica, and AGY run on the Fedora host.
- Normal application services and infrastructure run in Rootless Podman.
- Use the runtime-managed repository/worktree supplied by the active
  coordination system.
- Do not start or restart the host Multica daemon from inside a daemon-managed
  run.
- Do not hide checkout/runtime failures with ad-hoc scratch clones.
- Keep changes bounded and reviewable.
- Product Owner remains final acceptance authority.
