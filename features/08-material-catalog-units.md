# 08 — Material Catalog & Units

Feature key: `material-catalog-units`

## Purpose

สร้าง StockMaterial identity และหน่วยนับ/การแปลงที่เชื่อถือได้ เพื่อให้ทุก stock-affecting transaction normalize เป็น Base Unit โดยรักษาความหมายเดิมในอดีต

## In Scope

- StockMaterial catalog
- Brand/Model/Specification/Category
- Base Unit + Alternate Units
- Direct conversion to Base Unit
- Fractional/integer unit semantics
- Inactive/reactivate
- Duplicate candidate warning
- Minimum Stock baseline

## Out of Scope

- EAV/dynamic attribute engine
- Lot/Expiry/FEFO
- Multi-location stock
- Procurement vendor master
- Auto reorder/forecast

## Actors

- Supply Officer
- Administrator
- Read-only User

## Owned Workflow

1. สร้าง/แก้ StockMaterial identity ตามข้อเท็จจริง
2. กำหนด Base Unit และ Alternate Units
3. normalize transaction quantity ด้วย conversion snapshot
4. freeze Base Unit หลังมี stock-affecting history
5. inactive/reactivate โดยรักษา history
6. ตรวจ duplicate candidate แบบ warning/review

## Domain Concepts

- `StockMaterial`
- `Brand`
- `MaterialCategory`
- `MaterialUnit`
- `UnitConversion`
- `Stable ID`
- `Minimum Stock`

## Business Rule Routing

Canonical wording อยู่ที่ `../docs/06-business-rules.md`; Feature Brief ไม่ทำสำเนาข้อความ rule เพื่อหลีกเลี่ยง duplicated truth.

### Primary — Full responsibility

`MC-01–MC-05`, `MC-10–MC-13`, `MC-17–MC-18`, `MC-22–MC-26`

### Primary — With shared integration

`MC-06–MC-09`; `MC-14`; `MC-16`; `MC-20`; `MC-21`

### Shared clause only

`MC-15`; `MC-19`

### Read-only / constraint reference

`MRC-*`, `MOB-*`, `MSL-*` — stock capability outside catalog feature

## Cross-Feature Responsibilities

- Feature นี้เป็นเจ้าของ unit definitions/conversion configuration; transaction features เป็นเจ้าของ conversion snapshot ของตน
- Inactive/reactivate semantics ต้องคง historical access และถูกนำไปใช้ต่างกันตาม workflow downstream
- Opening Balance workflow อยู่ใน Receiving/Stock Foundation ไม่ใช่ Catalog
- Current Stock derivation อยู่ใน Stock Foundation; Catalog มีเพียง Minimum Stock configuration
- Base Unit freeze อาศัยข้อมูลว่ามี stock-affecting history จาก Stock Foundation


## Key Invariants

- StockMaterial มี Stable ID แยกจากชื่อ/Brand/Model/Specification
- Base Unit เป็น source of truth และ freeze หลังมี stock history
- historical transaction รักษา Conversion Snapshot
- ความต่างที่ต้องติดตาม stock แยกต้องเป็น identity แยก
- ห้าม silent rounding
- Inactive ไม่ลบ history หรือทำให้ stock ที่เหลือจัดการไม่ได้

## UX Expectations

- ชื่อ/Brand/Model/Specification แสดงแยกและค้นได้
- alternate unit ช่วยรับ/จ่ายตามหน่วยงานจริงโดยผู้ใช้ไม่ต้องคำนวณเอง
- duplicate เป็น warning/review ไม่ hard-code uniqueness ที่เสี่ยง merge ของจริงคนละรายการ

## Audit / Evidence

- การแก้ identity-affecting metadata และ conversion ตามความสำคัญ
- Base Unit correction/migration หลังมี history ต้อง traceable
- การเปลี่ยน Minimum Stock ไม่สร้าง Stock Movement

## Relevant NFR

- Quantity precision
- Historical conversion integrity
- Search/filter
- No fabricated data

## Delivery Dependencies

- `application-foundation`

## Open Decisions for Specify / Clarify

- permission matrix
- Material Category vocabulary/requiredness
- Inactive + Minimum Stock presentation/search behavior


## Clarification Candidates — Not Yet Requirements

รายการต่อไปนี้มาจากประเด็น derived guardrail เดิมที่ **ยังไม่ถูกยืนยันเป็น canonical Business Rule**. ให้ใช้เป็นคำถามใน Specify/Clarify เท่านั้น ห้าม implement เป็น requirement โดยอัตโนมัติ.

- เมื่อเปลี่ยน Base Unit ก่อนมี stock history ต้อง revalidate dependent configuration/mapping อย่างไรเพื่อไม่ให้ semantics เปลี่ยนโดยไม่ตั้งใจ

## Plan Decisions / Risks

- stable identity + unit conversion model
- precision/DB numeric type โดยไม่มี silent rounding
- duplicate warning/resolution without silent merge
- dependent-config revalidation ก่อน Base Unit change
- catalog search/select UX ที่รองรับ inactive/history


## Done Outcome

ระบบมี StockMaterial/หน่วยนับที่ใช้เป็นฐานร่วมของ receiving, request mapping, issue, return, adjustment และ stocktake โดยประวัติ conversion ไม่เปลี่ยนย้อนหลัง.

## Handoff Boundary

Feature Brief นี้เป็น Blueprint context ไม่ใช่ `spec.md`. เมื่อเริ่มพัฒนาจริง ให้ Spec Kit สร้าง user scenarios, acceptance criteria, technical plan และ tasks จากข้อมูลนี้ร่วมกับ Blueprint canonical documents.
