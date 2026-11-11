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

## Loan

**Loan** (การยืม):
A record that one Borrower took one or more Assets for a time and is expected to bring them back.
It never changes a Permanent Assignment.

**LoanItem** (รายการยืม):
One Asset within a Loan, with its own Due Date, Condition and ending. As a page title, "รายการยืม"
means the list of Loans.

**Temporary Custody** (การยืมชั่วคราว):
Holding an Asset for a time with its return expected, which a Loan records. It is separate from
Permanent Assignment and from repair state.

**Outstanding** (ยังไม่คืน):
A LoanItem that has neither a Loan Return nor a Not Returned ending.

**On Loan** (กำลังถูกยืม):
An Asset with an Outstanding LoanItem; what the business rules call having an Active Loan. The
other items of the same Loan do not affect it.
_Avoid_: active loan

**Loan Date** (วันที่ยืม):
The Thai calendar day a Loan began.

**Due Date** (กำหนดคืน):
The Thai calendar day by which a LoanItem is expected back.

**Overdue** (เกินกำหนด):
An Outstanding LoanItem whose Due Date has passed; a Loan with such an item is Overdue too.

**Due Date Extension** (เลื่อนกำหนดคืน):
A business event that moves the Due Date of Outstanding LoanItems later. It is not a Loan
Correction.

**Loan Return** (คืน):
The fact that an Asset came back from a Loan. Always say Loan Return: a Material Return is a
different thing.

**Return Date** (วันที่คืน):
The Thai calendar day an Asset came back from a Loan.

**Not Returned** (ปิดโดยไม่ได้รับคืน):
The ending of a LoanItem whose Asset did not come back. It is not a Loan Return, and it does not
say the Asset is lost or Retired.

**Closed** (ปิดแล้ว):
A Loan with no Outstanding LoanItem and at least one Not Returned item, shown as "ปิดแล้ว (ไม่ได้รับคืน
n ชิ้น)". A Loan whose every item has a Loan Return is คืนครบ, not Closed.

**Borrower** (ผู้ยืม):
Who holds the Assets of a Loan: an Internal Borrower or an External Borrower.

**Internal Borrower** (ผู้ยืมภายใน):
A staff member chosen from the Person Reference List.

**External Borrower** (ผู้ยืมภายนอก):
Someone outside the office, known by a contact name and, when given, an organization name and a
phone number.

**Authorizer** (ผู้อนุญาต):
The staff member who allowed a Loan, noted for the record. No approval step depends on it.
_Avoid_: approver

**Condition** (สภาพ):
How an Asset was found when lent or at its Loan Return: ปกติ or ชำรุด. It belongs to that moment,
not to the Asset.

**Loan Correction** (แก้ไขรายการที่บันทึกผิด):
A traceable fix to a Loan fact that was wrong as recorded, up to voiding a fact that never happened
(ยกเลิกรายการ). It is not a business event. A voided fact stays shown as ยกเลิกแล้ว, struck through,
and counts in no status; a voided Loan has no status at all.

**Loan Conflict** (ช่วงยืมทับกัน):
Two LoanItems of one Asset whose periods overlap, usually because a backdated Loan was recorded
later. A Loan Return and a new Loan on the same day are not one. The Loan list finds them with
"มี conflict ค้างตรวจ", and one goes away once a Loan Correction removes the overlap.
_Avoid_: double loan

## Roles

**Asset Custodian** (ผู้ดูแลทะเบียนครุภัณฑ์):
The role that keeps the Asset register, including its assignment work.
_Avoid_: Responsible Person, ผู้รับผิดชอบ
