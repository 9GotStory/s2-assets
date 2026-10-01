# 09 — Feature Map

Feature Map นี้ใช้เป็น **delivery decomposition** สำหรับ GitHub Spec Kit ไม่ใช่ governance hierarchy

หลักการ:
- Feature ควรมี business boundary ที่อธิบายได้
- dependencies ใช้เป็น baseline sequencing เพื่อจัดลำดับและป้องกัน feature แรกสร้าง abstraction เผื่อ feature หลังมากเกินไป ไม่ใช่ permanent architectural coupling
- หากระหว่าง Specify พบว่าควร merge/split ให้ Product Owner ตัดสินจาก scope จริง ให้ปรับ Blueprint version ตามปกติเมื่อ business boundary เปลี่ยน

## Delivery Order

| # | Feature | Boundary | Delivery Dependencies |
|---:|---|---|---|
| 1 | `application-foundation` | Repository/runtime/security/auth/audit primitives เท่าที่จำเป็นต่อ feature ถัดไป; เป็น technical/bootstrap exception และห้ามกลายเป็น shared-framework catch-all | — |
| 2 | `asset-registry` | Acquisition reference + Asset identity/registration/QR/history start; Asset ต้องลงทะเบียนได้แม้ยังไม่มี Assignment | `application-foundation` |
| 3 | `asset-assignment-movement` | Initial Assignment + Reassignment + Effective/Recorded timeline + correction/history; Permanent Assignment แยกจาก temporary custody และ repair state | `asset-registry` |
| 4 | `loan-return` | Temporary custody ภายใน/ภายนอก + multi-Asset loan + partial return + overdue; Loan action ไม่เปลี่ยน Permanent Assignment | `asset-assignment-movement` |
| 5 | `repair-maintenance` | Repeatable Repair/Maintenance lifecycle + send/return result + optional cost/warranty/context; ไม่สร้าง maintenance/work-order engine | `loan-return`, `asset-assignment-movement` |
| 6 | `annual-asset-verification` | Verification Round + controlled/traceable scope snapshot + verify/reverify + discrepancy/context + close/reopen/correction semantics โดยไม่แก้ Registry อัตโนมัติ | `asset-registry`, `asset-assignment-movement`, `loan-return`, `repair-maintenance` |
| 7 | `asset-retirement` | Record external-process Retirement result + terminal operational state + active Loan/Repair guard + backdated conflict reconciliation + historical access | `loan-return`, `repair-maintenance`, `annual-asset-verification` |
| 8 | `material-catalog-units` | StockMaterial catalog + Brand/Model/Specification + Base/Alternate Units + conversion + inactive/reactivate + duplicate/category/Minimum Stock semantics | `application-foundation` |
| 9 | `material-request-entry` | RequestableMaterial + request-unit semantics + explicit compatibility mapping + requester UX + multi-item Request + cancel-before-Issue behavior; ไม่มี stock effect | `material-catalog-units` |
| 10 | `material-receiving-stock-foundation` | Material Receiving + Opening Balance + one logical office stock + authoritative movements/current stock + receipt-specific correction integrity | `material-catalog-units` |
| 11 | `material-request-decision` | Supply Officer Decision per Requested Item + Allowed Quantity + multiple planned StockMaterial allocations + compatibility/stock context + traceable decision revision; no stock reservation/effect | `material-request-entry`, `material-receiving-stock-foundation` |
| 12 | `material-issue-fulfillment` | Normal Request-linked Issue + current-stock validation/decrement + substitution + multiple Issue Events + fulfillment/Remaining-to-Issue semantics | `material-request-decision`, `material-receiving-stock-foundation` |
| 13 | `material-return-adjustment` | Material Return + usable/unusable return + Issue correction/reversal + general Adjustment/Correction + replacement/re-fulfillment traceability โดยไม่สร้าง damaged warehouse | `material-issue-fulfillment`, `material-receiving-stock-foundation` |
| 14 | `material-stocktake` | Material Stocktake Round + expected snapshot + Counted At + recount/revision + discrepancy + adjustment linkage + close/reopen/backdated reconciliation โดยไม่ auto-adjust | `material-receiving-stock-foundation`, `material-return-adjustment` |

## Feature Briefs

รายละเอียด Blueprint ระดับ feature อยู่ที่ `features/` โดยแต่ละไฟล์กำหนด Purpose, Scope, Actors, workflow, Rule routing, cross-feature responsibilities, invariants, open decisions และ handoff boundary โดย **ไม่ทำหน้าที่แทน Spec Kit `spec.md`**

| # | Feature | Feature Brief |
|---:|---|---|
| 1 | `application-foundation` | `features/01-application-foundation.md` |
| 2 | `asset-registry` | `features/02-asset-registry.md` |
| 3 | `asset-assignment-movement` | `features/03-asset-assignment-movement.md` |
| 4 | `loan-return` | `features/04-loan-return.md` |
| 5 | `repair-maintenance` | `features/05-repair-maintenance.md` |
| 6 | `annual-asset-verification` | `features/06-annual-asset-verification.md` |
| 7 | `asset-retirement` | `features/07-asset-retirement.md` |
| 8 | `material-catalog-units` | `features/08-material-catalog-units.md` |
| 9 | `material-request-entry` | `features/09-material-request-entry.md` |
| 10 | `material-receiving-stock-foundation` | `features/10-material-receiving-stock-foundation.md` |
| 11 | `material-request-decision` | `features/11-material-request-decision.md` |
| 12 | `material-issue-fulfillment` | `features/12-material-issue-fulfillment.md` |
| 13 | `material-return-adjustment` | `features/13-material-return-adjustment.md` |
| 14 | `material-stocktake` | `features/14-material-stocktake.md` |

**Routing principle:** rule เดียวอาจเกี่ยวหลาย feature ตาม business boundary จริง จึงไม่บังคับ “owner เดียว” หาก semantics ต้องแบ่ง responsibility. Feature Brief ระบุระดับ responsibility ให้ชัดว่าเป็น Primary, Shared clause หรือ Read-only reference.

## Recommended Spec Kit slicing

เมื่อเริ่ม feature ให้สร้าง specification จาก boundary ของ feature นั้น แล้วดึงเฉพาะ:

1. actors ที่เกี่ยวข้อง
2. workflows ที่ feature เป็นเจ้าของ
3. Business Rule IDs ที่เกี่ยวข้องจาก `06-business-rules.md`
4. shared domain concepts ที่จำเป็น
5. NFR ที่มีผลจริงกับ feature

อย่า copy Blueprint ทั้งชุดเข้า spec.md และอย่าสร้าง framework กลางล่วงหน้าเพียงเพราะ feature หลังอาจใช้
