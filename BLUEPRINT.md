# Blueprint — ระบบครุภัณฑ์สำนักงานและวัสดุสิ้นเปลือง

เวอร์ชัน: **1.0.2**  
สถานะ: **FROZEN**

> **v1.0.2 integrity-hardening patch:** ไม่เปลี่ยน scope, 14-feature decomposition หรือ dependency graph; ยกระดับเฉพาะ canonical stock-integrity semantics สำหรับ stock-effect completeness/uniqueness, Opening Balance cutover, source-linked Return, downstream-safe Correction และ concurrent stock mutation.

## 1. System Purpose

ระบบนี้เป็น **Local Operational Support System** สำหรับสำนักงาน ช่วยให้เจ้าหน้าที่รู้ว่า

- ครุภัณฑ์แต่ละชิ้นคืออะไร อยู่ที่ใด อยู่กับใคร และผ่านเหตุการณ์อะไรมา
- วัสดุแต่ละรายการมีของจริงอะไรอยู่ใน stock เท่าใด และยอดเปลี่ยนจากเหตุการณ์ใด
- คำขอวัสดุ การตัดสินใจของพัสดุ และการจ่ายจริงแยกจากกันอย่างชัดเจน
- การตรวจนับทั้งครุภัณฑ์และวัสดุรักษาภาพ ณ เวลาที่ตรวจ โดยไม่แก้ข้อมูลหลักอัตโนมัติ
- เอกสารและหลักฐานเชื่อมกับ business action ที่เกี่ยวข้องโดยไม่สร้างงานกรอกซ้ำ

ระบบ **ไม่ใช่ ERP/Procurement/Accounting replacement** และไม่ควรจำลอง workflow ของระบบราชการส่วนกลางที่มีอยู่แล้ว

## 2. Design Principles

### Simple
เพิ่ม entity, status, workflow และ automation เฉพาะเมื่อมี use case จริง

### Structured
แยก identity, current state, history, temporary custody, stock quantity และ evidence ตามความหมายจริง

### Traceable
Business action สำคัญต้องตอบได้ว่าเกิดอะไร เมื่อไร ใครเป็นผู้ดำเนินการ และเชื่อมกับข้อเท็จจริง/หลักฐานใด

### Sustainable
เจ้าหน้าที่สำนักงานขนาดเล็กต้องใช้ ดูแล และอธิบายระบบต่อได้ โดยไม่ต้องแบก framework ที่ซับซ้อนเกินงาน

## 3. Two Core Domains

### Asset
ครุภัณฑ์ติดตาม **รายชิ้น** ด้วย Stable ID และมี lifecycle ของตัวเองตั้งแต่ registration ถึง retirement

### Consumable Material
วัสดุติดตาม **รายรายการและจำนวน** โดย StockMaterial มี Base Unit, conversion semantics และ stock movement ที่ trace กลับ business action ได้

## 4. Core Architectural Ideas

- Stable identity แยกจาก business identifier ที่แก้ได้
- Current State แยกจาก History
- Action → History: ผู้ใช้ทำงานครั้งเดียว ระบบสร้าง history/audit ที่จำเป็น
- Effective Time แยกจาก Recorded Time เมื่อความหมายทางธุรกิจต้องการ
- Derived state ใช้เมื่อคำนวณได้ เช่น overdue, low stock, remaining-to-issue, current stock
- Stock balance ไม่แก้ตรง ๆ แต่ derive/reconcile จาก authoritative movements
- Verification/Stocktake ไม่แก้ registry/ledger อัตโนมัติ
- Correction ต้องรักษาประวัติเดิม ไม่ silent overwrite ข้อเท็จจริงที่มีผลแล้ว

## 5. User Experience Direction

- ค้นหาและ filter สำคัญกว่ากราฟ dashboard
- หน้า Asset รวม current state, timeline, loan, repair, verification และ documents ในบริบทเดียว
- QR เป็นทางลัดไปยัง record/action แต่ scan เองไม่เท่ากับ business action สำเร็จ
- ผู้ขอวัสดุเห็น “สิ่งที่ต้องการ” โดยไม่ต้องรู้ StockMaterial/Brand/Packaging จริงทั้งหมด
- เจ้าหน้าที่พัสดุเป็นผู้ตัดสินของจริงที่จะจ่าย
- Decision ไม่ตัด stock; stock เปลี่ยนเมื่อรับ/จ่าย/คืน/ปรับจริง

## 6. Feature Delivery Model

Blueprint แบ่งระบบเป็น 14 features ตาม `docs/09-feature-map.md` และมี Feature Brief แยกที่ `features/01-...` ถึง `features/14-...` เพื่อใช้เป็น context ตั้งต้นของ Spec Kit แต่ feature map ไม่ได้หมายความว่าต้องพัฒนาทุกอย่างพร้อมกัน

Feature Brief สามารถมี `Open Decisions` และ `Clarification Candidates` ได้โดยตั้งใจ: รายการเหล่านี้ไม่ใช่ requirement ที่ขาดหาย แต่เป็นเรื่องที่ควรตัดสินเมื่อมี context ของ feature จริง และ Clarification Candidate ห้ามถูก implement จนกว่าจะยืนยันใน Specify/Clarify.

แต่ละ feature เมื่อถึงเวลาพัฒนาให้เดิน:

**Specify → Clarify (เมื่อจำเป็น) → Plan → Checklist (เมื่อมีประโยชน์) → Tasks → Analyze (แนะนำ) → Implement → Converge → Acceptance**

ไม่ต้องสร้าง governance framework เพิ่มระหว่าง Blueprint กับ Spec Kit

## 7. Blueprint Documents

- `01-scope-and-goals.md` — ขอบเขตและเป้าหมาย
- `02-actors-and-permissions.md` — ผู้ใช้และสิทธิ์
- `03-system-modules.md` — โมดูล/ความสามารถหลัก
- `04-core-workflows.md` — workflow สำคัญ
- `05-domain-model.md` — conceptual data model
- `06-business-rules.md` — Business Rules 252 ข้อ
- `07-audit-and-evidence.md` — history/audit/evidence
- `08-non-functional-requirements.md` — security, quality, UX, operations
- `09-feature-map.md` — 14 features + dependencies
- `10-roadmap-and-out-of-scope.md` — sequencing และขอบเขตที่ไม่ทำ
- `features/` — Feature Brief 14 ไฟล์ พร้อม Rule routing, cross-feature responsibilities และ open decisions สำหรับ handoff เข้า Spec Kit
