# 04 — Core Workflows

## 1. Asset Lifecycle

```text
Acquisition reference
    ↓
Asset Registration
    ↓
Initial Assignment / In-use
    ├─ Reassignment
    ├─ Loan → Partial/Full Return
    ├─ Repair → Return / Result
    └─ Annual Verification → Exception/Reverify
    ↓
Retirement result recorded
    ↓
Historical record remains searchable
```

หลักสำคัญ: lifecycle ไม่จำเป็นต้องเป็นเส้นตรง และทุกเหตุการณ์ยังอยู่ใต้ Stable Asset Identity เดิม

## 2. Registration → Assignment

1. ลงทะเบียน Asset ได้แม้ยังไม่มี Assignment
2. ระบบสร้าง Stable ID และ timeline starting fact
3. หากบันทึก Assignment ต่อทันทีใน UI เดียวกัน ให้ถือเป็น logical action แยก
4. การแก้ typo ไม่เท่ากับ business reassignment

## 3. Loan / Return

1. ตรวจว่า Asset ยืมได้และไม่มี active loan ซ้อน
2. เริ่ม temporary custody โดยไม่แก้ Permanent Assignment
3. คืนได้รายชิ้น
4. เมื่อคืน ใช้ latest effective Permanent Assignment เป็น current assignment
5. ของคืนเสียหายอาจนำไปสู่ Repair action แยก แต่ห้าม fabricate ผลซ่อม

## 4. Repair

1. บันทึกส่งซ่อม → operational state สะท้อนว่ากำลังซ่อม
2. เก็บคู่ค้า/สถานที่ซ่อม/ค่าใช้จ่าย/ประกันเท่าที่ใช้จริง
3. รับกลับพร้อมผล/condition
4. “ซ่อมไม่ได้” ไม่เท่ากับ Retirement
5. Retirement เป็น action ภายหลังเมื่อกระบวนการภายนอกเสร็จจริง

## 5. Annual Asset Verification

1. เปิด Verification Round พร้อม scope snapshot
2. ผู้ตรวจค้น/scan เพื่อ identify Asset
3. บันทึกผลพบ/ไม่พบและ condition/context
4. QR scan ไม่เท่ากับ verified success
5. ผลตรวจไม่แก้ Assignment/Registry อัตโนมัติ
6. discrepancy ที่ยืนยันแล้วนำไปสู่ Reassignment/Correction action แยก
7. reverify/reopen/correction ต้องรักษาประวัติเดิม

## 6. Material Request → Decision → Issue

```text
Requester creates Request
    ↓
Requested Items
    ↓
Supply Officer Decision per item
    ↓      (NO stock reservation/decrement)
Actual Issue event(s)
    ↓
Stock Movement(s)
    ↓
Current Stock changes
```

- Requested / Decision / Issued เป็นคนละ fact
- Decision รองรับ planned allocations หลาย StockMaterial
- Actual Issue อาจ substitute ได้เมื่อ explicit compatibility รองรับ
- `Remaining-to-Issue = Allowed − valid fulfilled` สำหรับ remainder ที่ active
- Normal Return ไม่ reopen entitlement อัตโนมัติ

## 7. Material Receiving

1. สร้าง Receipt และ lines
2. Draft/no-effect record ยังไม่เปลี่ยน stock
3. เมื่อ receiving มีผลจริง → positive Stock Movement
4. transaction เก็บ Original Quantity/Unit + Conversion Snapshot + Base Quantity
5. Receipt ที่มีผลแล้วห้าม silent overwrite; ใช้ correction semantics

## 8. Opening Balance

ใช้เฉพาะ initialization/migration พร้อม provenance ไม่ใช้เป็น Receiving ปลอมและไม่ใช้เป็นทางลัดแก้ยอดประจำวัน

## 9. Return / Adjustment / Correction

- Usable Return → positive stock movement
- Unusable Return → ไม่เพิ่ม usable stock
- Known transaction error → Correction/Reversal
- Unknown physical discrepancy → Adjustment
- ห้ามแก้ Current Stock ตรง ๆ

## 10. Material Stocktake

1. เปิด round พร้อม stable scope/expected snapshot
2. บันทึก Physical Quantity + Counted At
3. Not Counted ไม่เท่ากับ zero
4. movement ใกล้เวลา count ต้อง reconcile ได้
5. recount/revision รักษาประวัติ
6. stocktake ไม่ auto-adjust ledger; discrepancy ที่ยืนยันแล้วสร้าง Adjustment แยก
