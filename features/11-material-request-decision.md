# 11 — Material Request Decision

Feature key: `material-request-decision`

## Purpose

ให้เจ้าหน้าที่พัสดุตัดสินคำขอระดับ Requested Item กำหนด Allowed Quantity และ planned StockMaterial allocations โดยยังไม่ reserve/ตัด stock

## In Scope

- Decision per Requested Item
- Allow partial / deny พร้อม reason/note
- Allowed Quantity ใน request semantics
- Multiple planned StockMaterial allocations
- Current stock context ที่เชื่อถือได้
- Decision amendment/revision ที่ traceable

## Out of Scope

- Formal government/procurement approval
- Stock reservation
- Stock decrement
- Actual Issue transaction

## Actors

- Supply Officer
- Requester (ดูผลของคำขอ)
- Administrator

## Owned Workflow

1. เปิด Requested Item พร้อม request semantics และ stock context
2. พิจารณา allow/partial/deny
3. กำหนด planned compatible allocations
4. validate Allowed ≤ Requested
5. แก้/amend Decision แบบ traceable เมื่อจำเป็น
6. ส่งต่อ entitlement ให้ Issue โดยไม่เปลี่ยน stock

## Domain Concepts

- `MaterialRequestDecision`
- `Allowed Quantity`
- `Planned Allocation`
- `Outstanding Decision`
- `Request semantics`

## Business Rule Routing

Canonical wording อยู่ที่ `../docs/06-business-rules.md`; Feature Brief ไม่ทำสำเนาข้อความ rule เพื่อหลีกเลี่ยง duplicated truth.

### Primary — Full responsibility

`MRQ-03`, `MRQ-05–MRQ-07`, `MRQ-12–MRQ-14`, `MRQ-21`, `MRQ-31–MRQ-33`

### Primary — With shared integration

`MRQ-16`; `MRQ-29`; `MRQ-34`; `MRQ-35`

### Shared clause only

`MC-19`

### Read-only / constraint reference

`MRQ-15`, `MRQ-17`, `MRQ-26–MRQ-28`, `MRQ-30`, `MSL-03`, `MSL-08`

## Cross-Feature Responsibilities

- Decision อยู่ระดับ Requested Item และเป็นเจ้าของ Allowed Quantity/Decision revision
- planned allocation ต้อง reconcile กลับ request semantics ที่ Request Entry กำหนด
- อ่าน Current Stock เป็น context เท่านั้น ไม่ reserve
- Allowed Quantity side ของ fulfillment cap/Remaining ต้องประสานกับ Issue facts


## Key Invariants

- Decision เป็น operational fulfillment decision ไม่ใช่ formal approval
- Decision ไม่ reserve/ลด Current Stock
- หนึ่ง Requested Item มีหนึ่ง logical current Decision พร้อม revision history ตามที่จำเป็น
- Allowed Quantity ห้ามเกิน Requested Quantity
- planned allocation ต้อง compatible และ reconcile กลับ request semantics ได้
- Outstanding Decision เป็น context ไม่ใช่ Reserved Quantity

## UX Expectations

- Supply Officer UI แสดง stock/compatibility/detail ที่จำเป็นต่อการตัดสินใจ
- Requester เห็นผลพิจารณาโดยไม่ต้องเห็น complexity ภายในเกินจำเป็น
- partial/deny reason แสดงอย่างเหมาะสม

## Audit / Evidence

- Decision/revision เก็บผู้ตัดสินใจ เวลา และเหตุผลที่เกี่ยวข้อง
- การเปลี่ยน Allowed Quantity ต้องไม่ทำให้ Issue history ที่เกิดแล้วหาย
- planned allocations เป็น decision history ไม่ถูก overwrite ด้วย actual substitute

## Relevant NFR

- Decision consistency
- Server-side invariant enforcement
- Traceable revision

## Delivery Dependencies

- `material-request-entry`
- `material-receiving-stock-foundation`

## Open Decisions for Specify / Clarify

- permission matrix
- ต้องมี notification หรือไม่ — ไม่เป็น baseline จน Clarify ยืนยัน
- Decision terminology/status vocabulary
- evidence/document requirement ของ Decision ถ้ามี
- cancellation/amendment/replacement representation
- Requestable mapping/inactive behavior ระหว่าง workflow pending


## Clarification Candidates — Not Yet Requirements

รายการต่อไปนี้มาจากประเด็น derived guardrail เดิมที่ **ยังไม่ถูกยืนยันเป็น canonical Business Rule**. ให้ใช้เป็นคำถามใน Specify/Clarify เท่านั้น ห้าม implement เป็น requirement โดยอัตโนมัติ.

- RequestableMaterial ควรมี stable reusable business identity เป็น explicit invariant หรือไม่
- Decision จะถือ Current Stock ว่า trustworthy หลัง Opening Balance ด้วยเงื่อนไข/cutover ใด
- Base Unit/config change ต้อง revalidate mapping/planned allocation ที่ยัง pending อย่างไร

## Plan Decisions / Risks

- decision revision/history model
- allocation/reconciliation persistence
- stock-context read model ที่ไม่สร้าง reservation
- mapping/version context ที่รักษา historical meaning


## Done Outcome

พัสดุตัดสินแต่ละ Requested Item ได้อย่าง traceable และส่ง entitlement/แผนการจ่ายที่ชัดเจนให้ Issue โดย stock ยังไม่เปลี่ยน.

## Handoff Boundary

Feature Brief นี้เป็น Blueprint context ไม่ใช่ `spec.md`. เมื่อเริ่มพัฒนาจริง ให้ Spec Kit สร้าง user scenarios, acceptance criteria, technical plan และ tasks จากข้อมูลนี้ร่วมกับ Blueprint canonical documents.
