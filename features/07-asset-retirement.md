# 07 — Asset Retirement

Feature key: `asset-retirement`

## Purpose

บันทึกผลการจำหน่าย/สิ้นสุด lifecycle หลัง external process เสร็จจริง และหยุด operational actions ใหม่โดยรักษาประวัติทั้งหมด

## In Scope

- Record retirement result
- Effective Date vs Recorded At
- Optional external document/reference
- Active Loan/Repair guards
- Backdated conflict detection/reconciliation
- Correction with permission/audit
- Historical search/QR access

## Out of Scope

- Government disposal workflow
- Document generation
- Automatic retirement จาก Not Found/repair result
- Automatic loan return/repair close
- Delete Asset

## Actors

- Asset Custodian
- Administrator
- Read-only User

## Owned Workflow

1. ตรวจว่า Loan/Repair ไม่มี unresolved active state
2. บันทึกผล Retirement ที่เกิดจริง
3. เปลี่ยน terminal operational state
4. คง historical access
5. surface temporal conflict เมื่อ retirement ถูก backdate
6. correct ตามข้อเท็จจริงเมื่อจำเป็น

## Domain Concepts

- `AssetRetirement`
- `Terminal operational state`
- `Retirement reference/evidence`
- `Temporal conflict`

## Business Rule Routing

Canonical wording อยู่ที่ `../docs/06-business-rules.md`; Feature Brief ไม่ทำสำเนาข้อความ rule เพื่อหลีกเลี่ยง duplicated truth.

### Primary — Full responsibility

`DR-01–DR-07`, `DR-09`, `DR-12–DR-19`

### Primary — With shared integration

`DR-08`; `DR-10–DR-11`

### Shared clause only

—

### Read-only / constraint reference

`AV-01–AV-24`, `MR-01–MR-19`, `LR-01–LR-16`, `RM-01–RM-15` — preserve prior history

## Cross-Feature Responsibilities

- Retired terminal state ต้องทำให้ operational action ใหม่ เช่น Loan ถูกปฏิเสธ
- Asset ที่ Retired ก่อน snapshot ใหม่ไม่เข้ารอบใหม่; Retirement ระหว่างรอบห้ามลบ Asset ออกจาก snapshot เดิม
- Retirement ไม่ resolve Loan/Repair อัตโนมัติ


## Key Invariants

- Retirement ไม่ใช่ Delete
- Not Found/ซ่อมไม่ได้ไม่ทำให้ Retirement อัตโนมัติ
- Normal Retirement ต้องไม่มี Active Loan/Repair unresolved
- Retired Asset ห้าม operational actions ใหม่แต่ยังค้น/QR/history ได้
- Backdated conflict ห้ามแก้โดย silent rewrite

## UX Expectations

- Retired record ต้องค้นย้อนหลังได้
- guard ต้องบอกเหตุที่ทำต่อไม่ได้และ link ไป unresolved Loan/Repair
- ไม่จำลองขั้นตอนราชการภายนอกที่ระบบไม่ได้เป็นเจ้าของ

## Audit / Evidence

- เก็บ Effective Date, Recorded At/By และ reference ที่มีจริง
- Correction ต้องมี permission/reason/audit
- รักษา verification snapshot เดิมเมื่อ retirement เกิดระหว่างรอบ

## Relevant NFR

- Terminal-state integrity
- Temporal reconciliation
- Historical accessibility

## Delivery Dependencies

- `loan-return`
- `repair-maintenance`
- `annual-asset-verification`

## Open Decisions for Specify / Clarify

- Retirement type/result vocabulary
- permission matrix
- bulk retirement เมื่อมี use case
- Retirement correction semantics
- document/evidence storage policy


## Clarification Candidates — Not Yet Requirements

รายการต่อไปนี้มาจากประเด็น derived guardrail เดิมที่ **ยังไม่ถูกยืนยันเป็น canonical Business Rule**. ให้ใช้เป็นคำถามใน Specify/Clarify เท่านั้น ห้าม implement เป็น requirement โดยอัตโนมัติ.

- ต้องการยกระดับหลัก “historical Verification snapshot ไม่ถูก rewrite โดย Retirement/lifecycle facts ภายหลัง” ให้เป็น explicit cross-feature invariant หรือให้พึ่ง AV-17 + DR-10–DR-11 ที่มีอยู่

## Plan Decisions / Risks

- terminal-state enforcement + historical access
- temporal conflict detection กับ Loan/Repair/Reassignment/Verification
- correction/audit mechanism ที่ไม่ hard delete
- document/evidence linkage โดยไม่ generate official disposal documents


## Done Outcome

Asset ที่สิ้นสุด lifecycle ถูก lock จากงาน operational ใหม่ แต่ประวัติและหลักฐานยังค้นและอธิบายย้อนหลังได้ครบ.

## Handoff Boundary

Feature Brief นี้เป็น Blueprint context ไม่ใช่ `spec.md`. เมื่อเริ่มพัฒนาจริง ให้ Spec Kit สร้าง user scenarios, acceptance criteria, technical plan และ tasks จากข้อมูลนี้ร่วมกับ Blueprint canonical documents.
