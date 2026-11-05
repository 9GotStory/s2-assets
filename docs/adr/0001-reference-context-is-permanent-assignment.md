# The Asset's reference context is its Permanent Assignment

Feature 002 let an Asset name a Location, OrganizationUnit and Responsible Person, with Legacy
text, at registration, and let `asset:correct` change them later
([#25, D3](https://github.com/9GotStory/s2-assets/issues/25#issuecomment-6624710964)). Feature 003
needs the same three dimensions as a Permanent Assignment with Effective Dates and a history, and
one set of values cannot carry both meanings. On 2026-11-05, in the Feature 003 grilling session,
the Product Owner made them one concept: the values given at registration become the Initial
Assignment, and afterwards they change only through a Reassignment or an Assignment Correction, so
`asset:correct` no longer edits them. The Feature 003 specification,
[#50](https://github.com/9GotStory/s2-assets/issues/50), records the decision with the Product
Owner's words and builds the assignment model on it.

## Considered options

- Keep the registration values as a separate, frozen record beside the assignment. Rejected: an
  Asset would carry two Locations.
- Let `asset:correct` keep editing the current values directly. Rejected: the current state would
  change with no event to explain it (MR-03).
