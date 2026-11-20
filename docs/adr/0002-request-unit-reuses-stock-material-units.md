# A Request Unit converts through the Stock Material's own Units

MRQ-28 lets a Requestable Material's Request Unit reach a Stock Material's quantity either through
an explicit conversion or by reusing the Stock Material's unit conversion where the semantics truly
match. On 2026-11-20, in the Feature 009 grilling session (Q7), the Product Owner chose reuse alone:
a Stock Material is a Compatible Stock Material of a Requestable Material only while its own active
Units include the Request Unit, and the compatibility carries no number of its own. One Request
Unit is one of that Unit of the Stock Material, and its Conversion Factor takes it to the Base Unit.
A Stock Material that lacks the Request Unit gains it as an Alternate Unit before it can be
compatible, and a Units write may not make that Alternate Unit Inactive while a compatibility relies
on it (Q15). The Feature 009 specification records the decision with the Product Owner's words.

## Considered options

- Give each compatibility its own factor, "1 Request Unit = n of a Stock Material Unit". Rejected:
  two sets of numbers would describe one Stock Material, and a Base Unit change would leave the
  compatibility's numbers silently wrong.
