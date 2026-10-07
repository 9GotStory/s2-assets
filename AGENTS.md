# AGENTS.md — AGY Project Adapter

## Default Roles

This project uses three role-separated Multica agents after the Human Gate:

- `agy-lead-reviewer` — Lead Orchestrator / Planner
- `agy-developer` — Implementation Author
- `agy-independent-reviewer` — Independent Reviewer

The Product Owner remains final authority.

## Shared Authority

All roles MUST respect, in order:

1. explicit current Product Owner decision
2. `BLUEPRINT.md` v1.0.2 FROZEN
3. active Feature Brief
4. canonical Business Rules
5. `TECHNOLOGY.md` v1.0.1 for technical direction
6. Constitution
7. active Spec Kit artifacts
8. exact authorized Multica task/scope

Lower-level artifacts MUST NOT silently redefine higher authority.

## External Documentation and Context7

For current or version-sensitive behavior of frameworks, libraries, SDKs, APIs,
database tooling, container tooling, and developer tooling, agents MUST verify
the relevant documentation instead of relying on model memory.

Use the configured Context7 MCP as the first documentation source when it
supports the relevant technology.

- The workspace MCP definition is `.agents/mcp_config.json`; the expected server
  name is `context7`.
- Resolve documentation for the actual library/tool and exact version relevant
  to the approved plan, manifest, lockfile, or authorized task.
- Use Context7 to verify supported APIs, configuration, compatibility,
  migration behavior, and current usage patterns before implementing or making
  version-sensitive technical decisions.
- If Context7 is unavailable, incomplete, or cannot establish the required
  fact, use authoritative first-party upstream documentation or authoritative
  package metadata and report the fallback source.
- Context7 and external documentation are technical evidence, not Product
  authority. Product Owner decisions, Blueprint, Technology Direction,
  Constitution, and approved Feature artifacts remain authoritative.
- When a decision materially depends on version-specific external behavior,
  record the verified conclusion and relevant version/source in implementation
  or review evidence.
- If verified upstream behavior conflicts with an approved Plan or task, STOP
  and surface the conflict instead of silently substituting a dependency,
  workaround, or architecture.

## Shared Invariants

- Developer != Reviewer.
- Lead does not implement and does not review the delegated result.
- Reviewer independently inspects repository evidence.
- One bounded authorized scope at a time.
- No silent scope expansion.
- No speculative infrastructure.
- No automatic Blueprint edits.
- Rootless Podman is the local application runtime baseline.
- Git/Spec Kit/Multica/AGY stay on the host.
- No commit/push/merge/deploy unless explicitly authorized.
- Report and STOP after the role's assigned action.

See `MASTER-PROMPT.md`, `MULTICA.md`, and `REVIEWER.md` for workflow details.
