# 01 — Scope & Goals

## เป้าหมาย

1. ทำทะเบียนครุภัณฑ์ที่ค้นง่าย ติดตามรายชิ้น และรักษาประวัติ lifecycle
2. รองรับ assignment, movement, loan, repair, annual verification และ retirement โดยไม่ทำงานซ้ำ
3. ทำระบบวัสดุที่รองรับ catalog, หน่วยหลายระดับ, receiving, request, decision, issue, return, adjustment และ stocktake
4. ทำให้ข้อมูลปัจจุบันเชื่อมกลับ business action และหลักฐานได้
5. รองรับ legacy/incomplete data โดยไม่บังคับสร้างข้อมูลปลอม
6. ทำให้ผู้ใช้งานทั่วไปขอวัสดุได้ง่าย และให้เจ้าหน้าที่พัสดุรับผิดชอบความซับซ้อนของของจริงใน stock

## Core Scope — Asset

- Acquisition reference
- Asset registration
- Assignment & reassignment
- Internal/external loan & return
- Repair & maintenance history
- Annual asset verification
- Retirement/disposal-result recording
- Documents/evidence
- Search/filter/basic reports

## Core Scope — Material

- StockMaterial catalog
- Brand / Model / Specification
- Base Unit + Alternate Units + conversion snapshot
- RequestableMaterial abstraction เพื่อ UX
- Material request
- Supply officer decision
- Receiving + opening balance
- Issue / fulfillment
- Return
- Adjustment / correction
- Stock ledger/current stock
- Stocktake
- Search/filter/basic operational indicators เช่น Low Stock

## Explicit Non-Goals

- Procurement / PO / e-Bidding
- Accounting / finance / tax / debt
- Government document generator
- Multi-level approval/BPMN/digital-signature engine
- Full HR system
- Full vendor-management system
- Reservation/queue/sub-loan โดยไม่มี requirement ใหม่
- Scheduled maintenance/SLA engine
- GPS-based annual verification
- Mandatory photo for every asset/action
- AI/OCR/predictive automation โดยไม่มี requirement
- Generic import engine สำหรับทุกแหล่งข้อมูล
- Event-sourcing architecture เพียงเพราะมี history
- Multi-location warehouse/transfer model ใน v1
- Damaged/quarantine warehouse ใน v1
- Lot/Expiry/FEFO ใน baseline v1
- Inventory valuation/costing
- Reorder/procurement automation จาก Minimum Stock

## Scope Gate

หากพบ feature ใหม่ระหว่างพัฒนา ให้บันทึกเป็น requirement/proposal แล้วนำกลับมา Clarify ก่อน ห้ามเพิ่มโดยอัตโนมัติเพียงเพราะ “ทำได้”
