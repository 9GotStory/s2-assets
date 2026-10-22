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

For Feature 002 (`asset-registry`) and subsequent features, Matt Pocock Skills
are the selected engineering workflow. GitHub Spec Kit remains historical
context for Feature 001 and is not the selected workflow for new features.
Preserve Feature 001 implementation and historical artifacts.

Use actual native skill invocation where available:

- `setup-matt-pocock-skills`: one-time repository setup;
- `to-spec`: prepare feature specifications;
- `to-tickets`: decompose approved specifications into actionable GitHub Issues;
- `implement`: implement one authorized issue or bounded scope;
- `tdd`: test-driven development at appropriate, agreed seams;
- `code-review`: review implementation against the specification and engineering
  standards.

Do not claim successful skill invocation from prompt text, downloaded
instructions or successful bindings alone. If native invocation is unavailable,
report the runtime blocker; do not simulate it with a generic prompt.

Matt Skills must preserve Product Owner decisions, the frozen Blueprint,
relevant Feature Brief, canonical Business Rules, Technology Direction and
existing architectural/security invariants. They must not redefine business
requirements or introduce speculative infrastructure.

Implementation may begin only after the Product Owner explicitly authorizes the
bounded task or scope. Specification/ticket publication also requires Product
Owner approval; setup or ticket existence grants no execution authority.

### Constitution compatibility

`.specify/memory/constitution.md` v5.0.0, Principle VI, selects Matt Pocock Skills
for Feature 002 onward and preserves Feature 001 history. The amendment was
authorized in 9GOTSTORY-260, comment `01a16305-1a94-70fd-b321-78304b158be8`.
Historical Spec Kit workflow references in canonical context documents do not
select the workflow for new features; their business and technical authority
remains unchanged.

The documentation amendment requires Independent Review and Product Owner
acceptance. It grants no authorization to invoke `to-spec`, publish tickets,
dispatch implementation, merge or deploy. Obtain the applicable bounded
authorization before advancing; preserve all other Constitution principles.

## Coordination and Handoff

Matt Pocock Skills define the engineering workflow. Multica is the authoritative
mechanism for assigning, delegating, returning and tracking agent work. GitHub
Issues tracks specifications and delivery tickets. The Product Owner is final
authority.

The current Product Owner-approved Multica route is recorded here as
coordination metadata:

`codex-lead-reviewer → agy-developer → codex-lead-reviewer → ChatGPT Independent Review → Product Owner`

- Lead prepares plans, tickets and bounded developer handoffs.
- Developer implements only authorized work and returns the candidate and
  verification evidence through Multica.
- Lead independently reviews the developer's actual candidate.
- ChatGPT provides an additional independent assessment after Lead PASS.
- Product Owner grants final acceptance and separately authorizes merging or
  deployment.
- A developer's internal `code-review` does not replace independent Lead review.
- Once a bounded task is approved, normal Lead–Developer handoffs and corrections
  within that scope do not require repetitive Product Owner intervention.
- Scope expansion, merge, deployment and destructive operations require explicit
  authorization. Do not advance to adjacent work automatically.

Verify the active Issue, live identities, existing runs and approved route in
Multica before dispatch. Do not implement routing logic in the repository or
treat the recorded route as standing implementation authority. Runtime mentions,
assignments and retries remain Multica operations.

## Context Discipline

Read only the minimum current authority needed for the task.

For implementation or review:

1. read this file;
2. read the Constitution;
3. read the exact active task and only relevant approved specification, decisions
   and ticket context;
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

- Git repositories, engineering workflow tooling, Multica, and AGY run on the
  Fedora host.
- Normal application services and infrastructure run in Rootless Podman.
- Use the runtime-managed repository/worktree supplied by the active
  coordination system.
- Do not start or restart the host Multica daemon from inside a daemon-managed
  run.
- Do not hide checkout/runtime failures with ad-hoc scratch clones.
- Keep changes bounded and reviewable.
- Product Owner remains final acceptance authority.
