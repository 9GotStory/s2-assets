<!--
Sync Impact Report:
- Version change: N/A -> 1.0.0
- Modified principles: N/A
- Added sections: Core Principles (I. Authority Preservation, II. Feature-Bounded Delivery and Simplicity, III. Rootless Podman Development, IV. Server-Side Security and Data Integrity, V. Verification Against Real Invariants, VI. Human-Gated Independent Delivery), Governance
- Removed sections: N/A
- Deferred/TODOs: None
-->
# s2-assets Constitution

## Core Principles

### I. Authority Preservation
- Lower-level Spec Kit artifacts MUST NOT silently redefine explicit Product Owner decisions, the frozen `BLUEPRINT.md` (v1.0.2), active Feature Briefs, or canonical Business Rules.
- Frozen Blueprint changes require explicit Product Owner decision.
- Material technology deviations MUST follow the formal deviation process defined in `TECHNOLOGY.md`.

### II. Feature-Bounded Delivery and Simplicity
- Work one active feature at a time.
- Preserve feature boundaries and dependencies as mapped in `docs/09-feature-map.md`.
- Build only what current requirements need.
- `application-foundation` is a technical/bootstrap exception and MUST NOT become a generic shared-framework catch-all.
- Preserve the core project principle: `Simple — Structured — Sustainable`. Do not introduce speculative architecture without a current business requirement.

### III. Rootless Podman Development
- Normal local application services and infrastructure dependencies MUST run in Rootless Podman.
- Git repositories, worktrees, GitHub Spec Kit, Multica, and AGY agents MUST remain on the Fedora host.
- Container design MUST preserve OCI portability and MUST NOT couple application code directly to Podman APIs.
- Quadlet is the production service-management baseline, not a mandatory orchestration tool for day-to-day local development.
- Exact development topology and details remain Plan decisions where `TECHNOLOGY.md` marks them as Deferred.

### IV. Server-Side Security and Data Integrity
- Authorization is authoritative server-side and MUST fail closed.
- Frontend validation is not authoritative for business invariants.
- PostgreSQL constraints and transactions are part of the integrity boundary where applicable.
- Business data MUST NEVER be fabricated merely to satisfy validation or tests.
- Business audit/history MUST remain distinct from operational logging.

### V. Verification Against Real Invariants
- Testing MUST prioritize business invariants over implementation details.
- PostgreSQL transaction and concurrency semantics that matter to production MUST be verified against real PostgreSQL rather than database mocks alone.
- Verification MUST be proportionate to the scope and may include lint, typecheck, unit, integration, browser/E2E, migration, security, or container checks as applicable.
- Tests MUST NOT weaken or redefine accepted business semantics.

### VI. Human-Gated Independent Delivery
Pre-implementation delivery MUST follow the Spec Kit workflow:
`Specify → Clarify when needed → Plan → Checklist when useful → Tasks → Analyze → Human Gate`

After Human Gate, authorized implementation uses the AGY 2-role chain:
`agy-lead-reviewer → agy-developer → agy-lead-reviewer → Human Product Owner`

**Required invariants:**
- `agy-lead-reviewer` coordinates the bounded handoff and later performs review, but MUST NOT implement or modify the delegated result.
- `agy-developer` implements/reworks only and MUST NOT approve its own work.
- Review MUST inspect actual repository evidence independently rather than rely only on developer claims.
- PASS/BLOCKED returns control to the Human Product Owner; Human remains final acceptance authority.
- REWORK may return bounded findings to `agy-developer`, followed by another Lead/Reviewer review.
- A separate third reviewer agent is not required for the normal s2-assets workflow.
- No commit, push, merge, deploy, or destructive action is allowed unless the exact authorization explicitly permits it.

## Governance

- **Constitution Compliance:** All Spec, Plan, Tasks, Analyze, implementation, and independent review activities MUST comply with this Constitution.
- **Amendments:** Any changes to the Constitution require explicit Product Owner approval.
- **Rationale:** Constitution changes MUST document the rationale and confirm compatibility with higher authorities (Blueprint, Business Rules, Technology Direction).
- **Versioning Policy:** Version changes MUST follow semantic intent:
  - MAJOR: Materially incompatible governance change.
  - MINOR: New project-wide principle or materially expanded governance.
  - PATCH: Clarification with no change in meaning.
- **Justified Deviations:** Any justified deviations MUST be explicit, proportionate, and MUST NOT silently override Business Authority or Technology Direction.

**Version**: 2.0.0 | **Ratified**: 2026-10-07 | **Last Amended**: 2026-10-07
