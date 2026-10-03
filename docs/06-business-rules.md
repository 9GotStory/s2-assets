# 06 — Business Rules

สถานะ: **FROZEN — Blueprint v1.0.2**  
บทบาท: Catalog ของกติกาธุรกิจที่ต้องรักษาระหว่าง Specify/Clarify/Plan/Implement

เอกสารนี้รวบรวม Business Rule ทั้ง **252 ข้อ** จาก Domain baseline เดิม โดยตัดกลไก governance ออก แต่คงความหมายของกติกาไว้สำหรับการพัฒนา feature จริง

## วิธีใช้

- ใน Blueprint ให้ใช้ Rule ID เป็นภาษากลางในการอ้าง requirement ที่สำคัญ
- เมื่อเข้า Spec Kit ให้ route เฉพาะ rules ที่เกี่ยวข้องกับ feature นั้น ไม่ต้องโหลดทั้ง 252 ข้อทุกครั้ง
- `CONFIRMED` คือกติกาที่มี product/domain decision ชัดเจน
- `DERIVED GUARDRAIL` คือข้อคุ้มกันที่อนุมานจาก decision ที่ยืนยันแล้ว และควรรักษาไว้เว้นแต่ Product Owner เปลี่ยนความหมาย
- `BASELINE` คือกติกาฝั่ง Asset/System ที่เป็น baseline ของ Blueprint
- `BASELINE`, `CONFIRMED` และ `DERIVED GUARDRAIL` ระบุ provenance/ที่มาของกติกา ไม่ใช่ระดับความสำคัญหรือระดับการบังคับใช้; ภายใต้ Blueprint ที่ FROZEN ทุก rule เป็น normative constraint จนกว่า Product Owner จะเปลี่ยน Blueprint โดย `DERIVED GUARDRAIL` อาจถูกแก้เมื่อยืนยันได้ว่าการอนุมานเดิมไม่ตรง product/domain intent
- การเปลี่ยน rule ต้องเป็นการแก้ Blueprint เชิงธุรกิจ ไม่ใช่การแก้ control metadata

## SYS — System Boundary (4 rules)
| Rule ID | Status | Rule |
|---|---|---|
| `SYS-01` | BASELINE | ระบบนี้เป็น Local Operational Support System ไม่ใช่ Procurement/ERP replacement |
| `SYS-02` | BASELINE | เพิ่มความซับซ้อนเฉพาะเมื่อมี use case หรือ requirement จริงรองรับ |
| `SYS-03` | BASELINE | workflow/ข้อมูลที่ระบบส่วนกลางมีอยู่แล้ว ให้เก็บเฉพาะ reference หรือข้อมูลที่จำเป็นต่อการทำงานภายใน |
| `SYS-04` | BASELINE | Integration/API ทำเมื่อมี requirement ชัดเจน ไม่ออกแบบเผื่อ |

## ACQ — Acquisition (8 rules)
| Rule ID | Status | Rule |
|---|---|---|
| `ACQ-01` | BASELINE | การได้มาหนึ่งครั้งมี Asset หลายรายการได้ |
| `ACQ-02` | BASELINE | Acquisition ไม่ใช่ Procurement Workflow |
| `ACQ-03` | BASELINE | ข้อมูลร่วมกรอกครั้งเดียวและ reuse กับ Asset ที่เกี่ยวข้อง |
| `ACQ-04` | BASELINE | Asset แต่ละชิ้นมี identity แยกกัน |
| `ACQ-05` | BASELINE | เอกสารหนึ่งฉบับเชื่อมกับ Acquisition และหลาย Asset ได้ |
| `ACQ-06` | BASELINE | ข้อมูลเก่าไม่บังคับย้อนสร้าง Acquisition |
| `ACQ-07` | BASELINE | มูลค่ารวมแยกจากมูลค่าราย Asset |
| `ACQ-08` | BASELINE | หลีกเลี่ยง status ที่ผู้ใช้ต้องบริหารเองหากคำนวณได้ |

## AR — Asset Registration (14 rules)
| Rule ID | Status | Rule |
|---|---|---|
| `AR-01` | BASELINE | Asset หนึ่งชิ้นมี record ของตัวเอง |
| `AR-02` | BASELINE | Stable ID แยกจากเลขครุภัณฑ์; การ correction Asset Number ที่ยังอ้าง Asset เดิมเชิงธุรกิจไม่เปลี่ยน Stable ID/identity |
| `AR-03` | BASELINE | Serial Number ไม่บังคับ |
| `AR-04` | BASELINE | ห้ามสร้างข้อมูลปลอมเพื่อผ่าน validation |
| `AR-05` | BASELINE | ข้อมูล Acquisition ไม่กรอกซ้ำ |
| `AR-06` | BASELINE | Location/OrganizationUnit/Responsible Person ไม่เป็น registration prerequisite; เมื่อมีข้อมูลต้องอ้างอิงและค้นได้ และ Responsible Person ยังคง Optional ตาม AS-02/AS-04; legacy data ที่ไม่สมบูรณ์ยังอยู่ใต้ AR-10 |
| `AR-07` | BASELINE | Asset Registration ต้องสร้างจุดเริ่ม system timeline/history ที่ trace ได้สำหรับ Asset; business change หลังจากนั้นต้องสร้าง Event โดยไม่บังคับ event-sourcing architecture |
| `AR-08` | BASELINE | แก้ typo/metadata ไม่จำเป็นต้องสร้าง Business Event |
| `AR-09` | BASELINE | QR อ้าง Stable ID |
| `AR-10` | BASELINE | รองรับ legacy data ที่ไม่สมบูรณ์ |
| `AR-11` | BASELINE | duplicate ใช้ warning/review ให้เหมาะกับ migration |
| `AR-12` | BASELINE | รองรับ bulk registration จาก Acquisition เดียว |
| `AR-13` | BASELINE | Asset Number อาจไม่มี/ไม่ทราบ/อ่านไม่ได้ เมื่อแหล่งข้อมูลทะเบียนเดิมไม่มีข้อมูลจริง Asset ยังต้องมี Stable ID และห้ามสร้าง business identifier ปลอมเพื่อให้ผ่าน validation |
| `AR-14` | BASELINE | หากทะเบียนในระบบมี Asset Number อยู่แล้ว แต่ป้าย/QR บนตัวครุภัณฑ์สูญหายหรือชำรุด ห้ามล้าง Asset Number เดิมเพียงเพราะป้ายหาย; ให้บันทึกเป็น Verification/label exception ตามข้อเท็จจริง |

## AS — Assignment (10 rules)
| Rule ID | Status | Rule |
|---|---|---|
| `AS-01` | BASELINE | แยก Location, OrganizationUnit, Responsible Person |
| `AS-02` | BASELINE | ไม่บังคับผู้รับผิดชอบรายบุคคลทุก Asset |
| `AS-03` | BASELINE | ผู้ใช้งานเป็น Optional |
| `AS-04` | BASELINE | รองรับทรัพย์สินส่วนกลาง |
| `AS-05` | BASELINE | เปลี่ยน Assignment สำคัญต้องสร้าง History |
| `AS-06` | BASELINE | แยก Effective Date กับ Recorded At |
| `AS-07` | BASELINE | เอกสารอ้างอิง Optional |
| `AS-08` | BASELINE | บุคลากรพ้นหน่วยงานไม่ทำให้ History หาย |
| `AS-09` | BASELINE | Verification ไม่แก้ Assignment อัตโนมัติ |
| `AS-10` | BASELINE | ไม่สร้าง HR/Assignment Workflow ซับซ้อน |

## MR — Movement / Reassignment (19 rules)
| Rule ID | Status | Rule |
|---|---|---|
| `MR-01` | BASELINE | การเปลี่ยน Location/OrganizationUnit/Responsible จริงต้องมี Event |
| `MR-02` | BASELINE | หลาย field ในเหตุการณ์เดียวเก็บเป็น Event เดียว |
| `MR-03` | BASELINE | Current State สอดคล้องกับ Event ล่าสุดที่มีผล |
| `MR-04` | BASELINE | แยก Effective Date/Recorded At |
| `MR-05` | BASELINE | รองรับ backdate พร้อมตรวจ timeline conflict |
| `MR-06` | BASELINE | Correction ไม่ใช่ Business Event |
| `MR-07` | BASELINE | Event มีผลแล้วไม่ Hard Delete ไร้ร่องรอย |
| `MR-08` | BASELINE | เอกสาร Optional |
| `MR-09` | BASELINE | รองรับ Bulk Reassignment เมื่อมี use case |
| `MR-10` | BASELINE | Bulk ต้องเก็บค่าก่อนเปลี่ยนของแต่ละ Asset |
| `MR-11` | BASELINE | Verification ไม่แก้ registry อัตโนมัติ |
| `MR-12` | BASELINE | การปรับจากผลตรวจต้อง trace กลับ Verification |
| `MR-13` | BASELINE | การเคลื่อนย้ายที่เป็น temporary custody และคาดว่าจะคืน ต้องใช้ Loan/Return ไม่ใช่ Reassignment และห้ามเปลี่ยน Permanent Assignment เพื่อแทนการยืมชั่วคราว |
| `MR-14` | BASELINE | Reassignment เป็น action แยกจาก Loan/Repair และสามารถเกิดระหว่าง Active Loan หรือ Active Repair ได้ |
| `MR-15` | BASELINE | Loan/Repair action เองยังห้ามเปลี่ยน Permanent Assignment; Reassignment ระหว่าง Loan/Repair เปลี่ยน Permanent Assignment เท่านั้น ไม่เปลี่ยน temporary custody หรือ repair status |
| `MR-16` | BASELINE | เมื่อ Loan Return เกิด Current/Permanent Assignment ใช้ Assignment ล่าสุดที่มีผล ณ business time ของการคืน; ห้ามย้อนกลับ Assignment snapshot ตอนเริ่ม Loan อัตโนมัติ |
| `MR-17` | BASELINE | Loan/Repair สามารถเก็บ Assignment context ณ เวลาเริ่มเพื่อ history/audit ได้ แต่ snapshot นั้นห้าม override Assignment ที่เปลี่ยนภายหลัง |
| `MR-18` | BASELINE | Backdated Reassignment ที่ overlap Loan/Repair ไม่ถือเป็น error อัตโนมัติเพราะเป็นคนละมิติ แต่ต้องตรวจ timeline/semantic conflict เมื่อข้อมูลบ่งชี้ว่าข้อเท็จจริงขัดกันจริง |
| `MR-19` | BASELINE | หาก Reassignment ถูกใช้ในความหมายที่พยายามกลบ physical custody ขณะที่ Asset ยังอยู่กับผู้ยืมหรือร้านซ่อม ระบบต้องรักษา Loan/Repair custody/history ตามจริงและไม่ใช้ Reassignment เป็น shortcut |

## LR — Loan / Return (16 rules)
| Rule ID | Status | Rule |
|---|---|---|
| `LR-01` | BASELINE | Loan เป็น temporary custody |
| `LR-02` | BASELINE | รองรับภายในและภายนอก |
| `LR-03` | BASELINE | หนึ่ง Loan มีหลาย Asset |
| `LR-04` | BASELINE | รองรับคืนบางส่วน |
| `LR-05` | BASELINE | เก็บวันที่ยืมและกำหนดคืน |
| `LR-06` | BASELINE | Overdue เป็น derived state |
| `LR-07` | BASELINE | เก็บสภาพก่อนยืม/เมื่อคืนแบบเรียบง่าย |
| `LR-08` | BASELINE | เอกสาร/รูปภาพ Optional |
| `LR-09` | BASELINE | บันทึกผู้อนุญาตได้แต่ไม่สร้าง Approval Workflow |
| `LR-10` | BASELINE | การเริ่ม/มี Active Loan ไม่เปลี่ยน Permanent Assignment โดยตัวมันเอง; Reassignment เป็น action แยกที่ทำได้ตาม MR-14–MR-19 |
| `LR-11` | BASELINE | Asset เดียวห้าม Active Loan ซ้อน |
| `LR-12` | BASELINE | Asset ซ่อมหรือ Retired ห้ามยืม |
| `LR-13` | BASELINE | คืนแล้วชำรุดเสนอ Action สร้าง Repair ได้ |
| `LR-14` | BASELINE | Verification รับรู้ Loan เป็นบริบท |
| `LR-15` | BASELINE | ข้อมูลผู้ยืมภายนอกยึด Data Minimization |
| `LR-16` | BASELINE | ยังไม่ทำ Reservation/Queue/Sub-loan |

## RM — Repair / Maintenance (15 rules)
| Rule ID | Status | Rule |
|---|---|---|
| `RM-01` | BASELINE | Asset มี Repair/Maintenance หลายรายการได้ |
| `RM-02` | BASELINE | Repair record แยกจาก Asset current data |
| `RM-03` | BASELINE | Repair/Maintenance ใช้โครงสร้างร่วมกันเท่าที่เหมาะ |
| `RM-04` | BASELINE | ส่งซ่อมสร้าง Event/ปรับสถานะอัตโนมัติ |
| `RM-05` | BASELINE | Repair action ไม่เปลี่ยน Permanent Assignment โดยตัวมันเอง; Reassignment เป็น action แยกที่ทำได้ตาม MR-14–MR-19 |
| `RM-06` | BASELINE | อยู่ระหว่างซ่อมห้ามยืม |
| `RM-07` | BASELINE | Active Loan ต้องจัดการก่อนซ่อม |
| `RM-08` | BASELINE | Loan Return/Verification เป็น source ของ Repair ได้ |
| `RM-09` | BASELINE | ค่าใช้จ่าย Optional; ไม่ทำบัญชี |
| `RM-10` | BASELINE | เอกสาร Optional |
| `RM-11` | BASELINE | ซ่อมไม่ได้ ≠ จำหน่าย |
| `RM-12` | BASELINE | ไม่สร้าง Scheduled Maintenance Engine |
| `RM-13` | BASELINE | เก็บผู้ดำเนินการและเวลาเพื่อ Audit |
| `RM-14` | BASELINE | ข้อมูลวันสิ้นสุดการรับประกันและการระบุว่าการซ่อมอยู่ภายใต้ประกันเป็น Optional โดยยังไม่สร้าง Warranty Claim Workflow |
| `RM-15` | BASELINE | Maintenance สามารถเก็บวันที่แนะนำบำรุงรักษาครั้งถัดไปแบบ Optional แต่ห้ามสร้าง recurring schedule / work order / SLA engine จนกว่าจะมี requirement |

## AV — Annual Asset Verification (24 rules)
| Rule ID | Status | Rule |
|---|---|---|
| `AV-01` | BASELINE | การตรวจอยู่ภายใต้ Verification Round |
| `AV-02` | BASELINE | รอบตรวจมี Scope/Snapshot |
| `AV-03` | BASELINE | รองรับตรวจโดยเจ้าหน้าที่และ QR |
| `AV-04` | BASELINE | QR เป็น identification ไม่ใช่ auto verify |
| `AV-05` | BASELINE | แยกผลพบ/ไม่พบจากสภาพ |
| `AV-06` | BASELINE | ใช้คำว่าไม่พบในการตรวจ |
| `AV-07` | BASELINE | เก็บ Observed Location และเทียบทะเบียน |
| `AV-08` | BASELINE | รองรับหลาย discrepancy โดยไม่สร้าง status เยอะ |
| `AV-09` | BASELINE | Loan/Repair เป็น context ไม่ใช่ proof |
| `AV-10` | BASELINE | ไม่บังคับรูปภาพ |
| `AV-11` | BASELINE | ไม่เก็บ GPS จนมี use case |
| `AV-12` | BASELINE | หนึ่ง current result ต่อ Asset/round + revision history |
| `AV-13` | BASELINE | re-verify ไม่ลบผลเดิม |
| `AV-14` | BASELINE | ผลตรวจไม่แก้ Registry อัตโนมัติ |
| `AV-15` | BASELINE | ปรับ Registry จากผลตรวจต้องสร้าง Event และ trace กลับ |
| `AV-16` | BASELINE | ผลชำรุดเสนอ Action สร้าง Repair |
| `AV-17` | BASELINE | รอบปิดแล้วเป็น Historical Record |
| `AV-18` | BASELINE | Asset ใหม่หลังเริ่มรอบไม่เพิ่มอัตโนมัติ |
| `AV-19` | BASELINE | มีรายการค้าง/ต้องติดตาม |
| `AV-20` | BASELINE | ไม่ทำ Inspection Workflow/Route/Approval Engine |
| `AV-21` | BASELINE | Asset ใหม่หลังเริ่มรอบไม่ถูกเพิ่มอัตโนมัติ แต่ผู้มีสิทธิ์สามารถเพิ่มเข้ารอบภายหลังได้เมื่อมีเหตุผลจริง โดยต้องเก็บว่าเพิ่มเมื่อใด โดยใคร และเหตุผล/ที่มาของการเพิ่ม |
| `AV-22` | BASELINE | ห้าม hard-code ว่ารอบตรวจต้องครบ 100% ก่อนปิดจนกว่าจะ Clarify กติกางานจริง ระบบควรสามารถแสดง Warning/Summary ของรายการค้าง และ close-rule สุดท้ายยังเป็น Open Decision |
| `AV-23` | BASELINE | หาก Asset ถูกตรวจแล้วใน Verification Round เดียวกันและถูกค้น/สแกนซ้ำ ระบบต้องแสดง current result ล่าสุดพร้อมเวลาและผู้ตรวจที่เกี่ยวข้อง และห้ามสร้าง current result ซ้ำ หรือ overwrite ผลเดิมแบบเงียบ ๆ; การตรวจใหม่ต้องเป็น explicit re-verification และเก็บ revision history |
| `AV-24` | BASELINE | เมื่อ Verification Round ปิดแล้ว ต้องจำกัดการแก้ผลตรวจตามปกติ การ correction หรือ reopen (หากมี action นี้ใน Specification) ต้องมี permission, reason และ audit trail พร้อมรักษาประวัติก่อนแก้ โดยไม่สร้าง approval engine เพิ่มโดยไม่มี requirement |

## DR — Asset Retirement (19 rules)
| Rule ID | Status | Rule |
|---|---|---|
| `DR-01` | BASELINE | Retirement ไม่ใช่ Delete |
| `DR-02` | BASELINE | เก็บผลของกระบวนการ ไม่สร้าง workflow จำหน่ายราชการ |
| `DR-03` | BASELINE | ไม่พบในการตรวจ ≠ สูญหาย/จำหน่าย |
| `DR-04` | BASELINE | ซ่อมไม่ได้ ≠ จำหน่าย |
| `DR-05` | BASELINE | แยก Effective Date/Recorded At |
| `DR-06` | BASELINE | เอกสารอ้างอิงได้แต่ไม่ generate เอกสาร |
| `DR-07` | BASELINE | Retirement ปรับ state + history อัตโนมัติ |
| `DR-08` | BASELINE | Retired ห้าม operational actions ใหม่ |
| `DR-09` | BASELINE | Retired ยังค้น/QR/History ได้ |
| `DR-10` | BASELINE | Retired ก่อน snapshot ไม่เข้ารอบใหม่ |
| `DR-11` | BASELINE | Retired ระหว่างรอบไม่ลบจาก snapshot เดิม |
| `DR-12` | BASELINE | Correction Retirement ต้องมีสิทธิ์/Audit |
| `DR-13` | BASELINE | Bulk Retirement เพิ่มได้เมื่อมี use case โดยไม่ทำ workflow เต็มระบบ |
| `DR-14` | BASELINE | Normal Retirement ต้องไม่มี Active Loan ที่ยัง unresolved |
| `DR-15` | BASELINE | Normal Retirement ต้องไม่มี Active Repair ที่ยัง unresolved |
| `DR-16` | BASELINE | Retirement ห้าม auto-return Loan, auto-close Repair หรือสร้าง business outcome ปลอมเพื่อให้ผ่าน validation; Loan/Repair ต้อง resolve ตามข้อเท็จจริงก่อน โดยไม่จำเป็นว่า Asset ต้องกลับมา usable |
| `DR-17` | BASELINE | Repair result เช่น “ซ่อมไม่ได้” เป็นบริบทก่อน Retirement ได้แต่ไม่ทำให้ Retirement เกิดอัตโนมัติ; Retirement ยังต้องสะท้อนผลของกระบวนการจริงที่เสร็จแล้ว |
| `DR-18` | BASELINE | หาก Backdated Retirement มี Effective Date conflict กับ Loan/Repair/Reassignment/Verification ที่มีอยู่ ระบบต้องรักษา history ทั้งหมดและ surface timeline/reconciliation conflict ห้าม silent rewrite/auto-delete |
| `DR-19` | BASELINE | การแก้ temporal conflict จาก Retirement ต้อง correction record/date ที่ผิดตามข้อเท็จจริงพร้อม permission/audit; ระบบห้ามเดาว่าเหตุการณ์ใดผิด |

## MC — Material Catalog & Units (26 rules)
| Rule ID | Status | Rule |
|---|---|---|
| `MC-01` | DERIVED GUARDRAIL | วัสดุสิ้นเปลืองติดตามเป็นรายการและจำนวน ไม่ติดตามรายชิ้นแบบ Asset |
| `MC-02` | DERIVED GUARDRAIL | StockMaterial ต้องมี Stable System ID ที่ไม่ derive จากชื่อ/Brand/Model/Specification |
| `MC-03` | DERIVED GUARDRAIL | การแก้ display name/Brand/Model/Specification/Variant บน StockMaterial เดิมทำได้เฉพาะ correction ของข้อมูลผิดและยังเป็นรายการเดิมเชิงธุรกิจ; correction ต้องไม่ rewrite ประวัติ transaction |
| `MC-04` | CONFIRMED | StockMaterial ต้องมี Base Unit หนึ่งหน่วย |
| `MC-05` | CONFIRMED | StockMaterial รองรับ Alternate Units หลายระดับ โดยแต่ละหน่วยมี Conversion Factor ไป Base Unit โดยตรง |
| `MC-06` | CONFIRMED | Transaction สามารถใช้หน่วยที่กำหนดสำหรับ StockMaterial นั้น และระบบ normalize ไป Base Unit |
| `MC-07` | CONFIRMED | Stock Ledger ใช้ Base Unit เป็น source of truth |
| `MC-08` | CONFIRMED | Transaction เก็บ Original Quantity, Original Unit, Conversion Snapshot และ Base Quantity |
| `MC-09` | CONFIRMED | การแก้ Conversion ในอนาคตห้ามเปลี่ยนผล Transaction ในอดีต |
| `MC-10` | CONFIRMED | Brand, Model และ Specification แยกจาก Material Name |
| `MC-11` | CONFIRMED | Brand/Model/Specification ที่ต้องติดตาม Stock แยกต้องเป็น StockMaterial คนละรายการ |
| `MC-12` | CONFIRMED | Brand ใช้ lightweight reusable reference/list เพื่อช่วยความสม่ำเสมอของข้อมูล; ผู้มีสิทธิ์เพิ่ม Brand ใหม่ได้เมื่อจำเป็นโดยไม่สร้าง approval workflow, Brand แยกจาก Receiving Source Party/Vendor, ไม่บังคับทุก StockMaterial หากข้อมูลจริงไม่มี, normalize ชื่อเดิมได้เมื่อ identity เดิมไม่เปลี่ยนพร้อม audit ตามความเหมาะสม และ v1 ไม่สร้าง Manufacturer hierarchy/Brand alias/governance workflow |
| `MC-13` | DERIVED GUARDRAIL | ยังไม่สร้าง Dynamic Attribute/EAV Engine โดยไม่มี requirement |
| `MC-14` | CONFIRMED | Inactive ไม่ลบ record/history: Inactive StockMaterial ที่ยังมี stock ต้องยัง Issue/Return/Adjustment/Stocktake และมองเห็นในงานคลังได้ แต่ไม่เสนอเป็น default สำหรับ normal new Receiving/new mapping; เมื่อ Inactive และ Stock = 0 สามารถซ่อนจาก routine selector ที่ใช้เริ่มงานใหม่ได้แต่ยังต้องค้นย้อนหลังได้; historical/backdated/correction ยังอ้างรายการเดิมได้ตามข้อเท็จจริง Inactive RequestableMaterial ไม่ใช้สร้าง request ใหม่ตามปกติแต่ history เดิมยังอ่าน/trace ได้ และสามารถ reactivate identity เดิมพร้อม audit โดยไม่สร้าง approval workflow เพิ่ม |
| `MC-15` | CONFIRMED | รองรับ Opening Balance สำหรับ initialization/migration พร้อม provenance; Opening Balance ไม่ใช่ Material Receiving และไม่ใช่ transaction ประจำวัน |
| `MC-16` | CONFIRMED | Source Organization/Vendor/Source Party เป็น Receiving transaction context ที่เก็บเท่าที่จำเป็นต่อ traceability และไม่เป็น identity ของ StockMaterial; v1 ใช้ lightweight reusable Source Party reference ที่กว้างกว่า Vendor โดยไม่สร้าง Procurement Vendor Management |
| `MC-17` | CONFIRMED | v1 ใช้ duplicate candidate detection/warning/review ตอนสร้างหรือแก้ StockMaterial ที่มีผลต่อ identity โดยพิจารณา Name/Brand/Model/Specification/Variant/Base Unit/packaging-conversion context ตามความเหมาะสม; ไม่ hard-code uniqueness จาก Name+Brand+Model+Specification ผู้มีสิทธิ์สร้างต่อได้เมื่อเป็นคนละ identity จริง Packaging/conversion ที่ coexist และมี quantity semantics ต่างกันตาม MC-22 ไม่ถือเป็น duplicate ที่ต้อง merge, Inactive record ยังเป็น candidate และ duplicate ที่มี transaction แล้วห้าม hard-delete/merge/rewrite history แบบเงียบ ๆ; หากภายหลังจำเป็นต้อง resolve/merge duplicate ต้องใช้ controlled traceable mechanism ที่รักษา historical identities/transactions โดย exact mechanism เป็น feature-level clarification |
| `MC-18` | CONFIRMED | หากความแตกต่างของ Brand/Model/Specification เป็นของจริงที่ต้องติดตาม Stock แยก ให้สร้าง StockMaterial คนละ identity; ห้ามเปลี่ยน identity เดิมจนทำให้ historical stock กลายเป็นสินค้าอีกชนิด |
| `MC-19` | DERIVED GUARDRAIL | Current Stock ต้อง derive/reconcile จาก movement set ที่ได้รับการยืนยัน ไม่ใช่ issue-side เพียงด้านเดียว; v1 ไม่มี separate reserved/available balance จาก Decision |
| `MC-20` | CONFIRMED | Minimum Stock เป็น Optional ต่อ StockMaterial และมี semantics ใน Base Unit; หากไม่กำหนดห้ามระบบเดา threshold `Low Stock` derive จาก `Current Stock < Minimum Stock` โดยไม่หัก Outstanding Decision เพราะ v1 ไม่มี Reservation การเปลี่ยน threshold ไม่สร้าง Stock Movement แต่ควร audit ตามความเหมาะสม และ v1 ใช้ Minimum Stock สำหรับ indicator/search/filter/basic reporting เท่านั้น ไม่สร้าง auto-reorder/forecast/procurement workflow |
| `MC-21` | CONFIRMED | ก่อนมี stock-affecting transaction สามารถแก้ Base Unit ได้; หลังมี transaction แล้ว Base Unit ถูก freeze สำหรับ normal operation การแก้ที่จำเป็นต้องเป็น controlled correction/migration และห้าม silent historical rebase |
| `MC-22` | CONFIRMED | หาก packaging/conversion หลายแบบ coexist และมีผลต่อ quantity semantics ต้องแยก stock-tracked identity ให้ชัด; ถ้าของแบบเก่าหมดแล้วอาจเปลี่ยน conversion สำหรับอนาคตได้โดยไม่เปลี่ยน historical snapshots |
| `MC-23` | CONFIRMED | ระบบรองรับ fractional quantity เมื่อ unit/material จริงจำเป็น; unit ที่ต้องเป็นจำนวนเต็มต้องรักษากติกานั้น และห้าม silent rounding |
| `MC-24` | CONFIRMED | v1 ไม่รองรับ Lot tracking, Expiry tracking หรือ FEFO allocation/issue logic เป็น baseline; ห้ามเพิ่ม field/workflow เหล่านี้เพียงเพื่อรองรับอนาคต |
| `MC-25` | CONFIRMED | Lot/Expiry เพิ่มภายหลังเฉพาะเมื่อมี StockMaterial/use case จริงที่ต้องติดตาม และแม้มี Expiry requirement ก็ไม่ถือว่า FEFO ตามมาอัตโนมัติ; FEFO ต้องมี requirement แยก |
| `MC-26` | CONFIRMED | v1 ใช้ Material Category แบบ flat reusable reference โดย exact vocabulary มาจากข้อมูลจริงของสำนักงาน; Category เป็น classification ไม่ใช่ StockMaterial identity/compatibility baseline หนึ่ง StockMaterial ใช้ primary category เดียวและ legacy record ที่ไม่มี Category จริงต้องรองรับได้โดยไม่ fabricate ข้อมูล; การ rename/reclassify Category ห้าม rewrite Stock transaction history และยังไม่สร้าง multi-category/taxonomy/versioning engine |

## MRQ — Material Request / Decision / Issue (40 rules)
| Rule ID | Status | Rule |
|---|---|---|
| `MRQ-01` | CONFIRMED | ผู้ใช้งานทั่วไปต้องขอเบิกได้โดยไม่จำเป็นต้องรู้ StockMaterial ทั้งหมด |
| `MRQ-02` | CONFIRMED | แยก RequestableMaterial ออกจาก StockMaterial เมื่อช่วย UX และความถูกต้องของคลัง |
| `MRQ-03` | CONFIRMED | เจ้าหน้าที่พัสดุเป็นผู้ตัดสินใจ StockMaterial จริงที่จะจ่าย |
| `MRQ-04` | CONFIRMED | Requested Item และ Fulfilled StockMaterial ต้องเก็บแยกกัน |
| `MRQ-05` | CONFIRMED | Requested Quantity, Decision/Allowed Quantity และ Issued Quantity ต้องแยกจากกัน |
| `MRQ-06` | CONFIRMED | รองรับให้จ่ายบางส่วนและไม่ให้จ่าย พร้อมเหตุผล/หมายเหตุตามความจำเป็น |
| `MRQ-07` | CONFIRMED | Supply Officer Decision ไม่ทำให้ Stock ลด |
| `MRQ-08` | CONFIRMED | Stock Movement ฝั่งเบิกเกิดเมื่อจ่ายของจริงเท่านั้น |
| `MRQ-09` | CONFIRMED | เจ้าหน้าที่พัสดุจ่ายด้วยหน่วยต่างจากหน่วยที่ผู้ขอระบุได้เมื่อ business-equivalent ที่ยืนยันได้ |
| `MRQ-10` | CONFIRMED | Issue เก็บ Original Quantity, Original Unit, Conversion Snapshot และ Base Quantity |
| `MRQ-11` | CONFIRMED | ไม่สร้าง Multi-level Approval Workflow จนกว่าจะมี requirement |
| `MRQ-12` | CONFIRMED | UI ผู้ขอเน้นความง่าย; UI เจ้าหน้าที่พัสดุแสดงรายละเอียด Stock ที่จำเป็นต่อการตัดสินใจ |
| `MRQ-13` | CONFIRMED | Supply Officer Decision เป็น operational fulfillment decision ไม่ใช่ formal government/procurement approval |
| `MRQ-14` | DERIVED GUARDRAIL | Decision ที่อ้าง Stock ต้องใช้ Stock context ที่เชื่อถือได้ ห้ามแสดงยอดเสมือนถูกต้องหาก ledger semantics ยังไม่พร้อม |
| `MRQ-15` | DERIVED GUARDRAIL | RequestableMaterial → StockMaterial mapping ห้าม infer จาก Name/Category/Brand/Model หรือ AI; ต้องยึด explicit confirmed compatibility/unit semantics ตาม MRQ-26 ถึง MRQ-30 |
| `MRQ-16` | CONFIRMED | Material Request หนึ่งใบมี Requested Items หลายรายการได้; Supply Officer Decision อยู่ระดับ Requested Item และ Request-level state ควร derive จาก item states เมื่อคำนวณได้ |
| `MRQ-17` | CONFIRMED | Requested Item หนึ่งรายการ fulfil ด้วย StockMaterial หลายรายการได้เมื่อแต่ละรายการ compatible; แต่ละ Fulfillment/Issue Line เก็บ StockMaterial + Quantity + Unit + Conversion Snapshot ของตัวเอง |
| `MRQ-18` | CONFIRMED | Requested Item รองรับหลาย Issue Events; Stock ลดตามแต่ละ Issue ที่เกิดจริง และ Remaining-to-Issue เป็น derived quantity |
| `MRQ-19` | CONFIRMED | ก่อนมี Issue จริงสามารถ cancel Request/Requested Item ได้; หากจ่ายบางส่วนแล้ว cancel ได้เฉพาะ remainder โดยรักษา Requested/Decision/Issued history เดิม การยกเลิกต้องไม่ hard-delete ประวัติและต้อง trace Cancelled By/At พร้อม reason/note ตามความเหมาะสม |
| `MRQ-20` | CONFIRMED | ของที่จ่ายจริงแล้วห้ามถูกลบด้วย Cancel; การเอาของกลับใช้ Material Return และการบันทึก Issue ผิดใช้ Correction/Reversal/Adjustment ที่ trace ได้ |
| `MRQ-21` | CONFIRMED | Supply Officer Decision ไม่ reserve Stock ใน v1; Outstanding Decisions แสดงเป็น context ได้แต่ไม่ลด Current Stock และ Remaining-to-Issue ไม่ใช่ Reserved Quantity |
| `MRQ-22` | CONFIRMED | ตอน Issue ต้อง validate Current Stock ณ เวลาจ่ายจริง ไม่ยึด Stock ณ เวลา Decision |
| `MRQ-23` | CONFIRMED | Actual Issue substitute StockMaterial ต่างจาก Decision ได้เมื่อ compatible กับ Requested Item และระบบต้อง trace ความต่าง โดยห้าม overwrite Decision history เดิม |
| `MRQ-24` | CONFIRMED | Stock Movement ฝั่ง Issue อ้าง StockMaterial/Quantity/Unit ที่จ่ายจริง ไม่ใช่ Decision item ที่ไม่ได้จ่ายจริง |
| `MRQ-25` | CONFIRMED | เมื่อ Current Stock เชื่อถือได้ Normal Material Issue ห้ามทำให้ Stock ต่ำกว่า 0; ต้อง hard-block และไม่มี Force Negative/Force Issue เป็นทางลัดทั่วไปใน v1 |
| `MRQ-26` | CONFIRMED | RequestableMaterial → StockMaterial compatibility ต้อง explicit/confirmed; ชื่อ Category Brand Model หรือ similarity/AI ไม่เป็น proof of compatibility และ v1 ไม่สร้าง generic compatibility rule engine |
| `MRQ-27` | CONFIRMED | Compatibility mapping รองรับ many-to-many เมื่อ business meaning จริงรองรับ: RequestableMaterial หนึ่งรายการ fulfil ได้ด้วยหลาย StockMaterial และ StockMaterial หนึ่งรายการอาจ fulfil หลาย RequestableMaterial ได้ |
| `MRQ-28` | CONFIRMED | RequestableMaterial ต้องมี request-unit semantics ที่ชัดเจน การแปลง Request Unit → StockMaterial quantity ต้อง explicit หรือ reuse StockMaterial unit conversion ที่ semantics ตรงกันจริง; ห้ามเดา conversion |
| `MRQ-29` | CONFIRMED | เมื่อ fulfil Requested Item ด้วยหลาย StockMaterial ระบบต้อง reconcile ปริมาณที่จ่ายกลับไปยัง Requested Quantity ใน request semantics เดียวกันได้; ถ้า reconcile ไม่ได้ห้าม claim ว่า fulfil ครบ |
| `MRQ-30` | CONFIRMED | การเปลี่ยน compatibility/unit mapping ในอนาคตห้าม rewrite historical Decision/Issue semantics เดิม; transaction history ต้องรักษาสิ่งที่ถูกตัดสินใจและจ่ายจริง ณ เวลานั้น |
| `MRQ-31` | CONFIRMED | Requested Item หนึ่งรายการมีหนึ่ง logical current Decision ในเชิงผลการพิจารณา และ Decision หนึ่งรายการรองรับ planned StockMaterial allocations ได้หลายรายการ |
| `MRQ-32` | CONFIRMED | Decision/Allowed Quantity มีความหมายใน request semantics / Request Unit เพื่อเทียบกับ Requested Quantity และ derive fulfillment; planned allocation แต่ละรายการเก็บ StockMaterial + Quantity/Unit ของ StockMaterial และต้อง reconcile กลับ request semantics ได้อย่าง deterministic |
| `MRQ-33` | CONFIRMED | Decision/Allowed Quantity ห้ามมากกว่า Requested Quantity; หากต้องการเพิ่มจำนวนต้องแก้/เพิ่ม Request หรือใช้ traceable amendment ตาม workflow ที่ Specification ยืนยัน ไม่เพิ่ม entitlement เกินคำขอแบบเงียบ ๆ |
| `MRQ-34` | CONFIRMED | cumulative valid fulfilled quantity จาก Issue ห้ามเกิน Decision/Allowed Quantity; หากต้องเพิ่ม Allowed Quantity ต้องมี traceable Decision amendment/revision และห้ามทำให้ Issue ที่เกิดจริงแล้วหายจาก history |
| `MRQ-35` | CONFIRMED | สำหรับ remainder ที่ยัง active, `Remaining-to-Issue = Allowed Quantity − cumulative valid fulfilled quantity` ใน request semantics; ค่านี้ไม่ใช่ Reserved Quantityและไม่ derive จาก Current Stock หาก remainder ถูก Cancel ตาม MRQ-19 ให้ operational `Remaining-to-Issue = 0` โดยยังรักษา historical Requested/Allowed/Issued values และ cancellation trail |
| `MRQ-36` | CONFIRMED | Normal Material Issue ใน v1 ต้อง trace กลับ Material Request + Requested Item + Supply Officer Decision; v1 ไม่มี generic Direct/Quick Issue หรือ Issue-without-Request เป็น normal workflow |
| `MRQ-37` | CONFIRMED | Legacy/migration ที่ไม่มี Request/Decision history ห้าม fabricate Request/Decision ย้อนหลัง; หากมีหลักฐานของ historical Issue จริง ระบบอาจเก็บ/import เป็น historical legacy Issue พร้อม provenance และ explicit missing-source context โดยไม่ถือเป็น Normal Operational Issue; ข้อเท็จจริงอื่นให้ใช้ Correction/Adjustment/ธุรกรรมที่ตรงเหตุการณ์จริง |
| `MRQ-38` | CONFIRMED | Normal Material Return ไม่ลดหรือ overwrite cumulative Issued history; Returned Quantity ต้องเก็บ/derive แยกจาก Issued Quantity |
| `MRQ-39` | CONFIRMED | Normal Material Return ไม่เพิ่ม `Remaining-to-Issue` หรือสร้าง entitlement ใหม่โดยอัตโนมัติ; การคืนเพราะไม่ใช้/เหลือ/คืนคลังไม่เปิดสิทธิ์จ่ายทดแทนเอง |
| `MRQ-40` | CONFIRMED | หาก Issue เดิมผิด ต้องใช้ Issue Correction/Reversal ที่ trace ได้ ไม่ใช้ Normal Return เพื่อเปลี่ยน fulfillment history; หากต้องจ่ายทดแทนจริงให้ใช้ explicit traceable replacement/re-fulfillment entitlement/decision (หรือ amendment ที่สร้าง replacement entitlement แยกอย่างชัดเจน) โดยไม่เพิ่ม/เขียนทับ original Allowed Quantity แบบเงียบ ๆ และไม่เปลี่ยน Issued/Returned history เดิม |

## MRC — Material Receiving (11 rules)
| Rule ID | Status | Rule |
|---|---|---|
| `MRC-01` | CONFIRMED | Material Receipt หนึ่งรายการมี Receipt Lines หลาย StockMaterial ได้ โดยข้อมูลร่วมอยู่ระดับ Receipt และ quantity/unit/conversion อยู่ระดับ line |
| `MRC-02` | CONFIRMED | Material Receiving บันทึกข้อเท็จจริงว่าวัสดุเข้าความครอบครอง/Stock ของสำนักงานจริง ไม่ใช่ Procurement/Approval/Payment workflow |
| `MRC-03` | CONFIRMED | Draft/การเริ่มกรอก Receipt ยังไม่กระทบ Stock; Stock เพิ่มเมื่อมี business action ยืนยันว่ารับวัสดุจริงและ Receipt มีผลแล้วเท่านั้น |
| `MRC-04` | CONFIRMED | หลัง Receipt มีผลต่อ Stock แล้ว quantity/StockMaterial/unit ที่มีผลต่อยอดห้าม silent overwrite; correction ต้อง trace ค่าเดิม/ใหม่ ผู้แก้ เวลา เหตุผล/หลักฐานตามความเหมาะสม |
| `MRC-05` | CONFIRMED | แยก Received/Effective Date จาก Recorded At/Recorded By เพื่อรองรับการบันทึกย้อนหลังโดยไม่ปลอมเวลา |
| `MRC-06` | CONFIRMED | Receipt เก็บ Source/Origin ตามข้อเท็จจริงที่จำเป็น; Source เป็น transaction context ไม่ใช่ StockMaterial identity และประเภท Source จริงยังไม่ freeze เป็น enum จนกว่าจะดู vocabulary งานจริง |
| `MRC-07` | CONFIRMED | Receipt เชื่อม Documents/Evidence ที่มีอยู่จริงได้แต่ไม่บังคับไฟล์ทุกครั้ง; receipt-level evidence เป็น default, reference metadata แยกจาก attachment และระบบไม่ generate เอกสารราชการ |
| `MRC-08` | CONFIRMED | Receipt สามารถเก็บ Unit Price/Line Amount/Total Amount เป็น Optional reference ตาม Original Unit ได้; ห้ามสร้างราคาปลอมเมื่อไม่ทราบ และ v1 ไม่ทำ FIFO/LIFO/Weighted Average/Inventory Valuation จากข้อมูลนี้; correction ราคาไม่เปลี่ยน Stock Quantity หาก quantity จริงไม่เปลี่ยน |
| `MRC-09` | CONFIRMED | v1 ใช้ lightweight reusable Source Party reference เพื่อลด free-text duplication โดย Source Party กว้างกว่า Vendor และอาจเป็นบริษัท ร้านค้า หน่วยงานรัฐ หรือองค์กรต้นทางอื่น; Source Party ไม่บังคับทุก Receipt หากข้อมูลจริงไม่มี/ไม่ทราบ |
| `MRC-10` | CONFIRMED | Source Party เป็น Receiving context เพื่อ traceability ไม่ใช่ Procurement Vendor Master; v1 ไม่ทำ Tax/Bank/Credit/Contract/Supplier scoring หรือ Vendor procurement workflow |
| `MRC-11` | CONFIRMED | การ normalize ชื่อ Source Party ทำได้เมื่อยังเป็นองค์กรเดียวกันพร้อม audit ตามความเหมาะสม แต่หาก Receipt อ้าง Source Party ผิดจริงต้องแก้ผ่าน transaction correction semantics ไม่ใช้ master rename เพื่อกลบ transaction error |

## MOB — Opening Balance (4 rules)
| Rule ID | Status | Rule |
|---|---|---|
| `MOB-01` | CONFIRMED | Opening Balance ใช้สำหรับ initialization/migration ของ stock เดิมเมื่อไม่ควร fabricate Receiving history ย้อนหลัง |
| `MOB-02` | CONFIRMED | Opening Balance เป็น traceable initialization movement ที่สะท้อนยอดตั้งต้นซึ่งตรวจสอบ/ยอมรับตามข้อมูลจริง ไม่ใช่ Material Receiving; baseline นี้ยังไม่สร้าง semantics ของ “negative Opening Balance” เพิ่มเอง |
| `MOB-03` | CONFIRMED | Opening Balance ต้องมี provenance/แหล่งที่มาของยอด เช่น stocktake เดิม, Excel, สมุดคุม หรือ migration source และต้องระบุ As-of/Cutover point ที่ชัดเจนว่าตัวเลขตั้งต้นครอบคลุมข้อเท็จจริงถึงเมื่อใด; transaction history ที่รวมอยู่ในยอดตั้งต้นแล้วห้ามสร้าง Stock Movement ซ้ำจนทำให้ stock effect ถูกนับซ้ำ และห้ามสร้าง history ที่ไม่มีหลักฐานรองรับ |
| `MOB-04` | CONFIRMED | หลัง Stock Ledger เริ่มใช้งานแล้ว Opening Balance ห้ามใช้เป็น transaction ประจำวันหรือทางลัดแก้ยอด; discrepancy ภายหลังใช้ Correction/Adjustment ตามข้อเท็จจริง |

## MRT — Material Return (5 rules)
| Rule ID | Status | Rule |
|---|---|---|
| `MRT-01` | CONFIRMED | Material Return เป็น business event แยกจาก Issue; ห้ามแก้ Issue เดิมย้อนหลังเพื่อจำลองการคืน |
| `MRT-02` | CONFIRMED | Return ที่มาจาก Issue ในระบบต้อง trace กลับ Original Issue/Issue Line; cumulative valid source-linked Return ต้องไม่เกิน returnable quantity ของ source หลังคำนึงถึง correction/reversal ที่มีผล และห้ามทำให้ usable stock เพิ่มเกินจำนวนที่คืนได้จริง; legacy case ที่ไม่มี Issue history ห้ามสร้าง Issue ปลอมและต้องใช้ provenance ที่เหมาะสม |
| `MRT-03` | CONFIRMED | Return ต้องระบุ StockMaterial ของจริงที่คืน และ Return Line เก็บ Original Quantity, Original Unit, Conversion Snapshot, Base Quantity |
| `MRT-04` | CONFIRMED | เฉพาะจำนวนที่สำนักงานรับกลับและถือว่าสามารถกลับเข้าสู่ usable stock ได้จึงสร้าง positive Stock Movement |
| `MRT-05` | CONFIRMED | ของที่คืนแต่ชำรุด/ใช้ไม่ได้ห้ามเพิ่มเป็น usable stock โดยอัตโนมัติ; ต้องเข้าสู่ Unusable/Adjustment semantics ตามข้อเท็จจริง |

## MADJ — Material Adjustment / Correction (7 rules)
| Rule ID | Status | Rule |
|---|---|---|
| `MADJ-01` | CONFIRMED | Adjustment เป็น traceable Stock Movement; ผู้ใช้ห้ามแก้ Current Stock โดยตรง |
| `MADJ-02` | CONFIRMED | Correction ใช้เมื่อรู้ว่า transaction เดิมถูกบันทึกผิดและต้อง trace กลับ source transaction พร้อมรักษา original history; correction ต้องไม่ orphan, delete หรือ silent-rewrite dependent business records/history และหาก correction ทำให้ข้อเท็จจริง downstream ไม่สอดคล้องต้อง surface reconciliation conflict เพื่อให้แก้ตามข้อเท็จจริง; exact reversal-vs-delta implementation ยังให้ Plan/Clarify กำหนดโดยไม่ละเมิดหลักนี้ |
| `MADJ-03` | CONFIRMED | Adjustment ใช้เมื่อพบข้อเท็จจริงใหม่ เช่น stocktake discrepancy หรือความคลาดเคลื่อนที่อ้าง source transaction เดิมไม่ได้ตรง ๆ; ห้ามสร้าง Receipt/Issue ปลอมเพื่อทำให้ยอดลงตัว |
| `MADJ-04` | CONFIRMED | Adjustment รองรับทั้งเพิ่มและลดเมื่อข้อเท็จจริงรองรับ; หากรู้ transaction ต้นเหตุจริงต้องใช้ correction path ไม่ใช้ generic adjustment เป็นทางลัด |
| `MADJ-05` | CONFIRMED | วัสดุที่ไม่สามารถจ่ายใช้งานต่อได้ต้องถูกนำออกจาก usable stock ด้วย traceable event พร้อม reason/provenance ตามความเหมาะสม |
| `MADJ-06` | CONFIRMED | Adjustment/Correction ต้องรักษา Effective Date, Recorded By/At, StockMaterial, Original Quantity/Unit, Conversion Snapshot, Base Quantity และ reason; Document/Photo/Evidence เป็น Optional ตามกรณี |
| `MADJ-07` | CONFIRMED | v1 ไม่สร้าง damaged/quarantine warehouse หรือ complex stock-status ledger จนกว่าจะมี requirement จริง |

## MSL — Stock Ledger (12 rules)
| Rule ID | Status | Rule |
|---|---|---|
| `MSL-01` | CONFIRMED | v1 ใช้ One Logical Office Stock; ไม่แยก balance ตามห้อง ตู้ กลุ่มงาน ผู้เบิก หรือผู้ใช้งาน |
| `MSL-02` | CONFIRMED | เมื่อ Material Issue เกิดจริง จำนวนที่จ่ายถือว่าออกจาก Office Stock และระบบไม่ติดตามการบริโภคหลังผู้รับนำไปใช้; multi-location/transfer เพิ่มภายหลังเฉพาะเมื่อมีคลังหลายแห่งที่บริหารยอดแยกจริง |
| `MSL-03` | CONFIRMED | Current Stock เป็น derived state จาก authoritative Stock Movement effects เช่น Opening Balance + Receiving + Usable Return ± Adjustment/Correction − Issue |
| `MSL-04` | CONFIRMED | ผู้ใช้ทำ stock-affecting business action แล้วระบบสร้าง Stock Movement; business action ที่ยืนยันสำเร็จต้องมี stock effect ที่ครบถ้วนและเกิดเพียงครั้งเดียวตามข้อเท็จจริง พร้อม trace/reconcile กลับ source business record ได้ และไม่เปิด raw ledger movement/current balance ให้แก้ตรง ๆ เป็น normal workflow |
| `MSL-05` | CONFIRMED | Stock Movement normalize ด้วย Base Quantity และรักษา Original Quantity/Unit/Conversion Snapshot พร้อม trace กลับ source business record |
| `MSL-06` | CONFIRMED | หาก implementation cache/materialize Current Stock ค่า cache ต้อง reconcile กลับ authoritative movements ได้; mismatch เป็น integrity problem และห้าม rewrite history เพื่อให้ตาม cache |
| `MSL-07` | CONFIRMED | Business timeline ของ Stock Movement ใช้ Effective Date ส่วน audit timeline รักษา Recorded At/Recorded By; ห้ามใช้เวลาใดแทนอีกเวลา |
| `MSL-08` | CONFIRMED | v1 ไม่มี separate Reserved/Available Stock dimension จาก Decision; Current Stock คือ usable stock ตาม movements จริง และ Outstanding Decisions เป็น context เท่านั้น |
| `MSL-09` | CONFIRMED | Stock Ledger ต่อเนื่องข้ามปีงบประมาณและไม่ reset ยอด; การเปลี่ยนปีงบประมาณไม่สร้าง Stock Movement |
| `MSL-10` | CONFIRMED | Opening Balance ใช้ initialization/migration เท่านั้น ไม่สร้างใหม่ทุกปี; ยอดยกมา/ยอดต้นปีเป็น derived/reporting balance จาก Ledger ก่อน cutoff |
| `MSL-11` | CONFIRMED | Fiscal Year เป็น reporting/business-period context ของ transaction ไม่ใช่ StockMaterial identity และไม่แบ่ง Ledger เป็นคนละก้อนตามปี |
| `MSL-12` | CONFIRMED | Transaction ย้อนหลังจัด business period ตาม Effective Date และยังรักษา Recorded At/By เพื่อ audit; ห้ามปลอม Recorded At ให้ตรง Effective Date |

## MST — Material Stocktake (18 rules)
| Rule ID | Status | Rule |
|---|---|---|
| `MST-01` | CONFIRMED | Stocktake ใช้ Stocktake Round เพื่อรวมการตรวจหลาย StockMaterial ภายใต้ scope/reference point ที่ชัดเจน |
| `MST-02` | CONFIRMED | แต่ละ Stocktake Item เก็บ System Quantity Snapshot/Expected context เทียบกับ Physical Quantity; Discrepancy เป็น derived result |
| `MST-03` | CONFIRMED | การบันทึก Physical Count ไม่แก้ Current Stock อัตโนมัติ; ถ้าตรวจสอบแล้วต้องปรับยอดจริง ให้สร้าง Stock Adjustment ที่ trace กลับ Stocktake |
| `MST-04` | CONFIRMED | `Not Counted` ต้องแยกจาก `Physical Quantity = 0` |
| `MST-05` | CONFIRMED | Recount/re-verification ต้องรักษา revision history ไม่ silent overwrite ผลนับเดิม |
| `MST-06` | CONFIRMED | Stocktake Round ต้องมี scope ที่ชัดเจน และรายการใน scope ห้ามเปลี่ยนแบบเงียบ ๆ หลังเริ่มตรวจ |
| `MST-07` | CONFIRMED | Stocktake ไม่ lock Receiving/Issue ทั้งระบบโดยอัตโนมัติ และไม่ใช้ long-running stock lock เป็น baseline |
| `MST-08` | CONFIRMED | แต่ละ Stocktake Item ต้องรู้ Counted At; Expected Quantity ณ เวลานับต้อง reconcile movements ที่เกิดหลัง snapshot/reference point จนถึง Counted At |
| `MST-09` | CONFIRMED | หากมี Stock Movement ใกล้/หลังช่วงนับ ระบบต้องทำให้ตรวจพบ/เตือน/reconcile ได้ ไม่ silent-ignore movement นั้น |
| `MST-10` | CONFIRMED | หากหน่วยงานต้องการช่วงปิดคลังเพื่อ stocktake ภายหลัง ให้เพิ่มเป็น operational rule จาก requirement จริง ไม่เป็น architecture บังคับใน v1 |
| `MST-11` | CONFIRMED | Stocktake Round สามารถ Close เพื่อเป็น historical checkpoint; ก่อน Close ระบบต้องแสดง Not Counted/Discrepancy/Pending ให้ชัด แต่ยังไม่ hard-code ว่าต้องครบ 100% จนกว่าจะมี workflow requirement จริง |
| `MST-12` | CONFIRMED | หลัง Close ห้าม normal edit/silent overwrite ผลนับ; correction ต้องมี permission, reason, audit trail และรักษาผลเดิม |
| `MST-13` | CONFIRMED | รองรับ explicit Reopen เมื่อมีเหตุผลจริง โดยเก็บ Reopened By/At/Reason และรักษาประวัติ Closed By/At เดิม; ไม่สร้าง multi-level approval workflow จนกว่าจะมี requirement |
| `MST-14` | CONFIRMED | Reopen/Correction ของ Stocktake ห้ามลบหรือ rewrite Stock Adjustment ที่เกิดขึ้นแล้ว; หาก Stock effect เดิมผิดต้องใช้ correction/reversal ที่ trace ได้ตาม MADJ semantics |
| `MST-15` | CONFIRMED | Late/backdated Stock Movement ที่ Recorded หลัง Counted At แต่มี Effective Date กระทบช่วงตรวจ ห้าม rewrite historical Expected Quantity/Physical Count/Discrepancy เดิมแบบเงียบ ๆ |
| `MST-16` | CONFIRMED | Stocktake ต้องรักษา historical expected snapshot + physical count ที่ผู้ตรวจใช้ ณ เวลานั้น; movement ภายหลังที่อาจกระทบต้องสร้าง reconciliation warning/review และห้ามสรุปอัตโนมัติว่า Stocktake หรือ Movement ฝ่ายใดผิด |
| `MST-17` | CONFIRMED | หาก Movement ผิดให้ใช้ Movement Correction; หาก Stocktake ผิดให้ใช้ explicit Recount/Correction/Reopen และ Closed Round ห้าม reopen อัตโนมัติเพราะมี backdated movement |
| `MST-18` | CONFIRMED | Current Stock ยังคง derive จาก authoritative movements ปัจจุบัน ส่วน historical Stocktake snapshot รักษาสิ่งที่ระบบรู้/แสดงและสิ่งที่ตรวจ ณ เวลานั้น; reconstructed ledger as-of ภายหลังอาจต่างจาก historical expected snapshot ได้โดยต้องไม่ทำให้ audit trail หาย |
