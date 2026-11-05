# Office Asset & Consumable Management

The shared language of s2-assets: physical Assets, their registration and lifecycle, and
consumable Materials. Canonical rules live in `docs/06-business-rules.md`; this file defines
words only. Thai in parentheses is the term's label in the user interface.

## Assignment

**Permanent Assignment** (สถานที่ หน่วยงาน และผู้รับผิดชอบ):
Where an Asset belongs on a standing basis, in three independent dimensions: Location,
OrganizationUnit and Responsible Person, any of which may be empty. It is separate from
temporary custody (Loan) and from repair state.
_Avoid_: reference context, custody, ownership

**Current Assignment**:
The Permanent Assignment in effect today, derived from the latest effective assignment facts.
_Avoid_: current reference context

**Initial Assignment** (กำหนดครั้งแรก):
The assignment fact that first gave an Asset its Permanent Assignment, as recorded.
_Avoid_: registration context

**Reassignment** (ย้าย / เปลี่ยนผู้รับผิดชอบ):
A business event that changes one or more dimensions of an Asset's Permanent Assignment from an
Effective Date.
_Avoid_: Movement, Transfer, โอน, โอนย้าย

**Bulk Reassignment** (ย้ายหลายรายการ):
One action that records the same Reassignment for several Assets, each Asset getting its own
event with its own prior values.

**Assignment Correction** (แก้ไขรายการที่บันทึกผิด):
A traceable fix to an assignment fact that was wrong as recorded, up to voiding a fact that never
happened (ยกเลิกรายการ). It is not a business event.
_Avoid_: edit, delete, Reassignment (for fixing a mistake)

**Assignment Conflict**:
A recorded assignment fact whose prior values no longer match the values just before it in
Effective Date order, usually because a backdated fact was recorded later.
_Avoid_: error, invalid event

**Effective Date** (วันที่มีผล):
The business date, a Thai calendar day with no time, from which an assignment fact holds.
_Avoid_: move date, effective time

**Recorded At** (วันที่บันทึก):
The moment the system recorded a fact.
_Avoid_: created at, entry date

## Assignment dimensions

**Location** (สถานที่):
A place where an Asset can be, chosen from the Location Reference List.

**OrganizationUnit** (หน่วยงาน):
An office unit an Asset belongs to, chosen from the OrganizationUnit Reference List.

**Responsible Person** (ผู้รับผิดชอบ):
A staff member answerable for an Asset, chosen from the Person Reference List. A person, not a
user account.
_Avoid_: owner, user, ผู้ใช้งาน, custodian

**Reference List** (ข้อมูลอ้างอิง):
An Administrator-managed flat list of Locations, OrganizationUnits or Persons.
_Avoid_: master data

**Legacy text**:
A dimension value copied from old records that matches no Reference List entry, kept as
recorded.

## Roles

**Asset Custodian** (ผู้ดูแลทะเบียนครุภัณฑ์):
The role that keeps the Asset register, including its assignment work.
_Avoid_: Responsible Person, ผู้รับผิดชอบ
