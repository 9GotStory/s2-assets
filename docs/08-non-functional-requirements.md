# 08 — Non-Functional Requirements

## Security

- Authentication/authorization ต้อง fail closed
- ใช้ least privilege ตาม actor/capability
- validate input และ enforce business invariants ฝั่ง server
- ป้องกัน common web risks ตาม OWASP ที่เกี่ยวข้องกับ stack จริง
- secrets/configuration แยกจาก source code
- sensitive logs/data ต้อง data-minimized
- QR/deep link ไม่ bypass authorization

## Data Integrity

- Stable identity ต้องไม่เปลี่ยนจากการแก้ business identifier
- ห้าม fabricate data เพื่อผ่าน validation
- history ที่มีผลแล้วห้าม silent overwrite
- stock balance ต้อง reconcile กับ authoritative movement set
- issue ที่ stock เชื่อถือได้ห้ามทำให้ Current Stock ติดลบ
- concurrent stock-affecting operations ต้องรักษา stock, entitlement และ source-to-movement invariants เดียวกับการทำงานแบบลำดับปกติ; กลไก transaction/locking/idempotency ที่ใช้จริงให้ Plan เลือกตาม stack และความเสี่ยง
- unit conversion transaction ต้องรักษา snapshot
- migration/import ต้องมี provenance

## Usability

- Search/filter เป็น first-class capability
- mobile-friendly สำหรับงานตรวจนับ
- workflow ใช้ชื่อ action ตามงานจริง
- ลดการกรอกซ้ำ
- ผู้ขอวัสดุไม่แบกความซับซ้อนของ stock catalog
- exception path ต้องใช้งานได้จริง ไม่ออกแบบเฉพาะ happy path

## Performance

กำหนด target เชิงตัวเลขใน Plan หลังรู้ deployment/data volume จริง Blueprint ไม่สร้าง premature performance architecture

Baseline expectation:

- การค้น record ทั่วไปตอบสนองเหมาะกับงานสำนักงาน
- รายการ/รายงานต้อง paginate/filter ได้
- stock calculation ที่ใช้ใน transaction ต้องเชื่อถือได้และไม่อาศัย full-history scan แบบไม่มีขอบเขตเมื่อข้อมูลโต

## Reliability & Operations

- backup/restore ต้องออกแบบตาม hosting/database ที่เลือกจริง
- deployment ต้อง reproducible ในระดับที่ทีมดูแลต่อได้
- error ต้องไม่ทิ้ง transaction สำคัญในสถานะครึ่งกลาง
- log ต้องช่วยวินิจฉัยปัญหาโดยไม่เก็บข้อมูลเกินจำเป็น
- migration schema/data ต้องย้อนตรวจและกู้คืนตามความเสี่ยงของการเปลี่ยนแปลง

## Maintainability

- Simple — Structured — Sustainable
- หลีกเลี่ยง generic framework หากยังมี use case เดียว
- module boundaries ตาม business capability ไม่ใช่ abstraction เพื่อ abstraction
- test business invariants ที่สำคัญ มากกว่าทดสอบ implementation detail ทุกชั้น
- technical choices อยู่ใน feature Plan/System Plan ไม่ freeze ใน Blueprint โดยไม่จำเป็น

## Testing Priorities

### Asset
- stable identity
- active loan overlap
- loan/repair/retirement guards
- assignment effective-time semantics
- verification snapshot/revision
- retirement conflict/history

### Material
- conversion snapshot/fractional quantity
- request/decision/issue separation
- receiving → stock movement
- multiple/partial issue
- explicit compatibility/substitution
- negative-stock prevention
- return/correction/adjustment traceability
- ledger reconciliation
- stocktake discrepancy and concurrent/late movements
