# 10 — Roadmap & Out of Scope

## Delivery Strategy

พัฒนาแบบ incremental ตาม dependency โดยให้แต่ละ feature จบ business capability ที่ใช้งาน/ทดสอบได้ ไม่ใช่สร้าง infrastructure ยาวหลาย phase ก่อนเห็นคุณค่าทางธุรกิจ

### Phase A — Foundation + Asset Core

1. `application-foundation`
2. `asset-registry`
3. `asset-assignment-movement`
4. `loan-return`
5. `repair-maintenance`
6. `annual-asset-verification`
7. `asset-retirement`

### Phase B — Material Core

8. `material-catalog-units`
9. `material-request-entry`
10. `material-receiving-stock-foundation`
11. `material-request-decision`
12. `material-issue-fulfillment`
13. `material-return-adjustment`
14. `material-stocktake`

ลำดับจริงสามารถปรับตาม priority/use case ได้หาก dependency ยังรักษาได้

## What Blueprint Freezes vs What Spec Kit Decides

### Blueprint owns
- business purpose/scope
- domain semantics
- critical business rules
- major actor boundaries
- feature boundaries/dependencies
- non-goals

### Specify/Clarify owns
- user scenarios
- acceptance criteria
- feature-level open decisions
- exact validation/permission behavior ที่ยังไม่จำเป็นต้อง global

### Plan owns
ภายใต้ project-wide selected baseline ใน `../TECHNOLOGY.md` หรือ Technology Deviation ที่ Product Owner อนุมัติแล้ว:
- exact framework/database integration และ compatible package versions
- schema/API shape
- deployment/topology details
- transaction strategy
- exact precision/storage types
- observability/backup implementation
- decisions ที่ `TECHNOLOGY.md` ระบุเป็น Deferred to Plan

Plan ไม่ reselect project-wide runtime/framework/database/container baseline ใหม่โดยไม่มี explicit deviation ที่ได้รับอนุมัติ

### Checklist/Analyze assists
- ตรวจคุณภาพ/ความสอดคล้องของ requirements และ delivery artifacts ตามความเหมาะสม
- ไม่เป็น business authority และไม่เขียนทับ Blueprint

### Tasks/Implementation owns
- code-level decomposition
- test implementation
- migrations/configuration

### Converge assists
- ตรวจ implementation เทียบกับ Spec Kit delivery artifacts เมื่อ feature ใกล้จบ
- งานที่ยังขาดต้องกลับเข้า task/implementation ตามปกติ ไม่ใช้เพื่อเพิ่ม speculative scope

## Explicit Future/Non-Baseline Candidates

จะพิจารณาเมื่อมี requirement จริงเท่านั้น:

- Lot/Expiry/FEFO
- multi-location stock
- reservation
- reorder/forecast
- complex warehouse status
- scheduled maintenance
- digital signature/multi-level approval
- document generation
- procurement/accounting integration
- AI/OCR
- broad API integrations
- complex dashboard/BI

## Definition of “Ready to Start Spec Kit”

Blueprint พร้อมเริ่มพัฒนาเมื่อ Product Owner ยืนยันเพียง 4 เรื่อง:

1. scope/non-goals ถูกต้อง
2. 14 feature boundaries ใช้ได้เป็น starting decomposition
3. critical workflows ไม่ขาด business path สำคัญ
4. 252 rules ไม่มีข้อที่ทราบว่าไม่ต้องการแล้ว

หลังจากนั้นให้ **หยุด re-review Blueprint แบบ recursive** และใช้ Clarify ใน feature จริงเป็นจุดตัดสินรายละเอียดที่เหลือ
