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

## A refusal test sends a request only its rule refuses

Each refused request breaks the rule under test and nothing else, so the test goes red when that
rule goes; check it with `scripts/dev/expect-red.sh`, and several rules at once with its `--batch`
mode, which tabulates which break went red. A loop of refused payloads that asserts only
the error code hides which rule refused each one; ESLint flags such a loop over a literal array
(`eslint.config.mjs`, #155), and one from before #155 carries an exemption until a ticket
touches its file. In F006-T1 (#126), the filter-cap case sent 101 random UUIDs, which the
unknown-entry check refused as well, and it stayed green with the cap removed. It now names one
real entry 1001 times.

## An order test of a paged list splits a tie across a page break

A list query orders twice: its `LIMIT … OFFSET` picks the page's rows by one `ORDER BY`, and an
outer `ORDER BY` returns them. Tied rows on one page come back in order even when the first sort's
tiebreak is broken, so the test cannot fail. Put the tied rows on either side of a page break, as
`loan-list.test.ts` and `repair-list.test.ts` do. In F005-T3 (#101), both tests first kept their
same-day pair on one page, and breaking the tiebreak left them green.

## A rule read under a lock has a test of its order

When a write decides a rule on a fact that another write can change, and a shared lock orders the two,
a Seam A test queues the other write first with `whileHolding` and shows that the rule sees its result.
When the other write's own statement changes the fact, as a Verification Correction's `UPDATE … SET
is_voided = true` does to a revision a Repair Record cites (#132), hold that statement with `whileWriting`
and wait with `untilWaiting(table, 1, 'FOR SHARE')`.
Without it, the rule can move ahead of the lock and every test stays green. In F005-T5 (#103), the
Repair Source check read the Loan Return after the Asset lock that a Loan Correction also takes; no test
failed when the check was moved before it, and only the Spec review found the gap.

The test goes red when the read moves ahead of the lock: check it with `scripts/dev/expect-red.sh`. A
write that creates a fact reads nothing of it before the lock, so moving its read changes no answer;
test the order on a write that changes a fact that already exists. In F005-T7 (#105), the Repair Conflict
tests of a Repair Start and a Loan start stayed green with the check moved ahead of the lock; those of the
two corrections, which read what was there before them, went red.

When the rule's read itself locks the row of the fact it checks, as the active-entry check locks a
Location `FOR SHARE`, that row orders the two writes: the test holds the other write's change to it
uncommitted until the rule's read waits on it, as F006-T3 (#128) does for a Location deactivation.
Holding another row that the write also takes makes the test wait on itself.

A foreign key does not order a citing write against a void. Its check locks the cited row `FOR KEY
SHARE`, and a void's `UPDATE … SET is_voided = true` changes no key, so it takes `FOR NO KEY UPDATE`
and neither waits for the other (PostgreSQL 18, §13.3.2, Table 13.3). A write that cites a fact only
while it is not voided takes a lock the void also takes before it checks, and its order test queues
the void first. F006-T4 (#129) found this for the Verification Revision that T7 and T8 cite.

## A journey step waits for the URL it changes

A journey step that changes the URL, such as a filter link or a select that navigates, waits for that
URL with `toHaveURL` before the next step acts: a page acts on the URL it last showed. In F006-T3
(#128), a Location chosen right after the "ทั้งหมด" Discrepancy link kept the Discrepancy filter the
link had just removed.

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

When a rule must join another module's table in SQL, as a list filter does, the owning module exports
the SQL fragment from a leaf file named after its concept, and that fragment counts as one of its read
functions. `loan-item-periods.ts` gives the period of a LoanItem to both `loan-read.service.ts` and
`repair-read.service.ts` (F005-T7, #105). The guards see the table only in the leaf, so name a CTE
that holds the fragment after what it holds, not after the table: `JOIN loan_periods` reads to the guard
as the table `loan_periods`.

## A derived condition has one SQL source

When a write checks a condition that a read also derives, such as a Discrepancy, "ส่งซ่อมแล้ว" or
"ย้ายแล้ว", both use one SQL function from a leaf file (`verification-revision-read.ts`,
`repair-source-citations.ts`, `reassignment-citations.ts`). Review looks for the condition's existing
source outside the diff, where a copy shows only as new code. In F006-T7 (#132), the cited-revision
read copied the "ชำรุด" condition of `DISCREPANCY_CONDITIONS` and shipped; F006-T8 (#133) copied
"Location ไม่ตรงทะเบียน" the same way, and review caught it.
