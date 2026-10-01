# 05 — Repair / Maintenance

Feature key: `repair-maintenance`

## Purpose

บันทึก lifecycle การส่งซ่อม/บำรุงรักษาและรับกลับ โดยคง Assignment เดิมและไม่สร้าง maintenance/work-order engine

## In Scope

- Repair/Maintenance records แบบ repeatable
- Send for repair / return result
- Repair place/source context
- Optional cost, warranty, next-recommended-maintenance date
- Source linkage จาก Loan Return/Verification เมื่อเกี่ยวข้อง

## Out of Scope

- Scheduled maintenance engine
- Work order/SLA engine
- Warranty claim workflow
- Accounting
- Automatic retirement

## Actors

- Asset Custodian
- Administrator
- Read-only User

## Owned Workflow

1. ตรวจว่าไม่มี Active Loan unresolved
2. บันทึกส่งซ่อมและ operational state
3. บันทึกข้อมูลประกอบเท่าที่มีจริง
4. รับกลับพร้อม result/condition
5. เสนอ Retirement action ภายหลังเมื่อกระบวนการภายนอกเสร็จจริง

## Domain Concepts

- `RepairMaintenanceRecord`
- `Repair operational state`
- `Warranty context`
- `Document/Source reference`

## Business Rule Routing

Canonical wording อยู่ที่ `../docs/06-business-rules.md`; Feature Brief ไม่ทำสำเนาข้อความ rule เพื่อหลีกเลี่ยง duplicated truth.

### Primary — Full responsibility

`RM-01–RM-04`, `RM-07`, `RM-09–RM-15`

### Primary — With shared integration

`RM-05`; `RM-06`; `RM-08`

### Shared clause only

—

### Read-only / constraint reference

`LR-01–LR-11`, `MR-01–MR-10` — existing Loan/Assignment baseline

## Cross-Feature Responsibilities

- Repair action ไม่เปลี่ยน Permanent Assignment
- Active Repair ต้องทำให้ new Loan ถูกปฏิเสธเมื่อ Loan capability ทำงานร่วมกัน
- รับ source context จาก damaged Loan Return หรือ Verification ได้โดยไม่ fabricate source


## Key Invariants

- Repair record แยกจาก Asset current data
- Repair ไม่เปลี่ยน Permanent Assignment
- Asset อยู่ระหว่างซ่อมห้ามยืม
- Active Loan ต้อง resolve ตามข้อเท็จจริงก่อน Repair
- “ซ่อมไม่ได้” ไม่เท่ากับ Retirement

## UX Expectations

- ส่งซ่อม/รับกลับเป็น action ตรงตามงานจริง
- ค่าใช้จ่าย/ประกัน/เอกสารเป็น optional
- ไม่บังคับผู้ใช้บริหาร status ที่ derive ได้

## Audit / Evidence

- เก็บผู้ดำเนินการและเวลา
- รักษา source context จาก Loan/Verification เมื่อมี
- ไม่ overwrite repair history เพื่อให้ current state ดูเรียบร้อย

## Relevant NFR

- Transaction consistency
- Traceability
- Simple workflow

## Delivery Dependencies

- `loan-return`
- `asset-assignment-movement`

## Open Decisions for Specify / Clarify

- final status/condition vocabulary ที่เกี่ยวกับการรับกลับ
- permission matrix
- document/evidence storage policy

## Plan Decisions / Risks

- repair lifecycle/state derivation และ active-repair guard
- integration กับ Asset current operational state โดยไม่ overwrite assignment
- evidence/provider data minimization
- ไม่สร้าง scheduled maintenance, work order, SLA, warranty-claim engines


## Done Outcome

ระบบแสดงประวัติซ่อม/บำรุงรักษาและสถานะปัจจุบันได้ โดยไม่ทำให้ Assignment หรือ Retirement semantics ผิด.

## Handoff Boundary

Feature Brief นี้เป็น Blueprint context ไม่ใช่ `spec.md`. เมื่อเริ่มพัฒนาจริง ให้ Spec Kit สร้าง user scenarios, acceptance criteria, technical plan และ tasks จากข้อมูลนี้ร่วมกับ Blueprint canonical documents.
