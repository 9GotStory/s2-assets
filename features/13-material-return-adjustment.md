# 13 — Material Return / Adjustment / Correction

Feature key: `material-return-adjustment`

## Purpose

รองรับการคืนวัสดุและการแก้ยอด/transaction ตามข้อเท็จจริงโดยแยก Return, Correction และ Adjustment ชัดเจน และไม่แก้ Current Stock ตรง ๆ

## In Scope

- Usable/Unusable Material Return
- Trace Return → original Issue เมื่อมี
- Issue correction/reversal
- Known transaction correction
- Unknown physical discrepancy adjustment
- Replacement/re-fulfillment linkage เมื่อมีเหตุจริง
- Traceable stock effects

## Out of Scope

- Damaged/quarantine warehouse
- Generic raw balance edit
- ใช้ Return เพื่อกลบ Issue error
- สร้าง Receipt/Issue ปลอมเพื่อปรับยอด

## Actors

- Supply Officer
- Administrator
- Read-only User

## Owned Workflow

1. รับ Return และระบุของจริง/จำนวน/หน่วย
2. เพิ่ม stock เฉพาะ usable quantity
3. แยก unusable path ไป adjustment semantics
4. แก้ transaction ผิดผ่าน correction/reversal
5. ปรับ discrepancy ที่ไม่ผูก source transaction ผ่าน Adjustment
6. เชื่อม replacement/re-fulfillment แบบ explicit เมื่อจำเป็น

## Domain Concepts

- `MaterialReturn`
- `ReturnLine`
- `StockAdjustment`
- `Correction/Reversal`
- `Replacement entitlement`
- `StockMovement`

## Business Rule Routing

Canonical wording อยู่ที่ `../docs/06-business-rules.md`; Feature Brief ไม่ทำสำเนาข้อความ rule เพื่อหลีกเลี่ยง duplicated truth.

### Primary — Full responsibility

`MRT-01–MRT-05`, `MADJ-01–MADJ-07`, `MRQ-38–MRQ-40`

### Primary — With shared integration

—

### Shared clause only

`MC-06–MC-09`; `MC-14`; `MC-19`

### Read-only / constraint reference

`MRQ-20`, `MSL-03–MSL-08`, `MSL-12`

## Cross-Feature Responsibilities

- Return/Adjustment/Correction ใช้ unit definitions จาก Catalog แต่เก็บ transaction snapshot ของตน
- ต้อง post effects เข้า authoritative ledger เดียวกับ Receiving/Issue ไม่สร้าง balance model ใหม่
- Inactive StockMaterial ต้องยังเข้าถึงได้สำหรับ source-linked historical Return/Correction
- Normal Return ไม่เปลี่ยน Decision/Issued history หรือ entitlement โดยอัตโนมัติ


## Key Invariants

- Return เป็น business event แยกจาก Issue
- Normal Return ไม่ลด/overwrite Issued history และไม่ reopen entitlement อัตโนมัติ
- Known transaction error ใช้ Correction; unknown discrepancy ใช้ Adjustment
- เฉพาะ usable return เพิ่ม usable stock
- Current Stock เปลี่ยนผ่าน traceable movements เท่านั้น
- Replacement ต้อง explicit ไม่เพิ่ม Allowed Quantity แบบเงียบ ๆ

## UX Expectations

- ผู้ใช้ต้องเลือก action ตามข้อเท็จจริง: Return / Correct / Adjust
- แสดง original transaction context เมื่อมี
- reason/provenance ชัดโดยไม่บังคับเอกสารทุกกรณี

## Audit / Evidence

- ทุก stock effect trace source action
- Correction trace original transaction และรักษา history
- Adjustment เก็บ Effective Date, Recorded By/At, reason และ quantity snapshot
- Evidence optional ตามความเสี่ยง/use case

## Relevant NFR

- Ledger integrity
- Correction traceability
- Atomic stock effect

## Delivery Dependencies

- `material-issue-fulfillment`
- `material-receiving-stock-foundation`

## Open Decisions for Specify / Clarify

- permission matrix
- document/evidence storage policy
- replacement/re-fulfillment representation เมื่อมีเหตุจริง


## Clarification Candidates — Not Yet Requirements

รายการต่อไปนี้ยังควรตัดสินใน Specify/Clarify เพราะไม่จำเป็นต้อง freeze เป็น canonical rule เพิ่มใน Blueprint v1.0.2:

- Backdated correction ที่เป็นความจริงแต่ทำให้ช่วงเวลาหนึ่งดูผิดปกติควรมีรูปแบบ recording/reconciliation ใน feature นี้อย่างไร โดยต้องไม่ละเมิด `MSL-07`, `MSL-12` และ `MADJ-02`

ประเด็น complete/single stock effect, concurrency, dependent-reference integrity, source-linked Return, returnable quantity, unusable-return double-decrement prevention และ historical inactive StockMaterial ถูกกำหนดแล้วโดย `MSL-04`, NFR กลาง, `MADJ-02`, `MRT-02`, `MRT-05` และ `MC-14` ตามลำดับ.

## Plan Decisions / Risks

- returnable-quantity validation
- correction/reversal linkage + downstream reconciliation
- backdated truthful correction ที่ surface negative historical/current integrity condition แทน fabricate facts
- usable-stock basis และ double-decrement prevention
- inactive historical StockMaterial lookup path


## Done Outcome

ระบบคืน/แก้/ปรับ stock ได้ตามข้อเท็จจริงโดยยอดและ fulfillment history ยังอธิบายย้อนหลังได้ และไม่มี direct balance edit.

## Handoff Boundary

Feature Brief นี้เป็น Blueprint context ไม่ใช่ `spec.md`. เมื่อเริ่มพัฒนาจริง ให้ Spec Kit สร้าง user scenarios, acceptance criteria, technical plan และ tasks จากข้อมูลนี้ร่วมกับ Blueprint canonical documents.
