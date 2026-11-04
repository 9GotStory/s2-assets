<!--
Sync Impact Report:
- Version change: 3.0.0 -> 4.0.0
- Modified principles: VI. Human-Gated Independent Delivery
- Rationale: decouple repository governance from Multica/agent-specific routing while preserving author-reviewer separation and Human final acceptance
- Added sections: None
- Removed sections: None
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

After Human Gate, authorized implementation MUST preserve independent authorship
and review without hardcoding runtime-specific agent topology into repository
governance.

**Required invariants:**
- The implementation author MUST NOT independently approve their own work.
- Independent review MUST inspect actual repository evidence rather than rely only on implementation claims.
- Review findings and corrective revisions MUST remain bounded by the approved task/scope.
- Final acceptance belongs to the Human Product Owner.
- Runtime agent assignment, delegation, mentions, retries, and reviewer routing are operational coordination concerns and MUST NOT redefine repository authority.
- Authorization of a bounded implementation/rework task includes creating one atomic candidate commit and pushing the runtime-managed candidate branch for independent review, unless the Product Owner explicitly forbids it.
- Merge, deploy, destructive operations, and adjacent tasks remain outside that authorization and require explicit Product Owner approval.

## Governance

- **Constitution Compliance:** All Spec, Plan, Tasks, Analyze, implementation, and independent review activities MUST comply with this Constitution.
- **Amendments:** Any changes to the Constitution require explicit Product Owner approval.
- **Rationale:** Constitution changes MUST document the rationale and confirm compatibility with higher authorities (Blueprint, Business Rules, Technology Direction).
- **Versioning Policy:** Version changes MUST follow semantic intent:
  - MAJOR: Materially incompatible governance change.
  - MINOR: New project-wide principle or materially expanded governance.
  - PATCH: Clarification with no change in meaning.
- **Justified Deviations:** Any justified deviations MUST be explicit, proportionate, and MUST NOT silently override Business Authority or Technology Direction.

**Version**: 4.0.0 | **Ratified**: 2026-10-07 | **Last Amended**: 2026-10-08
