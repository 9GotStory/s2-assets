# Domain documentation

Use one shared domain context across this pnpm workspace. Web, API and database
packages are technical boundaries, not separate business vocabularies.

## Existing sources

- `BLUEPRINT.md` v1.0.2: frozen business/system baseline.
- The active Feature Brief in `features/`: current scope, rule routing and open
  decisions.
- `GLOSSARY.md`: the shared domain language, terms only.
- `docs/adr/`: hard-to-reverse decisions and their reasons.
- `docs/05-domain-model.md`: established concepts and relationships, not a mandate
  to create one table or service per concept.
- `docs/06-business-rules.md`: canonical rules; each Feature Brief routes the rules
  its feature owns.
- `docs/02-actors-and-permissions.md`: actor and authorization context.
- `docs/07-audit-and-evidence.md`: traceability and correction principles.
- `docs/08-non-functional-requirements.md`: relevant security, integrity and
  quality requirements.
- `docs/09-feature-map.md`: feature dependencies and boundaries.
- `TECHNOLOGY.md` v1.2.0: selected technical baseline.
- The approved feature specification, decisions and exact authorized ticket.

Read only relevant sections. Use the terms in `GLOSSARY.md` and the established
Asset, Acquisition, Stable ID, Asset Number, Serial Number and Document vocabulary.
Do not copy canonical rules into competing domain documentation or use a skill
to redefine business requirements or introduce speculative infrastructure.

Read the relevant terms in `GLOSSARY.md` and the relevant decisions in
`docs/adr/`. Add to them as terms and decisions settle, following the
`domain-modeling` skill.

Record approved feature decisions by reference. Surface contradictions before
implementation; do not change frozen business authority, technical direction,
architectural/security invariants or historical Feature 001 artifacts to
accommodate a skill or runtime.
