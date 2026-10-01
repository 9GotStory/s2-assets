# 02 — Actors & Permissions

## Actor Model

| Actor / Role concept | ความรับผิดชอบหลัก |
|---|---|
| Administrator | ผู้ใช้/สิทธิ์, master data และ correction สำคัญตามสิทธิ์ |
| Asset Custodian / ผู้ดูแลทะเบียนครุภัณฑ์ | registration, assignment, loan, repair, verification, retirement |
| Supply Officer / เจ้าหน้าที่พัสดุ | catalog วัสดุ, receiving, พิจารณาคำขอ, เลือกของจริงที่จะจ่าย, issue/return/adjustment |
| Verification Staff | ตรวจนับครุภัณฑ์/วัสดุตามรอบและบันทึกผล/exception |
| Requester / ผู้ใช้งานทั่วไป | ค้น Requestable Material, สร้างและติดตามคำขอของตนเอง |
| Read-only User | ค้นและดูข้อมูลตามขอบเขตที่ได้รับอนุญาต |
| System Maintainer | ดูแล runtime/configuration/backup ตามสถาปัตยกรรมที่ Plan เลือก |

## หลักการสิทธิ์

- ใช้ **role/capability ที่พอดีกับสำนักงาน** ไม่สร้าง permission framework ซับซ้อนก่อนมี use case
- คนหนึ่งอาจถือหลาย role ได้ แต่ domain ไม่ assume ว่าทุก role ต้องเป็นคนเดียวกัน
- Business action ที่มีผลสำคัญ เช่น correction, reopen, retirement, adjustment ต้องตรวจ permission ก่อนดำเนินการ
- ผู้ใช้งานทั่วไปไม่ควรเลือก StockMaterial จริง หาก business workflow ไม่จำเป็น
- QR/deep link ไม่ bypass permission
- Retired Asset เปิดดูได้แต่ไม่ควรเสนอ operational actions ใหม่

## Feature-level clarification

ชื่อ role จริงและ permission matrix เชิงละเอียดให้ยืนยันตอน Specify/Clarify ของ feature ที่เกี่ยวข้อง แทนการ freeze matrix ใหญ่ใน Blueprint
