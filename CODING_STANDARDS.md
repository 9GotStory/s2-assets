# Coding standards

These are the judgement calls that `/code-review` applies to a diff on its Standards axis. Tooling
enforces the mechanical rules instead: ESLint (`eslint.config.mjs`), `scripts/check-glossary.sh`
and CI.

## Every capability gate has an isolating test

A Seam A test covers each capability check that a change adds or touches:
- it denies that one capability, through `withCapabilityAnswer` in
  `apps/api/tests/integration/support/capability-helpers.ts`;
- it asserts the refusal and, for a route that can commit a write, that nothing was written.

Roles grant capabilities together, so the role map can hide a gate that fails open. In F003-T1
(#51), a registration refused for `assignment:reassign` answered 403 and still committed the Asset.
Only the isolating test showed it.

## Helpers decide, handlers reply

A route helper returns a decision, such as a boolean or a result, and the route handler sends the
reply. A Fastify `Reply` is thenable, so awaiting a helper that returns `reply.send(…)` yields
`undefined`, and the handler runs on. ESLint refuses a `Promise<FastifyReply>` annotation in
`apps/api/src`; review catches the unannotated form.

## Each name says its concept in the glossary's words

`scripts/check-glossary.sh` refuses a new name or label that contains a term `GLOSSARY.md` avoids.
It lets through any name that already exists, so review judges whether new code reuses an existing
name for a new concept. In F003-T1, the first draft typed the Current Assignment with Feature
002's `AssetReferenceContext`.

## A feature's code gets its own files

Put a feature's new routes, services, integration tests and browser journeys in files named after
its domain concept, as with Feature 003's `assignment.service.ts`. The Feature 002 files
(`asset.service.ts`, `asset.routes.ts`, `asset.routes.test.ts`, `asset.spec.ts`, and the pages
`AssetSearch`, `AssetRegister`, `AssetDetail` and `AssetBulkRegister`) already run past a thousand
lines, and every change that touches one of them reads it whole. A regression journey of an
existing feature stays beside that feature's journeys, as Journey T7.17 does in `asset.spec.ts`.

In application code, SQL on an existing table stays in the module that owns the table, as
`assignment.service.ts` owns `assignment_changes`; the feature's own file holds its rules and calls
that module.
