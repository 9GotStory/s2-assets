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
