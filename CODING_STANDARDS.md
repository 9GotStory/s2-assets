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

## An order test of a paged list splits a tie across a page break

A list query orders twice: its `LIMIT … OFFSET` picks the page's rows by one `ORDER BY`, and an
outer `ORDER BY` returns them. Tied rows on one page come back in order even when the first sort's
tiebreak is broken, so the test cannot fail. Put the tied rows on either side of a page break, as
`loan-list.test.ts` and `repair-list.test.ts` do. In F005-T3 (#101), both tests first kept their
same-day pair on one page, and breaking the tiebreak left them green.

## A rule read under a lock has a test of its order

When a write decides a rule on a fact that another write can change, and a shared lock orders the two,
a Seam A test queues the other write first with `whileHolding` and shows that the rule sees its result.
Without it, the rule can move ahead of the lock and every test stays green. In F005-T5 (#103), the
Repair Source check read the Loan Return after the Asset lock that a Loan Correction also takes; no test
failed when the check was moved before it, and only the Spec review found the gap.

## A correction keeps every stored value it replaces

A correction record lists the before and after of each stored value its write changes, side effects
included: a cascade, or a value restored from an earlier column. A Seam A test reads the correction
back after a void as well as after an amendment. In F005-T6 (#104), voiding a Repair Outcome restored
the record's cost and kept the cost it replaced nowhere; only the Spec review found it.

## An amend form compares a field the way the server stores it

An amend form counts a field as changed only when the server would store a different value: text
trimmed, an amount compared as a number, a UUID in lower case. In F005-T6 (#104), "350" over a stored
"350.00" was sent as a change and refused as "changes nothing".

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
tab and line breaks inside it and refuses the rest (`hasDisallowedControlChars`). The first review
of F004-T1 (#75) read a Condition note as one line, and the second undid the fix.

A search term follows the rule of the field it searches: the Loan list's Borrower-name search
refuses every control character (#77). A search over several fields follows the loosest of their
rules: the Repair list's search reaches the free-text symptom or work, so it keeps tab and line
breaks (#101).

## A feature's code gets its own files

Put a feature's new routes, services, integration tests and browser journeys in files named after
its domain concept, as with Feature 003's `assignment.service.ts`. The Feature 002 files
(`asset.service.ts`, `asset.routes.ts`, `asset.routes.test.ts`, `asset.spec.ts`, and the pages
`AssetSearch`, `AssetRegister`, `AssetDetail` and `AssetBulkRegister`) already run past a thousand
lines, and every change that touches one of them reads it whole. A regression journey of an
existing feature stays beside that feature's journeys, as Journey T7.17 does in `asset.spec.ts`.

In application code, SQL on an existing table stays in the module that owns the table, as
`assignment.service.ts` owns `assignment_changes`; the feature's own file holds its rules and calls
that module. A read of another module's table goes through that module's read functions too, as
`loan-read.service.ts` reads Repair Outcomes through `latestRepairOutcomesOf` (#100). For the Loan
and Repair tables, the guards in `eslint.config.mjs` hold this for SQL text that names the table.
