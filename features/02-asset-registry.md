# 02 — Asset Registry

Feature key: `asset-registry`

## Purpose

สร้าง identity ที่มั่นคงให้ครุภัณฑ์รายชิ้นและเริ่มต้น lifecycle history โดยรองรับข้อมูลใหม่และ legacy ที่ไม่สมบูรณ์

## In Scope

- Acquisition reference แบบ lightweight
- Asset registration รายชิ้นและ bulk จาก Acquisition เดียว
- Stable ID, Asset Number, Serial Number, QR
- Metadata correction ที่ยังเป็น Asset identity เดิม
- Document/evidence linkage ที่เกี่ยวกับ Acquisition/Asset
- Search/filter และ duplicate warning ที่เหมาะกับ migration

## Out of Scope

- Procurement workflow
- Assignment/loan/repair/verification/retirement workflow
- การบังคับย้อนหลังสร้าง Acquisition ให้ legacy data
- การ generate เอกสารราชการ

## Actors

- Asset Custodian
- Administrator
- Read-only User

## Owned Workflow

1. บันทึก Acquisition reference เมื่อมีข้อมูลจริง
2. ลงทะเบียน Asset หนึ่งหรือหลายชิ้น
3. สร้าง Stable ID และ timeline starting fact
4. สร้าง/พิมพ์ QR ที่อ้าง Stable ID
5. แก้ metadata โดยรักษา identity/history เดิม

## Domain Concepts

- `Asset`
- `AssetCategory`
- `Acquisition`
- `Stable ID`
- `Asset Number`
- `Serial Number`
- `Document/DocumentLink`

## Business Rule Routing

Canonical wording อยู่ที่ `../docs/06-business-rules.md`; Feature Brief ไม่ทำสำเนาข้อความ rule เพื่อหลีกเลี่ยง duplicated truth.

### Primary — Full responsibility

`ACQ-01–ACQ-08`, `AR-01–AR-14`

### Primary — With shared integration

—

### Shared clause only

—

### Read-only / constraint reference

`AS-01–AS-04` — reference dimensions only

## Cross-Feature Responsibilities

- Assignment dimensions เป็น reference/read-only context; Registration ห้ามบังคับ Initial Assignment


## Key Invariants

- Asset หนึ่งชิ้นมี record และ Stable ID ของตนเอง
- Stable ID ไม่ derive จาก Asset Number/ชื่อ/Serial
- Asset Number/Serial อาจไม่มีตามข้อเท็จจริงและห้ามสร้างค่าปลอม
- Registration ไม่ต้องรอ Assignment
- QR เป็น locator ของ Stable ID ไม่ใช่สิทธิ์หรือ business action

## UX Expectations

- รองรับ bulk registration จากข้อมูลร่วมเดียว
- legacy/incomplete data ต้องลงทะเบียนได้โดยไม่กรอกข้อมูลปลอม
- Search/filter ต้องหาได้จาก identifiers และข้อมูลสำคัญ

## Audit / Evidence

- Registration ต้องมี traceable timeline starting fact
- Metadata correction audit ตามความสำคัญ
- Document หนึ่งรายการเชื่อมหลาย Asset จาก Acquisition เดียวได้

## Relevant NFR

- Stable identity
- Data integrity
- Search/filter usability
- Migration provenance

## Delivery Dependencies

- `application-foundation`

## Open Decisions for Specify / Clarify

- รูปแบบเลขครุภัณฑ์
- status/condition vocabulary ที่ต้องใช้ร่วม feature อื่น
- ประเภท Acquisition/Retirement ที่มีจริง
- Location hierarchy และ Organization Unit vocabulary
- permission matrix ของงานทะเบียน
- bulk registration boundary
- document storage policy เมื่อมีเอกสารจริง
- migration source/legacy fields ที่จะนำเข้า

## Plan Decisions / Risks

- Stable ID / canonical URL / QR identity
- Acquisition-to-Asset relation และ bulk registration เท่าที่ requirement รองรับ
- Asset Number duplicate warning + correction/history
- legacy incomplete fields/provenance โดยไม่ fabricate identifiers
- search/index strategy เท่าที่ operational use case ต้องใช้


## Done Outcome

เจ้าหน้าที่สามารถสร้างและค้น Asset identity ที่เชื่อถือได้ รวมข้อมูล legacy ที่ไม่สมบูรณ์ โดยไม่ต้องเริ่ม Assignment พร้อมกัน.

## Handoff Boundary

Feature Brief นี้เป็น Blueprint context ไม่ใช่ approved implementation specification.
สำหรับ Feature 002 ใช้ Claude Code CLI และ Matt Pocock Skills ตาม `CLAUDE.md`
เพื่อเตรียม user scenarios, acceptance criteria, implementation/testing decisions
และ bounded GitHub Issues จาก brief นี้ร่วมกับ canonical Blueprint documents.
การเรียก workflow ขั้นถัดไป การ publish และ implementation ต้องมี authorization
ตามขอบเขต; ขั้นตอนเป็นไปตาม `CLAUDE.md` (Multica เป็น historical provenance).
