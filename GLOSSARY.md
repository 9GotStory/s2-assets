# Office Asset & Consumable Management

The shared language of s2-assets: physical Assets, their registration and lifecycle, and
consumable Materials. Canonical rules live in `docs/06-business-rules.md`; this file defines
words only. Thai in parentheses is the term's label in the user interface.

## Assignment

**Permanent Assignment** (สถานที่ หน่วยงาน และผู้รับผิดชอบ):
Where an Asset belongs on a standing basis, in three independent dimensions: Location,
OrganizationUnit and Responsible Person, any of which may be empty. It is separate from
temporary custody (Loan) and from Repair Records.
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
Permanent Assignment and from Repair Records.

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
How an Asset was found when lent, at its Loan Return or when Found in a Verification Round: ปกติ or
ชำรุด. It belongs to that moment, not to the Asset.

**Loan Correction** (แก้ไขรายการที่บันทึกผิด):
A traceable fix to a Loan fact that was wrong as recorded, up to voiding a fact that never happened
(ยกเลิกรายการ). It is not a business event. A voided fact stays shown as ยกเลิกแล้ว, struck through,
and counts in no status; a voided Loan has no status at all.

**Loan Conflict** (ช่วงยืมทับกัน):
Two LoanItems of one Asset whose periods overlap, usually because a backdated Loan was recorded
later. A Loan Return and a new Loan on the same day are not one. The Loan list finds them with
"มี conflict ค้างตรวจ", and one goes away once a Loan Correction removes the overlap.
_Avoid_: double loan

## Repair

**Repair Record** (รายการซ่อม/บำรุงรักษา):
A record that one Asset was taken out of use to be repaired (ซ่อม) or maintained (บำรุงรักษา),
from its Repair Start to its Repair Outcome. It never changes a Permanent Assignment.
_Avoid_: work order, repair ticket

**Under Repair** (อยู่ระหว่างซ่อม / อยู่ระหว่างบำรุงรักษา):
An Asset with a Repair Record that has no Repair Outcome yet, of either kind; what the business
rules call having an Active Repair.
_Avoid_: active repair, under maintenance

**Repair Start** (ส่งซ่อม):
The fact that an Asset went for repair or maintenance.

**Start Date** (วันที่ส่งซ่อม):
The Thai calendar day a Repair Record began.

**Repair Outcome** (ผลการซ่อม):
How a Repair Record ended: ใช้งานได้, or ซ่อมไม่ได้ (ใช้งานไม่ได้ for maintenance). ซ่อมไม่ได้ does not
retire the Asset.
_Avoid_: repair return, รับคืนจากซ่อม

**Outcome Date** (วันที่ได้ผล):
The Thai calendar day a Repair Record ended.

**Repairer** (ผู้ซ่อม):
Who did the work: an internal technician, or an external shop or technician known by name.
_Avoid_: repair vendor

**Repair Source** (ที่มา):
The Loan Return recorded ชำรุด, or the Asset Verification Found ชำรุด, that led to a Repair Record,
when there was one.

**Repair Correction** (แก้ไขรายการที่บันทึกผิด):
A traceable fix to a Repair fact that was wrong as recorded, up to voiding a fact that never
happened (ยกเลิกรายการ). It is not a business event.

**Repair Conflict** (ช่วงซ่อมทับกัน):
A Repair Record whose period overlaps another Repair Record or a LoanItem of the same Asset,
usually because a backdated fact was recorded later. Ending and starting on the same day is not
one.

**Next Recommended Maintenance Date** (วันที่แนะนำบำรุงรักษาครั้งถัดไป):
A date noted with a Repair Outcome. Nothing is scheduled from it.

## Verification

**Verification Round** (รอบตรวจ):
One check of a fixed set of Assets, named and labelled with a Thai fiscal year (ปีงบประมาณ). It is
open (เปิดอยู่) from its start date (วันที่เริ่มตรวจ) until it is closed. A fiscal year may have several
Rounds, one open at a time. A
Round opened by mistake and holding no result may be voided (ยกเลิกรอบ); it stays shown as ยกเลิกแล้ว.
Asset Stocktake is not a term: a Stocktake counts Materials.
_Avoid_: asset stocktake, asset audit

**Scope Snapshot** (รายการในรอบ):
The Assets a Verification Round covers, each with the identity and Current Assignment the register
showed when it joined the Round. Nothing recorded later changes it.

**Late Addition** (เพิ่มเข้ารอบภายหลัง):
An Asset added to an open Verification Round after it started, noting who added it, when and why.
A Round never adds an Asset by itself.

**Asset Verification** (ผลตรวจ):
The current result for one Asset in one Verification Round, Found or Not Found, with its earlier
Verification Revisions. Opening an Asset from its QR label is not one.
_Avoid_: scan result

**Found** (พบ):
An Asset Verification saying the Asset was seen, with its Condition and, when given, its Observed
Location.

**Not Found** (ไม่พบในการตรวจ):
An Asset Verification saying the Asset was not seen in this Round. It does not say the Asset is
lost or Retired.
_Avoid_: สูญหาย

**Not Yet Verified** (ยังไม่ได้ตรวจ):
An Asset in a Round's Scope Snapshot with no Asset Verification. It stays so when the Round closes;
it is not Not Found.

**Verification Date** (วันที่ตรวจ):
The Thai calendar day an Asset was checked, which may be earlier than its Recorded At.

**Re-verification** (ตรวจซ้ำ):
Checking an Asset again in the same Round on purpose, which makes a new current result and keeps
the earlier one.

**Verification Revision**:
One recorded result of an Asset Verification; the latest is the current result.

**Verification Correction** (แก้ไขรายการที่บันทึกผิด):
A traceable fix to a Verification Revision that was wrong as recorded, such as a result recorded for
the wrong Asset, by voiding it (ยกเลิกรายการ) in an open Round. It is not a Re-verification. A voided
revision stays shown as ยกเลิกแล้ว, struck through, and the latest revision not voided becomes the
current result again, or the Asset is Not Yet Verified.

**Observed Location** (สถานที่ที่พบ):
The Location where a Found Asset was seen. Left out, it means the Location matched the register.

**Discrepancy** (ข้อแตกต่าง):
A difference an Asset Verification notes between the Asset and the register: Location ไม่ตรงทะเบียน,
ชำรุด, ป้าย/QR หายหรือชำรุด, or ข้อมูลไม่ตรงทะเบียน. Location ไม่ตรงทะเบียน compares the Observed Location
with the Permanent Assignment in effect on the Verification Date. One result may note several. A
Discrepancy changes nothing in the register; a Reassignment or Repair Record may follow from it.

**Closed Round** (ปิดรอบแล้ว):
A Verification Round no longer taking results, kept as a historical record until a Reopen. Not a
Closed Loan.

**Reopen** (เปิดรอบอีกครั้ง):
Opening a Closed Round again, with a reason, so its results can be changed and it can be closed
again.

## Roles

**Asset Custodian** (ผู้ดูแลทะเบียนครุภัณฑ์):
The role that keeps the Asset register, including its assignment work.
_Avoid_: Responsible Person, ผู้รับผิดชอบ

**Verification Staff** (ผู้ตรวจ):
The role that checks Assets in an open Verification Round and records Asset Verifications.
