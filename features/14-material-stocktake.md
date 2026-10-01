# 14 — Material Stocktake

Feature key: `material-stocktake`

## Purpose

รองรับรอบตรวจนับวัสดุที่รักษา expected snapshot, physical count, counted-at และ revision/reconciliation โดยไม่ auto-adjust ledger

## In Scope

- Stocktake Round + scope
- Expected/System Quantity snapshot
- Physical Quantity + Counted At
- Not Counted semantics
- Recount/revision
- Discrepancy
- Close/reopen/correction
- Reconciliation warning สำหรับ movement ใกล้/ย้อนหลัง
- Link to Adjustment เมื่อยืนยัน discrepancy

## Out of Scope

- Long-running stock lock เป็น baseline
- Automatic adjustment
- Automatic reopen
- Rewrite historical expected snapshot จาก late movement
- Mandatory 100% close rule ก่อน Clarify

## Actors

- Verification Staff
- Supply Officer
- Administrator
- Read-only User

## Owned Workflow

1. เปิด Stocktake Round และสร้าง scope/expected context
2. บันทึก physical count พร้อม Counted At
3. reconcile movement ระหว่าง reference point ถึง count
4. recount/revise แบบ explicit
5. แสดง Not Counted/Discrepancy/Pending
6. สร้าง Adjustment แยกเมื่อยืนยัน
7. close/reopen/correct โดยรักษาประวัติ

## Domain Concepts

- `MaterialStocktakeRound`
- `StocktakeItem`
- `Expected Quantity Snapshot`
- `Physical Quantity`
- `Counted At`
- `Recount Revision`
- `Discrepancy`

## Business Rule Routing

Canonical wording อยู่ที่ `../docs/06-business-rules.md`; Feature Brief ไม่ทำสำเนาข้อความ rule เพื่อหลีกเลี่ยง duplicated truth.

### Primary — Full responsibility

`MST-01–MST-18`

### Primary — With shared integration

—

### Shared clause only

`MC-06–MC-09`; `MC-14`; `MC-19`

### Read-only / constraint reference

`MSL-03`, `MSL-07–MSL-08`, `MSL-12`, `MADJ-01–MADJ-06`

## Cross-Feature Responsibilities

- ใช้ Base Unit/precision เดียวกับ Catalog เพื่อเปรียบเทียบ expected/physical
- อ่าน ledger/current context จาก Stock Foundation โดยไม่สร้าง parallel ledger
- Inactive StockMaterial ที่อยู่ใน scope ต้องยังเข้าถึงได้
- เมื่อยืนยัน discrepancy ให้ส่งต่อ Adjustment ไป Return/Adjustment feature ไม่ auto-adjust


## Key Invariants

- Not Counted ≠ Physical Quantity 0
- Stocktake ไม่แก้ Current Stock อัตโนมัติ
- scope ห้ามเปลี่ยนแบบเงียบ ๆ หลังเริ่มตรวจ
- recount/reopen/correction ต้องรักษาประวัติ
- late/backdated movement ห้าม rewrite historical snapshot แบบ silent
- Current Stock ยังคง derive จาก authoritative movements

## UX Expectations

- mobile-friendly counting
- movement conflict/warning ต้องเห็นและอธิบายได้
- Not Counted/Discrepancy/Pending filter ได้
- ผู้ตรวจไม่ต้องหยุดทั้งระบบด้วย stock lock โดย default

## Audit / Evidence

- เก็บ expected snapshot + physical count + Counted At
- revision/reopen/correction เก็บ actor/time/reason
- Adjustment ที่เกิดจาก discrepancy trace กลับ Stocktake

## Relevant NFR

- Historical snapshot integrity
- Concurrent/late movement reconciliation
- Mobile usability

## Delivery Dependencies

- `material-receiving-stock-foundation`
- `material-return-adjustment`

## Open Decisions for Specify / Clarify

- permission matrix
- fiscal-year/calendar boundary
- **MST-11:** close rule ต้องครบ 100% หรืออนุญาตปิดพร้อมรายการค้าง


## Clarification Candidates — Not Yet Requirements

รายการต่อไปนี้มาจากประเด็น derived guardrail เดิมที่ **ยังไม่ถูกยืนยันเป็น canonical Business Rule**. ให้ใช้เป็นคำถามใน Specify/Clarify เท่านั้น ห้าม implement เป็น requirement โดยอัตโนมัติ.

- ต้องยกระดับ concurrent stock mutation protection เป็น explicit business invariant เพิ่มหรือไม่
- Physical Quantity และ Expected Quantity ต้องเปรียบเทียบบน usable-stock basis เดียวกันเป็น explicit rule หรือถือว่า derive ได้จาก current ledger semantics แล้ว

## Plan Decisions / Risks

- snapshot + counted/revision persistence
- movement reconciliation around Counted At
- same usable-stock basis calculation
- close/reopen controls
- adjustment handoff ไป feature 13 โดยไม่สร้าง parallel ledger


## Done Outcome

เจ้าหน้าที่ตรวจนับและอธิบาย discrepancy ณ เวลานับได้ แม้มี movement เกิดใกล้กัน โดย ledger เปลี่ยนเฉพาะเมื่อสร้าง Adjustment แยกตามข้อเท็จจริง.

## Handoff Boundary

Feature Brief นี้เป็น Blueprint context ไม่ใช่ `spec.md`. เมื่อเริ่มพัฒนาจริง ให้ Spec Kit สร้าง user scenarios, acceptance criteria, technical plan และ tasks จากข้อมูลนี้ร่วมกับ Blueprint canonical documents.
