# 03 — System Modules

Blueprint มองโมดูลเป็น **business capabilities** ไม่ผูกว่าต้องเป็น service/table/controller แยกหนึ่งต่อหนึ่ง

## Asset Capabilities

### Asset Registry
สร้าง stable identity ของครุภัณฑ์รายชิ้น เชื่อม Acquisition reference, Asset Number/Serial/QR และเริ่ม timeline

### Assignment & Movement
ดูแล Permanent Assignment ได้แก่ Organization Unit, Location, Responsible Person และการเปลี่ยนที่มี effective history

### Loan & Return
ดูแล temporary custody ภายใน/ภายนอก รองรับหลาย Asset ต่อ loan, partial return และ overdue derived state

### Repair & Maintenance
บันทึก lifecycle การส่งซ่อม/รับกลับ/บำรุงรักษา โดยไม่เปลี่ยน Permanent Assignment อัตโนมัติ

### Annual Asset Verification
สร้าง Verification Round + scope snapshot + result/revision/exception โดยผลตรวจไม่แก้ registry เอง

### Asset Retirement
บันทึกผลการจำหน่าย/สิ้นสุด lifecycle หลัง external process เสร็จ และ lock operational actions ใหม่โดยรักษา history

## Material Capabilities

### Material Catalog & Units
StockMaterial, Brand, Model, Specification, Category, Base/Alternate Units, conversion, inactive/reactivate, Minimum Stock

### Material Request
RequestableMaterial และคำขอหลายรายการ โดยผู้ขอไม่ต้องรู้ stock identity จริง

### Supply Decision
Decision ระดับ Requested Item, Allowed Quantity และ planned compatible allocations โดยยังไม่ reserve/ตัด stock

### Receiving & Stock Foundation
Receipt, Opening Balance, one logical office stock, authoritative Stock Movements และ Current Stock

### Issue / Fulfillment
จ่ายจริงจาก Request + Decision, partial/multiple issues, substitution ที่ compatible และ negative-stock guard

### Return / Adjustment / Correction
คืน usable/unusable, แก้ transaction ผิดอย่าง traceable และปรับยอดจาก discrepancy โดยไม่แก้ raw balance ตรง ๆ

### Material Stocktake
รอบตรวจนับ, expected snapshot, counted-at, recount/revision, discrepancy และ linkage ไป Adjustment เมื่อจำเป็น

## Shared Capabilities

- Authentication / authorization
- Search & filtering
- Master references ที่จำเป็น
- Documents/evidence links
- History/audit metadata
- Basic operational reports
- Migration/import แบบ bounded ตามแหล่งข้อมูลจริง
