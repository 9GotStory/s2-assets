# Current Stock is summed from append-only Stock Movements

MSL-03 makes Current Stock a state derived from Stock Movements, MSL-06 allows a stored copy only if
it reconciles with them, and MADJ-02 leaves reversal against delta to the plan. On 2026-11-24, in the
Feature 010 grilling session (Q18, Q26), the Product Owner chose to keep no stored quantity at all:
Current Stock is the sum of a Stock Material's Stock Movements each time it is read, a Stock
Movement is only ever added, and the database refuses to change or remove one. A Receipt Correction
that changes stock therefore adds a Reversal of the earlier Stock Movement in full, on that one's
Effective Date, and a new Stock Movement for what did happen. Features 011 to 014 read and add to
the same Stock Movements. The Feature 010 specification records the decision with the Product
Owner's words.

## Considered options

- Keep a quantity on each Stock Material, updated with every Stock Movement. Rejected: two sources
  of one fact need a reconciliation that nothing in the office would run, and at the office's volume
  the sum costs little. A stored copy can be added later without changing what Current Stock means.
- Correct by a single Stock Movement of the difference. Rejected: a difference cannot say that the
  Stock Material itself or the Received Date was wrong, and a reader has to add movements up to see
  what the Material Receipt now says.
