# 04 — Loan / Return

Feature key: `loan-return`

## Purpose

ติดตาม temporary custody ของ Asset ภายใน/ภายนอก รองรับหลาย Asset ต่อ Loan และ partial return โดยไม่แก้ Permanent Assignment

## In Scope

- Create Loan
- Internal/external borrower context
- Multi-Asset loan
- Due date/derived overdue
- Partial/full return
- Simple condition before/after
- Optional evidence/authorizer

## Out of Scope

- Reservation/queue/sub-loan
- Formal approval workflow
- Automatic reassignment
- Repair outcome

## Actors

- Asset Custodian
- Administrator
- Read-only User

## Owned Workflow

1. ตรวจ eligibility และ active-loan overlap
2. เริ่ม Loan โดยรักษา Permanent Assignment
3. คืน Asset รายชิ้น
4. derive overdue จาก due date + return state
5. เสนอ Repair action แยกเมื่อคืนชำรุด

## Domain Concepts

- `Loan`
- `LoanItem`
- `Temporary Custody`
- `ExternalOrganization/borrower context`
- `Return fact`

## Business Rule Routing

Canonical wording อยู่ที่ `../docs/06-business-rules.md`; Feature Brief ไม่ทำสำเนาข้อความ rule เพื่อหลีกเลี่ยง duplicated truth.

### Primary — Full responsibility

`LR-02–LR-09`, `LR-11`, `LR-15–LR-16`

### Primary — With shared integration

`LR-01`; `LR-10`; `LR-12`; `LR-13`; `LR-14`

### Shared clause only

—

### Read-only / constraint reference

`MR-01–MR-10` — Permanent Assignment/history baseline

## Cross-Feature Responsibilities

- Feature นี้เป็นเจ้าของ temporary custody; Permanent Assignment ยังคงอยู่กับ Assignment feature
- Repair/Retired state เมื่อ capabilities นั้นมีแล้วต้อง block new Loan
- Damaged Return อาจเสนอ Repair action แต่ Repair feature เป็นเจ้าของการสร้าง Repair record
- Verification ใช้ Loan เป็นบริบทเท่านั้น ไม่ใช่ proof ว่าพบ Asset


## Key Invariants

- Asset เดียวห้าม Active Loan ซ้อน
- Asset ที่กำลังซ่อมหรือ Retired ห้ามเริ่ม Loan
- Loan ไม่เปลี่ยน Permanent Assignment
- Return ใช้ latest effective Permanent Assignment ณ business time ของการคืน
- ข้อมูลผู้ยืมภายนอกเก็บเท่าที่จำเป็น

## UX Expectations

- หนึ่ง Loan จัดการหลาย Asset ได้
- คืนบางส่วนได้โดยไม่ปิดรายการอื่น
- Overdue แสดงเป็น derived state ไม่ให้ผู้ใช้ปรับ status เอง

## Audit / Evidence

- Loan/Return เก็บผู้ดำเนินการและเวลา
- condition/evidence optional ตาม use case
- ประวัติ temporary custody ต้องยังอยู่แม้ Assignment เปลี่ยนระหว่าง Loan

## Relevant NFR

- Data minimization
- Overlap guard
- Temporal consistency

## Delivery Dependencies

- `asset-assignment-movement`

## Open Decisions for Specify / Clarify

- final condition vocabulary ตอนยืม/คืน
- permission matrix
- ต้องมี notification/reminder หรือไม่ — ไม่เป็น baseline จน Clarify ยืนยัน
- document/evidence storage policy

## Plan Decisions / Risks

- active-loan uniqueness/concurrency
- partial-return line state + aggregate derived state
- due-date/overdue derivation
- audit/evidence linkage เท่าที่มีจริง
- Reassignment ขณะ Loan active ต้องไม่ถูก Loan snapshot เขียนทับตอน Return


## Done Outcome

เจ้าหน้าที่ติดตามได้ว่า Asset อยู่กับใครชั่วคราว คืนแล้วกี่ชิ้น และ overdue หรือไม่ โดย Permanent Assignment ยังถูกต้อง.

## Handoff Boundary

Feature Brief นี้เป็น Blueprint context ไม่ใช่ `spec.md`. เมื่อเริ่มพัฒนาจริง ให้ Spec Kit สร้าง user scenarios, acceptance criteria, technical plan และ tasks จากข้อมูลนี้ร่วมกับ Blueprint canonical documents.
