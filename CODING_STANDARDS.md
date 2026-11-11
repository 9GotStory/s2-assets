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

## A test of absence needs a state where the thing would be there

Assert that an action or a field is absent in a state where an allowed actor sees it. In F004-T1
(#75), a Read-only User's missing action was asserted on an Asset already On Loan, where nobody is
offered it, and a 404 came from a URL no route serves. Neither test could fail.

A test that a value is absent searches for the whole value, such as the full phone number. In
F004-T6 (#80), `not.toContain('090')` over JSON that holds UUIDs failed whenever a UUID held "090".

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

A new concept that a user sees, such as a status, an action or a domain term, gets its
`GLOSSARY.md` entry in the same change. In F004-T5 (#79), the Loan status "ปิดแล้ว" reached its
pull request with no entry, and neither review round flagged it. A form field's label, such as
"ค่าใช้จ่าย" or "เอกสารอ้างอิง", needs no entry of its own unless it names a domain term (#99, PO
decision on the F005-T1 retro).

## A text field's kind decides its control characters

A name, a phone number or a token is one line and refuses every control character
(`hasStrictControlChars`). A new one is checked before it is trimmed, so a line break at its end is
refused, not dropped. Free text, such as a document reference, a remark, a note or a reason, keeps
tab and line breaks inside it and refuses the rest (`hasDisallowedControlChars`). A search term
follows the rule of the field it searches: the Loan list's Borrower-name search refuses every
control character (#77). The first review of F004-T1 (#75) read a Condition note as one line, and
the second undid the fix.

## A feature's code gets its own files

Put a feature's new routes, services, integration tests and browser journeys in files named after
its domain concept, as with Feature 003's `assignment.service.ts`. The Feature 002 files
(`asset.service.ts`, `asset.routes.ts`, `asset.routes.test.ts`, `asset.spec.ts`, and the pages
`AssetSearch`, `AssetRegister`, `AssetDetail` and `AssetBulkRegister`) already run past a thousand
lines, and every change that touches one of them reads it whole. A regression journey of an
existing feature stays beside that feature's journeys, as Journey T7.17 does in `asset.spec.ts`.

In application code, SQL on an existing table stays in the module that owns the table, as
`assignment.service.ts` owns `assignment_changes`; the feature's own file holds its rules and calls
that module. A read may join another module's table to show or filter by its names; a write, a lock
or a check that decides a rule goes through the owner.
