# 07 — Audit, History & Evidence

เป้าหมายของส่วนนี้คือ **traceability ที่พอดีกับงาน** ไม่ใช่สร้าง event-sourcing/audit platform

## Action → History

ผู้ใช้ทำ business action ครั้งเดียว แล้วระบบสร้าง/เชื่อม history ที่จำเป็น เช่น

`ส่งซ่อม` → Repair Record + lifecycle history + current operational state

ผู้ใช้ไม่ควรต้องกรอก log ซ้ำเพื่อพิสูจน์ action เดียวกัน

## ข้อมูลที่ควร trace สำหรับ business action สำคัญ

- ใครเป็นผู้ดำเนินการ
- Action/record ใดเกิดขึ้น
- Effective Date/Time เมื่อมีความหมายทางธุรกิจ
- Recorded At
- Reason/remark เมื่อเป็น correction/reopen/adjustment
- ก่อน/หลัง เฉพาะข้อมูลสำคัญที่ต้อง audit
- Source business record ที่ทำให้เกิด stock/history effect
- Evidence/document reference เมื่อ use case ต้องการ

## Effective Time vs Recorded Time

ต้องแยกเมื่อ action สามารถถูกบันทึกย้อนหลังหรือเมื่อ timeline ทางธุรกิจมีผลต่อ current state/reconciliation

## Correction Principles

- Typo/metadata correction ไม่จำเป็นต้องสร้าง business lifecycle event ทุกครั้ง แต่ควร audit ตามความสำคัญ
- Fact ที่มี downstream effect แล้วห้าม silent overwrite
- Known transaction error ใช้ correction/reversal ที่ trace original
- Backdated facts ที่ conflict กับ history ต้อง preserve facts → detect conflict → human review → traceable correction

## Documents & Evidence

- เอกสารเป็น reference/evidence ไม่ใช่ document-generation workflow
- ไม่บังคับเอกสาร/รูปทุก action หาก business requirement ไม่ต้องการ
- Document หนึ่งรายการอาจเชื่อมหลาย business records ได้เมื่อเป็นเอกสารต้นทางเดียวกัน
- Material Receiving รองรับ receipt-level evidence
- Material Adjustment/Correction evidence เป็น optional ตาม use case
- ข้อมูลส่วนบุคคลของผู้ยืมภายนอกเก็บเท่าที่จำเป็น

## Verification / Stocktake History

- เก็บ snapshot ของ round เพื่ออธิบายว่า ณ เวลานั้นตรวจอะไร
- reverify/recount เก็บ revision history
- close/reopen/correction ต้องรักษาผลก่อนหน้า
- historical snapshot ไม่ต้องถูก rewrite ให้เหมือน current reconstructed state ภายหลัง

## Audit Boundary

ไม่ต้องสร้าง:

- custom governance/evidence framework ที่ไม่ใช่ business requirement
- event bus เพียงเพราะต้องมี history

เลือก implementation ที่ง่ายที่สุดซึ่งยังตอบคำถามย้อนหลังได้อย่างน่าเชื่อถือ
