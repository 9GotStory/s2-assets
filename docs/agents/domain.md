# Domain documentation

Use one shared domain context across this pnpm workspace. Web, API and database
packages are technical boundaries, not separate business vocabularies.

## Existing sources

- `BLUEPRINT.md` v1.0.2: frozen business/system baseline.
- `features/02-asset-registry.md`: current scope, rule routing and open decisions.
- `docs/05-domain-model.md`: established concepts and relationships, not a mandate
  to create one table or service per concept.
- `docs/06-business-rules.md`: canonical rules; Feature 002 owns ACQ-01–ACQ-08 and
  AR-01–AR-14, with AS-01–AS-04 as reference constraints.
- `docs/02-actors-and-permissions.md`: actor and authorization context.
- `docs/07-audit-and-evidence.md`: traceability and correction principles.
- `docs/08-non-functional-requirements.md`: relevant security, integrity and
  quality requirements.
- `docs/09-feature-map.md`: feature dependencies and boundaries.
- `TECHNOLOGY.md` v1.2.0: selected technical baseline.
- The approved feature specification, decisions and exact authorized ticket.

Read only relevant sections. Use established Asset, Acquisition, Stable ID,
Asset Number, Serial Number, Document, Location and OrganizationUnit vocabulary.
Do not copy canonical rules into competing domain documentation or use a skill
to redefine business requirements or introduce speculative infrastructure.

If `GLOSSARY.md` or `GLOSSARY-MAP.md` exists, read relevant terms. If applicable
ADR directories exist, read relevant decisions. Otherwise proceed without
creating them upfront. No new glossary or ADR structure is required for setup.

Record approved feature decisions by reference. Surface contradictions before
implementation; do not change frozen business authority, technical direction,
architectural/security invariants or historical Feature 001 artifacts to
accommodate a skill or runtime.
