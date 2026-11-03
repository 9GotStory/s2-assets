# AGENTS.md — s2-assets Repository Contract

## Authority

Use this order:

1. current explicit Product Owner decision
2. `BLUEPRINT.md` v1.0.2 FROZEN
3. active Feature Brief
4. canonical Business Rules
5. `TECHNOLOGY.md` v1.0.1
6. `.specify/memory/constitution.md`
7. approved active feature specification, decisions and tickets (historical Spec Kit artifacts for Feature 001)
8. exact authorized implementation/review scope

A downstream artifact MUST NOT silently override an upstream authority.

## Engineering Workflow — Feature 002 Onward

Claude Code CLI is the only development tool, and Matt Pocock Skills are the
engineering workflow. GitHub Spec Kit remains historical context for Feature 001
and is not the selected workflow for new features. Preserve Feature 001
implementation and historical artifacts.

Choose the path from the authority that already exists:

- **New feature:**
  `to-spec → to-tickets → Product Owner Gate → implement + tdd → code-review → Independent Review → Product Owner Merge Gate`
- **Issue with an approved specification, ticket and authorization:**
  `Existing Authority → implement + tdd → code-review → Independent Review → Product Owner Gate`

Invoke the skills the work needs. Reuse approved specifications and tickets;
revise or regenerate one only at Product Owner request.

- `to-spec`: prepare a feature specification;
- `to-tickets`: decompose an approved specification into actionable GitHub Issues;
- `implement`: implement one authorized issue or bounded scope;
- `tdd`: test-driven development at appropriate, agreed seams;
- `code-review`: review changes against the specification and engineering
  standards; the author's internal check and the Independent Reviewer's method.

`to-spec`, `to-tickets` and `implement` are user-invoked: the Product Owner
runs the slash command (for example `/implement <issue>`) to start that work.
Do not claim successful skill invocation from prompt text, downloaded
instructions or successful bindings alone. If native invocation is unavailable,
report the runtime blocker; do not simulate it with a generic prompt.

Matt Skills must preserve Product Owner decisions, the frozen Blueprint,
relevant Feature Brief, canonical Business Rules, Technology Direction and
existing architectural/security invariants. They must not redefine business
requirements or introduce speculative infrastructure. Where a skill's default
step (publishing, committing) exceeds the handoff, follow the handoff.

Implementation may begin only after the Product Owner explicitly authorizes the
bounded task or scope. Specification/ticket publication also requires Product
Owner approval. Setup, ticket existence, labels (including `ready-for-agent`)
and assignments grant no execution authority.

### Constitution compatibility

`.specify/memory/constitution.md` v6.0.0, Principle VI, records this workflow;
its Sync Impact Report carries the Product Owner decision reference. Historical
Spec Kit, Multica, AGY, Codex and ChatGPT references in canonical context
documents, including `TECHNOLOGY.md` and Feature 001 artifacts, describe earlier
delivery. They select no tooling or workflow for new work; their business and
technical authority remains unchanged.

The amendment requires Independent Review and Product Owner acceptance. It
grants no authorization to invoke `to-spec`, publish tickets, start
implementation, merge or deploy. Obtain the applicable bounded authorization
before advancing; preserve all other Constitution principles.

### Historical provenance

Until the Product Owner decision of 2026-11-03, Feature 002 work was coordinated
in Multica on the route
`codex-lead-reviewer → agy-developer → codex-lead-reviewer → ChatGPT Independent Review → Product Owner`.
Multica issues, comments and runs, `agent/agy-developer/*` branches,
`multica-agent` co-author trailers and the AGY configuration in `.agents/` are
historical provenance: evidence of earlier work, not current routing. A
Multica-era approval becomes existing authority under this workflow only when
the Product Owner confirms it on the GitHub Issue or in the session.

## Sessions and Gates

GitHub Issues in `9GotStory/s2-assets` track specifications and delivery tickets
and record Product Owner decisions; see `docs/agents/issue-tracker.md`. The
Product Owner is final authority.

The Product Owner starts every Claude Code session with a **bounded handoff**
that names the task's GitHub Issue and authorizing Product Owner decision, the
session's role, the baseline SHA, the worktree and branch, and, for review, the
exact candidate commit SHA.

- An **author** session prepares the specification, tickets, implementation or
  corrective revision the handoff names, then returns its result to the Product
  Owner.
- An **Independent Reviewer** session reviews the exact candidate, leaves it
  unchanged, and returns its verdict and findings to the Product Owner.
- Within an approved bounded task, review findings and corrective rounds need
  no new Product Owner approval; scope expansion does.
- The Product Owner approves scope, acceptance, merge and deployment.
- Work starts only from a Product Owner handoff, and merge or deployment only
  from an explicit Product Owner decision; nothing is dispatched, claimed,
  merged or deployed automatically. Do not advance to adjacent work.

## Context Discipline

Read only the minimum current authority needed for the task.

For implementation or review:

1. read this file;
2. read the Constitution;
3. read the exact active task and only relevant approved specification, decisions
   and ticket context;
4. read relevant Blueprint, Business Rule, and Technology sections;
5. inspect the exact diff, tests, and evidence required by the authorized scope.

`CLAUDE.md` adds the Claude Code procedures for author and reviewer sessions.

## External Documentation and Context7

For current or version-sensitive framework/library/SDK/API/database/container
tooling behavior, verify documentation rather than relying on model memory.

Use the Context7 MCP configured in Claude Code first when it supports the
relevant technology.

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
task's candidate branch for review evidence unless the Product Owner explicitly
forbids it.

That authorization does NOT include merge, deploy, destructive operations, or
starting adjacent tasks.

## Independent Delivery Invariants

- The implementation author MUST NOT approve their own work.
- Independent Review runs in a separate Claude Code session/context started for
  the review, never resumed, forked or delegated from the author's session.
- Independent review MUST inspect the actual candidate and repository evidence
  rather than rely only on implementation summaries.
- The author's internal `code-review` does not replace Independent Review.
- Review findings must be concrete, bounded, and tied to approved authority.
- Corrective work must remain inside the same authorized scope.
- Final acceptance belongs to the Human Product Owner.
- Session orchestration is a Product Owner operation; keep routing and dispatch
  logic out of the repository.

## Runtime and Git Discipline

- Git repositories, worktrees and Claude Code CLI run on the Fedora host.
- Normal application services and infrastructure run in Rootless Podman.
- Work in the repository/worktree and branch named in the handoff.
- Do not hide checkout/runtime failures with ad-hoc scratch clones.
- Keep changes bounded and reviewable.
- Product Owner remains final acceptance authority.
