# 09 — Material Request Entry

Feature key: `material-request-entry`

## Purpose

ให้ผู้ใช้งานทั่วไปขอ “สิ่งที่ต้องการ” ได้ง่ายผ่าน RequestableMaterial โดยไม่ต้องเลือก StockMaterial/Brand/packaging จริง และกำหนด compatibility/request-unit semantics อย่าง explicit

## In Scope

- RequestableMaterial
- Requestable ↔ StockMaterial compatibility mapping
- Request Unit semantics
- Multi-item Material Request
- Requester-facing create/view/track
- Cancel Request/Item ก่อน Issue และ cancel remainder หลัง partial Issue ตาม rule

## Out of Scope

- Supply Officer Decision
- Stock reservation/decrement
- Actual Issue
- Multi-level approval
- AI/name-based compatibility inference

## Actors

- Requester
- Supply Officer (ดูแล mapping/catalog ตามสิทธิ์)
- Administrator

## Owned Workflow

1. ค้น RequestableMaterial ที่ active
2. ระบุ Requested Quantity ใน request semantics
3. สร้าง Request ที่มีหลาย Requested Items
4. ติดตาม request/item state ที่ derive ได้
5. cancel ก่อน issue หรือ cancel remainder แบบ traceable
6. ดูแล explicit compatibility/unit mapping โดยไม่ rewrite history

## Domain Concepts

- `RequestableMaterial`
- `MaterialRequest`
- `MaterialRequestItem`
- `Request Unit`
- `RequestableStockCompatibility`

## Business Rule Routing

Canonical wording อยู่ที่ `../docs/06-business-rules.md`; Feature Brief ไม่ทำสำเนาข้อความ rule เพื่อหลีกเลี่ยง duplicated truth.

### Primary — Full responsibility

`MRQ-01–MRQ-02`, `MRQ-04`, `MRQ-11`, `MRQ-15`, `MRQ-26–MRQ-28`, `MRQ-30`

### Primary — With shared integration

`MRQ-16`; `MRQ-19`; `MRQ-29`

### Shared clause only

`MC-14`

### Read-only / constraint reference

`MRQ-05`, `MRQ-31–MRQ-33` — downstream Decision constraints

## Cross-Feature Responsibilities

- เป็นเจ้าของ multi-item Request/Requested Item structure และ cancellation ก่อนมี Issue
- เป็นเจ้าของ request-unit semantics/mapping prerequisites; downstream Decision/Issue ต้อง reconcile กลับ semantics นี้
- เมื่อ partial Issue เกิดแล้ว cancellation ของ remainder ต้องทำงานร่วมกับ Issue feature
- Inactive RequestableMaterial ไม่ใช้เริ่ม request ใหม่ตามปกติ แต่ history เดิมยังอ่านได้


## Key Invariants

- Requester ไม่ต้องรู้ StockMaterial ทั้งหมด
- Requested Item แยกจาก fulfilled StockMaterial
- Requested/Allowed/Issued เป็นคนละ fact
- Compatibility และ conversion ห้าม infer จากชื่อ/category/AI
- Request-level state ควร derive จาก item states
- Cancel ไม่ hard-delete history และไม่ลบของที่จ่ายแล้ว

## UX Expectations

- Requester UI เน้นค้นของที่ต้องการและจำนวน ไม่เปิด complexity ของ stock catalog
- Inactive RequestableMaterial ไม่เสนอสำหรับ request ใหม่แต่ history ยังอ่านได้
- Request หลายรายการต้องทำได้ในครั้งเดียว

## Audit / Evidence

- Cancellation เก็บ By/At และ reason/note ตามความเหมาะสม
- mapping change ห้าม rewrite Decision/Issue history เดิม
- Request amendment หากจำเป็นต้อง traceable

## Relevant NFR

- Simple requester UX
- Explicit mapping integrity
- Historical semantics

## Delivery Dependencies

- `material-catalog-units`

## Open Decisions for Specify / Clarify

- permission matrix
- ต้องมี notification หรือไม่ — ไม่เป็น baseline จน Clarify ยืนยัน
- evidence/document requirement ของ Request ถ้ามี
- cancellation/amendment/replacement representation ที่เชื่อม downstream
- Requestable mapping/inactive behavior ระหว่าง workflow ที่ยัง pending


## Clarification Candidates — Not Yet Requirements

รายการต่อไปนี้มาจากประเด็น derived guardrail เดิมที่ **ยังไม่ถูกยืนยันเป็น canonical Business Rule**. ให้ใช้เป็นคำถามใน Specify/Clarify เท่านั้น ห้าม implement เป็น requirement โดยอัตโนมัติ.

- RequestableMaterial ควรมี stable reusable business identity เป็น explicit invariant หรือไม่ (ปัจจุบันเป็น concept ที่ใช้ซ้ำ แต่ยังไม่มี canonical rule ยืนยัน Stable ID โดยตรง)

## Plan Decisions / Risks

- stable Requestable identity + mapping persistence/history
- request-unit configuration และ compatibility maintenance
- simple requester UX
- mapping changes ไม่ rewrite historical semantics
- cancel traceability โดยไม่ hard delete


## Done Outcome

ผู้ใช้ทั่วไปสร้างคำขอหลายรายการได้ด้วยภาษางานจริง โดยระบบยังมี semantics ชัดพอให้พัสดุตัดสิน StockMaterial ภายหลัง.

## Handoff Boundary

Feature Brief นี้เป็น Blueprint context ไม่ใช่ `spec.md`. เมื่อเริ่มพัฒนาจริง ให้ Spec Kit สร้าง user scenarios, acceptance criteria, technical plan และ tasks จากข้อมูลนี้ร่วมกับ Blueprint canonical documents.
