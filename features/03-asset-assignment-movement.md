# 03 — Asset Assignment & Movement

Feature key: `asset-assignment-movement`

## Purpose

ดูแล Permanent Assignment และการเปลี่ยนแปลงตาม business time โดยแยกจาก temporary custody และ repair state อย่างชัดเจน

## In Scope

- Initial Assignment
- Reassignment ของ Location/OrganizationUnit/Responsible Person
- Effective Date vs Recorded At
- Backdated movement/conflict detection
- Bulk reassignment เมื่อมี use case
- Traceable correction ของ assignment facts

## Out of Scope

- Loan/Return temporary custody
- Repair state
- HR workflow
- การแก้ Assignment อัตโนมัติจาก Verification

## Actors

- Asset Custodian
- Administrator
- Read-only User

## Owned Workflow

1. กำหนด initial assignment เมื่อข้อมูลพร้อม
2. บันทึก reassignment เป็น business event
3. derive Current Assignment จาก latest effective valid fact
4. รองรับ backdate พร้อม surface conflict
5. ทำ correction โดยรักษา history ตามข้อเท็จจริง

## Domain Concepts

- `Assignment`
- `AssetEvent`
- `Location`
- `OrganizationUnit`
- `Person`
- `Effective Date`
- `Recorded At`

## Business Rule Routing

Canonical wording อยู่ที่ `../docs/06-business-rules.md`; Feature Brief ไม่ทำสำเนาข้อความ rule เพื่อหลีกเลี่ยง duplicated truth.

### Primary — Full responsibility

`AS-01–AS-10`, `MR-01–MR-10`

### Primary — With shared integration

`MR-14–MR-19`

### Shared clause only

`MR-11–MR-12`; `MR-13`

### Read-only / constraint reference

`AR-02`, `AR-07` — Stable ID/history baseline

## Cross-Feature Responsibilities

- Verification เป็นผู้สร้างผลตรวจ แต่ Reassignment/Correction ที่เกิดจากผลตรวจเป็น responsibility ของ feature นี้
- Temporary custody ต้อง route ไป Loan ไม่ใช้ Reassignment แทน
- ระหว่าง Loan/Repair สามารถ Reassign Permanent Assignment ได้ แต่ต้องไม่เปลี่ยน custody/repair state


## Key Invariants

- Location, OrganizationUnit, Responsible Person เป็นคนละมิติ
- Responsible Person ไม่บังคับทุก Asset
- Temporary custody ห้ามแทนด้วย Reassignment
- Loan/Repair ไม่เปลี่ยน Permanent Assignment โดยตัวมันเอง
- Current Assignment อิง business-effective facts ไม่ใช่ recorded order อย่างเดียว

## UX Expectations

- แสดง Current Assignment พร้อม timeline ที่เข้าใจได้
- การเปลี่ยนหลาย field ในเหตุการณ์เดียวควรเป็น action เดียว
- Bulk action ต้องยังรักษาค่าก่อนเปลี่ยนราย Asset

## Audit / Evidence

- เก็บ Effective Date และ Recorded At แยกกัน
- Business reassignment ที่มีผลแล้วไม่ hard-delete ไร้ร่องรอย
- การแก้จาก Verification trace กลับ source verification

## Relevant NFR

- Temporal data integrity
- History traceability
- Exception handling

## Delivery Dependencies

- `asset-registry`

## Open Decisions for Specify / Clarify

- Location hierarchy และ Organization Unit vocabulary
- permission matrix
- bulk reassignment boundary
- document storage policy ถ้าต้องแนบ reference
- migration source สำหรับ assignment history เดิม

## Plan Decisions / Risks

- current-state projection จาก traceable assignment history โดยไม่ใช้ full event sourcing
- backdate conflict detection และ correction mechanism
- history immutability/no hard delete
- separation ของ Permanent Assignment vs later custody/repair dimensions


## Done Outcome

ระบบบอก Permanent Assignment ปัจจุบันและประวัติการย้ายได้ถูกต้อง แม้มี backdated facts, loan หรือ repair เกิดร่วมใน timeline.

## Handoff Boundary

Feature Brief นี้เป็น Blueprint context ไม่ใช่ `spec.md`. เมื่อเริ่มพัฒนาจริง ให้ Spec Kit สร้าง user scenarios, acceptance criteria, technical plan และ tasks จากข้อมูลนี้ร่วมกับ Blueprint canonical documents.
