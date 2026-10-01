# 10 — Material Receiving & Stock Foundation

Feature key: `material-receiving-stock-foundation`

## Purpose

สร้าง authoritative Stock Movement/current stock สำหรับ One Logical Office Stock ผ่าน Receiving และ Opening Balance โดยแยก business facts จาก raw balance

## In Scope

- Material Receipt + lines
- Receipt effective action / draft no-effect
- Opening Balance สำหรับ initialization/migration
- Source Party context
- Optional receipt evidence/price reference
- Authoritative Stock Movements
- Derived/reconciled Current Stock
- Effective Date vs Recorded At/Fiscal reporting context

## Out of Scope

- Procurement/approval/payment
- Inventory valuation
- Multi-location warehouse/transfer
- Raw ledger editing
- Annual reset/opening balance ทุกปี

## Actors

- Supply Officer
- Administrator
- Read-only User

## Owned Workflow

1. บันทึก Receipt draft โดยยังไม่เปลี่ยน stock
2. ยืนยันรับจริงแล้วสร้าง positive movements
3. นำเข้ายอดตั้งต้นผ่าน Opening Balance พร้อม provenance
4. derive/reconcile Current Stock จาก authoritative movements
5. แก้ transaction ที่มีผลแล้วผ่าน correction semantics ไม่ silent overwrite

## Domain Concepts

- `MaterialReceipt`
- `ReceiptLine`
- `SourceParty`
- `OpeningBalance`
- `StockMovement`
- `Current Stock projection`
- `Fiscal Year context`

## Business Rule Routing

Canonical wording อยู่ที่ `../docs/06-business-rules.md`; Feature Brief ไม่ทำสำเนาข้อความ rule เพื่อหลีกเลี่ยง duplicated truth.

### Primary — Full responsibility

`MRC-01–MRC-11`, `MOB-01–MOB-04`, `MSL-01–MSL-12`

### Primary — With shared integration

—

### Shared clause only

`MC-06–MC-09`; `MC-14`; `MC-15`; `MC-16`; `MC-19`; `MC-20`; `MC-21`

### Read-only / constraint reference

`MC-01–MC-05`, `MC-10–MC-13`, `MC-17–MC-18`, `MC-22–MC-26` — catalog semantics constrain stock movements but do not transfer implementation ownership

## Cross-Feature Responsibilities

- เป็นเจ้าของ authoritative movement ledger/current-stock derivation ที่ทุก stock feature ใช้ร่วมกัน
- เป็นเจ้าของ Opening Balance, reusable Source Party และ Receiving-context traceability
- normal new Receiving ไม่ควรเสนอ inactive StockMaterial เป็น default แต่ historical/correction access ต้องยังมี
- Low Stock เปิดใช้เมื่อ authoritative Current Stock มีจริง; ไม่สร้าง placeholder ก่อนหน้า
- เป็นแหล่งยืนยันว่ามี stock-affecting history เพื่อ enforce Base Unit freeze


## Key Invariants

- One Logical Office Stock ใน v1
- Current Stock derive/reconcile จาก authoritative movements
- Receipt draft ไม่เปลี่ยน stock; receipt มีผลเมื่อรับของจริง
- Opening Balance ใช้ initialization/migration เท่านั้น
- stock-affecting transaction เก็บ Original Quantity/Unit + Conversion Snapshot + Base Quantity
- ห้ามแก้ Current Stock/raw ledger โดยตรง

## UX Expectations

- Receiving line รองรับหน่วยที่ทำงานจริงและระบบ normalize ให้
- Source Party ใช้ lightweight reusable reference ไม่ใช่ vendor master
- Current Stock/Low Stock ค้นและ filter ได้ตาม operational need

## Audit / Evidence

- Receipt/Opening Balance/Movement เก็บ Effective Date และ Recorded At/By
- Receipt correction trace original/new value/reason
- Opening Balance ต้องมี provenance
- receipt-level evidence เป็น default เมื่อมีเอกสารจริง

## Relevant NFR

- Ledger reconciliation
- Transaction atomicity
- Quantity precision
- Migration provenance

## Delivery Dependencies

- `material-catalog-units`

## Open Decisions for Specify / Clarify

- permission matrix
- fiscal-year/calendar boundary
- ต้องมี notification หรือไม่ — ไม่เป็น baseline จน Clarify ยืนยัน
- Material Source Type vocabulary
- Receipt lifecycle terminology
- กรณี received quantity กับ accepted/usable quantity ที่อาจต่างกัน
- document/evidence storage policy
- migration/opening-balance source


## Clarification Candidates — Not Yet Requirements

รายการต่อไปนี้มาจากประเด็น derived guardrail เดิมที่ **ยังไม่ถูกยืนยันเป็น canonical Business Rule**. ให้ใช้เป็นคำถามใน Specify/Clarify เท่านั้น ห้าม implement เป็น requirement โดยอัตโนมัติ.

- ควรกำหนด explicit invariant ว่า stock-affecting source action ต้องสร้าง stock effect ให้ครบและเพียงครั้งเดียวหรือไม่
- Concurrency ระหว่าง stock mutations ต้องมี invariant ระดับ Blueprint เพิ่มจาก NFR ปัจจุบันหรือปล่อยให้ Plan ออกแบบตามธุรกรรมจริง
- Opening Balance ต้องมี explicit as-of cutover/trust-reconciliation rule เพิ่มจาก MOB-01–04 หรือไม่
- เมื่อแก้ source transaction ต้องกำหนด explicit rule ป้องกัน dependent records ถูก orphan/invalidated หรือไม่

## Plan Decisions / Risks

- movement ledger + current-stock reconciliation strategy
- atomic source/effect posting + idempotency/concurrency control
- Opening cutover/reconciliation/trust checks
- receipt correction path ที่ไม่ silent overwrite
- source/evidence storage และ optional price reference โดยไม่ทำ valuation


## Done Outcome

ระบบคำนวณยอด stock ที่เชื่อถือได้จาก Receiving/Opening Balance และพร้อมเป็นฐานให้ Decision/Issue/Return/Stocktake โดยไม่เปิดทางแก้ยอดตรง ๆ.

## Handoff Boundary

Feature Brief นี้เป็น Blueprint context ไม่ใช่ `spec.md`. เมื่อเริ่มพัฒนาจริง ให้ Spec Kit สร้าง user scenarios, acceptance criteria, technical plan และ tasks จากข้อมูลนี้ร่วมกับ Blueprint canonical documents.
