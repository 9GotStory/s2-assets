# 06 — Annual Asset Verification

Feature key: `annual-asset-verification`

## Purpose

รองรับรอบตรวจครุภัณฑ์ที่เก็บ scope/context ณ เวลาตรวจ, ผลพบ/ไม่พบ, discrepancy และ revision โดยไม่แก้ Registry อัตโนมัติ

## In Scope

- Verification Round
- Controlled/traceable scope snapshot
- Manual search/QR identification
- Found/Not Found + condition/context
- Observed Location/discrepancy
- Re-verification/revision
- Close/reopen/correction semantics

## Out of Scope

- GPS inspection
- Route/approval engine
- Mandatory photo
- Automatic reassignment/repair/retirement
- Automatic inclusion ของ Asset ใหม่หลังเริ่มรอบ

## Actors

- Verification Staff
- Asset Custodian
- Administrator
- Read-only User

## Owned Workflow

1. เปิด round และสร้าง scope snapshot
2. ค้น/scan เพื่อ identify Asset
3. บันทึก current verification result
4. reverify แบบ explicit เมื่อมีการตรวจใหม่
5. แสดง pending/discrepancy summary
6. close/reopen/correct โดยรักษา history

## Domain Concepts

- `VerificationRound`
- `AssetVerification`
- `Verification Revision`
- `Scope Snapshot`
- `Discrepancy`
- `Observed Location`

## Business Rule Routing

Canonical wording อยู่ที่ `../docs/06-business-rules.md`; Feature Brief ไม่ทำสำเนาข้อความ rule เพื่อหลีกเลี่ยง duplicated truth.

### Primary — Full responsibility

`AV-01–AV-08`, `AV-10–AV-13`, `AV-18–AV-24`

### Primary — With shared integration

`AV-09`; `AV-14–AV-15`; `AV-16`; `AV-17`

### Shared clause only

—

### Read-only / constraint reference

`MR-01–MR-10`, `LR-01–LR-16`, `RM-01–RM-15` — operational context only

## Cross-Feature Responsibilities

- ผลตรวจไม่แก้ Registry/Assignment เอง; หากเลือกแก้ต้องส่งต่อ action ไป Assignment/Registry ที่เกี่ยวข้อง
- Loan/Repair เป็น context เท่านั้น ไม่ใช่หลักฐานการพบจริง
- Closed/historical round snapshot ต้องไม่ถูก Retirement ภายหลัง rewrite


## Key Invariants

- QR scan เป็น identification ไม่ใช่ verified success
- ผลตรวจไม่แก้ Assignment/Registry อัตโนมัติ
- หนึ่ง current result ต่อ Asset/round พร้อม revision history
- Not Found ไม่เท่ากับ Lost/Retired
- Asset ใหม่หลังเริ่มรอบไม่เพิ่มอัตโนมัติ แต่ผู้มีสิทธิ์เพิ่มได้แบบ traceable ตาม AV-21

## UX Expectations

- mobile-friendly สำหรับงานตรวจนับ
- scan ซ้ำต้องแสดงผลล่าสุดและเสนอ re-verification อย่างชัดเจน
- pending/discrepancy ต้องค้น/filter ได้

## Audit / Evidence

- เก็บ round snapshot และ revision history
- close/reopen/correction เก็บ actor/time/reason
- การปรับ registry ภายหลัง trace กลับ verification

## Relevant NFR

- Mobile usability
- Historical integrity
- Concurrency/duplicate-scan handling

## Delivery Dependencies

- `asset-registry`
- `asset-assignment-movement`
- `loan-return`
- `repair-maintenance`

## Open Decisions for Specify / Clarify

- final status/condition vocabulary ที่ใช้กับผลตรวจ
- permission matrix
- **AV-22:** close rule ต้องครบ 100% หรืออนุญาตปิดพร้อมรายการค้าง
- fiscal-year/calendar boundary ของ Verification Round
- document/evidence storage policy


## Clarification Candidates — Not Yet Requirements

รายการต่อไปนี้มาจากประเด็น derived guardrail เดิมที่ **ยังไม่ถูกยืนยันเป็น canonical Business Rule**. ให้ใช้เป็นคำถามใน Specify/Clarify เท่านั้น ห้าม implement เป็น requirement โดยอัตโนมัติ.

- ต้องการยกระดับหลัก “historical Verification snapshot ไม่ถูก rewrite โดย lifecycle/registry facts ที่เกิดภายหลัง” ให้เป็น explicit invariant เพิ่มจาก AV/DR rules ที่มีอยู่หรือไม่

## Plan Decisions / Risks

- snapshot persistence ที่ later lifecycle facts ไม่ rewrite
- re-verification revision model
- manual add-after-start audit trail
- movement reconciliation around Count/Effective/Recorded timing
- closed-round correction/reopen mechanism ตาม clarified rule


## Done Outcome

ผู้ตรวจทำรอบตรวจและอธิบายได้ว่า ณ เวลานั้นตรวจอะไร พบอะไร และแก้อะไรภายหลัง โดยไม่ทำลาย registry/history.

## Handoff Boundary

Feature Brief นี้เป็น Blueprint context ไม่ใช่ `spec.md`. เมื่อเริ่มพัฒนาจริง ให้ Spec Kit สร้าง user scenarios, acceptance criteria, technical plan และ tasks จากข้อมูลนี้ร่วมกับ Blueprint canonical documents.
