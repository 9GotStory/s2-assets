# 12 — Material Issue / Fulfillment

Feature key: `material-issue-fulfillment`

## Purpose

บันทึกการจ่ายวัสดุจริงจาก Request + Decision ลด stock ตามของที่จ่ายจริง รองรับ partial/multiple Issue และ substitution ที่ compatible

## In Scope

- Normal Request-linked Issue
- Issue Lines + conversion snapshot
- Current-stock validation
- Multiple Issue Events
- Partial fulfillment
- Compatible substitution จาก Decision
- Remaining-to-Issue derived semantics
- Historical legacy Issue import path พร้อม provenance

## Out of Scope

- Issue without Request เป็น normal workflow
- Force negative stock
- Reservation
- การแก้ Decision history เพื่อให้ตรงของที่จ่าย
- การติดตามการบริโภคหลังออกจาก Office Stock

## Actors

- Supply Officer
- Requester (ดู fulfillment)
- Administrator

## Owned Workflow

1. โหลด Requested Item + current Decision
2. validate entitlement/compatibility/current stock ตอนจ่ายจริง
3. บันทึก Issue/Issue Lines ของจริง
4. สร้าง negative Stock Movement แบบ atomic
5. derive cumulative fulfilled + Remaining-to-Issue
6. ทำ Issue เพิ่มได้จน entitlement หมด/ถูก cancel

## Domain Concepts

- `MaterialIssue`
- `IssueLine`
- `Fulfilled Quantity`
- `Remaining-to-Issue`
- `StockMovement`
- `Substitution`

## Business Rule Routing

Canonical wording อยู่ที่ `../docs/06-business-rules.md`; Feature Brief ไม่ทำสำเนาข้อความ rule เพื่อหลีกเลี่ยง duplicated truth.

### Primary — Full responsibility

`MRQ-08–MRQ-10`, `MRQ-17–MRQ-18`, `MRQ-20`, `MRQ-22–MRQ-25`, `MRQ-36–MRQ-37`

### Primary — With shared integration

`MRQ-19`; `MRQ-29`; `MRQ-34`; `MRQ-35`

### Shared clause only

`MC-06–MC-09`; `MC-14`; `MC-19`

### Read-only / constraint reference

`MRQ-03`, `MRQ-05–MRQ-07`, `MRQ-15–MRQ-16`, `MRQ-21`, `MRQ-26–MRQ-28`, `MRQ-30–MRQ-33`, `MSL-02–MSL-08`, `MSL-12`

## Cross-Feature Responsibilities

- หลัง partial Issue feature นี้เป็นเจ้าของผลต่อ active remainder/cancellation remainder
- เป็นเจ้าของ actual issued reconciliation และ enforcement ว่า fulfilled ไม่เกิน Allowed
- ใช้ unit definitions จาก Catalog แต่เก็บ transaction snapshot ของ Issue เอง
- Issue inactive StockMaterial ได้เมื่อ stock มีและ approved fulfillment ต้องใช้
- revalidate authoritative Current Stock จาก Stock Foundation ณ เวลาจ่ายจริง


## Key Invariants

- Stock ลดเมื่อ Issue เกิดจริงเท่านั้น
- Normal Issue trace กลับ Request + Item + Decision
- validate Current Stock ณ เวลาจ่ายจริงและห้ามติดลบ
- Actual Issue ใช้ StockMaterial/Quantity/Unit ที่จ่ายจริง
- cumulative valid fulfilled ห้ามเกิน Allowed Quantity
- Substitution ต้อง compatible และห้าม overwrite Decision history
- Remaining-to-Issue ไม่ใช่ Reserved Quantity

## UX Expectations

- พัสดุเห็น stock ณ เวลาจ่าย, decision plan และ compatible substitutes
- รองรับ partial/multiple Issue โดยผู้ใช้ไม่ต้องคำนวณ cumulative เอง
- hard-block negative stock ต้องบอกปัญหาและทางเลือกที่ถูกต้อง

## Audit / Evidence

- Issue/IssueLine + movement trace กันได้
- เก็บ Original Quantity/Unit/Conversion Snapshot/Base Quantity
- legacy Issue import ต้องมี provenance และ explicit missing-source context

## Relevant NFR

- Atomic stock decrement
- Negative-stock prevention
- Quantity reconciliation
- Concurrency-safe current-stock validation

## Delivery Dependencies

- `material-request-decision`
- `material-receiving-stock-foundation`

## Open Decisions for Specify / Clarify

- permission matrix
- evidence/document requirement ของ Issue ถ้ามี
- ต้องบังคับ substitution reason หรือไม่
- cancellation/amendment/replacement representation ที่มีผลต่อ entitlement


## Clarification Candidates — Not Yet Requirements

รายการต่อไปนี้มาจากประเด็น derived guardrail เดิมที่ **ยังไม่ถูกยืนยันเป็น canonical Business Rule**. ให้ใช้เป็นคำถามใน Specify/Clarify เท่านั้น ห้าม implement เป็น requirement โดยอัตโนมัติ.

- ควรกำหนด explicit exactly-once/complete stock-effect invariant สำหรับ Issue หรือให้เป็น transaction/NFR decision ใน Plan
- ต้องยกระดับ concurrent stock mutation protection เป็น explicit business invariant เพิ่มหรือไม่

## Plan Decisions / Risks

- atomic Issue + stock movement posting
- concurrency-safe stock validation
- idempotency/duplicate-effect protection
- unit snapshot + request-semantics fulfillment reconciliation
- legacy import/provenance path แยกจาก normal operational Issue


## Done Outcome

พัสดุจ่ายจริงได้หลายครั้ง/หลาย StockMaterial อย่างถูกต้อง Stock ลดตาม business action จริง และ fulfillment/remaining คำนวณกลับ request semantics ได้.

## Handoff Boundary

Feature Brief นี้เป็น Blueprint context ไม่ใช่ `spec.md`. เมื่อเริ่มพัฒนาจริง ให้ Spec Kit สร้าง user scenarios, acceptance criteria, technical plan และ tasks จากข้อมูลนี้ร่วมกับ Blueprint canonical documents.
