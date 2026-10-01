# 05 — Conceptual Domain Model

ส่วนนี้เป็น **conceptual model** สำหรับช่วย Specify/Plan ไม่ใช่คำสั่งให้สร้าง table/service หนึ่งต่อหนึ่ง

## Asset Domain

- `Asset` — identity ของครุภัณฑ์รายชิ้น
- `AssetCategory`
- `Acquisition` — reference grouping ของการได้มา
- `Assignment` / `AssetEvent`
- `Location`
- `OrganizationUnit`
- `Person`
- `ExternalOrganization`
- `Loan` / `LoanItem`
- `RepairMaintenanceRecord`
- `VerificationRound` / `AssetVerification` / revision/exception
- `AssetRetirement`
- `Document` / `DocumentLink`

### Asset relationships

- Acquisition 1 → many Asset
- Asset 1 → many lifecycle facts/events
- Loan 1 → many Asset/LoanItem
- Asset 1 → many Repair records
- VerificationRound 1 → many AssetVerification
- Asset → optional terminal Retirement
- Documents เชื่อมกับหลาย business records ได้ตาม use case

## Material Domain

- `RequestableMaterial` — สิ่งที่ผู้ใช้ต้องการในเชิง UX/business meaning
- `StockMaterial` — identity ของรายการที่ติดตาม quantity จริง
- `Brand`
- `MaterialCategory`
- `MaterialUnit` / `UnitConversion`
- explicit `RequestableStockCompatibility`
- `MaterialRequest` / `MaterialRequestItem`
- `MaterialRequestDecision` / planned allocation
- `MaterialReceipt` / `ReceiptLine` / `SourceParty`
- `MaterialIssue` / `IssueLine`
- `MaterialReturn` / `ReturnLine`
- `OpeningBalance`
- `StockAdjustment` / correction reference
- `StockMovement`
- `MaterialStocktakeRound` / item / recount revision

### Material identity rules

- `Material` เป็น umbrella/domain term ไม่จำเป็นต้องมี persisted parent table
- StockMaterial มี Stable ID ของตัวเอง
- Brand / Model / Specification แยกเป็น structured data
- ความแตกต่างที่ต้องติดตาม stock แยก ต้องเป็น StockMaterial identity แยก
- Base Unit freeze หลังมี stock-affecting history
- Alternate units map ไป Base Unit โดยตรง

### Material transaction quantity

Stock-affecting transaction ต้องรักษาอย่างน้อย:

- Original Quantity
- Original Unit
- Conversion Snapshot
- Base Quantity

รองรับ fractional quantity เมื่อ business semantics ต้องการ และห้าม silent rounding

## Current State vs History

Current State เป็น projection/derived information จาก facts ที่มีผล ไม่ใช่เหตุผลให้ลบหรือเขียนทับ history

ตัวอย่าง:

- Current Assignment มาจาก latest effective valid assignment fact
- Current Stock derive/reconcile จาก authoritative Stock Movements
- Overdue derive จาก due date + return state
- Low Stock derive จาก Current Stock เทียบ Minimum Stock
- Remaining-to-Issue derive จาก decision + fulfilled issue facts
