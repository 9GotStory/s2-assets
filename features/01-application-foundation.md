# 01 — Application Foundation

Feature key: `application-foundation`

## Purpose

วางฐาน application/runtime/security/auth/audit ที่ “จำเป็นต่อ feature ถัดไปจริง” โดยไม่สร้าง shared framework เผื่ออนาคต

## In Scope

- Repository/application structure ขั้นต่ำที่รองรับการพัฒนาเป็น feature
- Authentication และ authorization primitives
- Configuration/secrets baseline
- Error/transaction boundary baseline
- Audit/history primitives ที่ domain features เรียกใช้ได้เท่าที่จำเป็น
- Test foundation และ runtime/deployment implementation details ภายใน selected baseline จาก `../TECHNOLOGY.md` หรือ Technology Deviation ที่ Product Owner อนุมัติแล้ว

## Out of Scope

- Generic enterprise platform/framework
- Domain workflow ของ Asset หรือ Material
- Permission matrix ขนาดใหญ่ที่ยังไม่มี use case
- Event bus, workflow engine, evidence/governance platform

## Actors

- Administrator
- System Maintainer
- ผู้ใช้ทุก role ในฐานะผู้ถูก authenticate/authorize
- Unauthorized caller (negative actor / access boundary)

## Owned Workflow

1. Sign in / establish authenticated session
2. Authorize server-side business capability
3. Record minimum operational/audit metadata เมื่อ domain action เรียกใช้
4. Fail closed เมื่อ identity/permission/configuration ไม่ถูกต้อง

## Domain Concepts

- `User/Identity`
- `Role/Capability`
- `Configuration`
- `Audit metadata`
- `Transaction boundary`

## Business Rule Routing

Canonical wording อยู่ที่ `../docs/06-business-rules.md`; Feature Brief ไม่ทำสำเนาข้อความ rule เพื่อหลีกเลี่ยง duplicated truth.

### Primary — Full responsibility

`SYS-01–SYS-04`

### Primary — With shared integration

—

### Shared clause only

—

### Read-only / constraint reference

—

## Cross-Feature Responsibilities

- ไม่มี cross-feature business ownership; ให้บริการเฉพาะ primitives ที่ feature จริงต้องใช้


## Key Invariants

- Foundation ต้องเป็น technical/bootstrap exception ไม่ใช่ catch-all
- Authorization ต้อง fail closed และ QR/deep link ห้าม bypass permission
- ห้าม fabricate business data เพื่อให้ระบบผ่าน validation
- Technical choices ให้ Plan ยืนยันรายละเอียดจาก selected baseline ใน `../TECHNOLOGY.md`; ห้าม reselect project-wide stack ใหม่โดยไม่มี Technology Deviation ที่ Product Owner อนุมัติ

## UX Expectations

- Authentication/authorization error ต้องสื่อความหมายและไม่เปิดเผยข้อมูลเกินจำเป็น
- ไม่เพิ่มขั้นตอนแก่ผู้ใช้เพียงเพื่อรองรับ framework ภายใน

## Audit / Evidence

- รองรับ Recorded At/By และ reason/context ที่ feature จริงต้องใช้
- ไม่สร้าง custom governance/evidence framework ที่ไม่มี business use case

## Relevant NFR

- Security
- Reliability & Operations
- Maintainability
- Data Integrity

## Delivery Dependencies

- —

## Open Decisions for Specify / Clarify

- Feature-level permission/capability matrix ขั้นต่ำ
- Authentication/access mechanism ให้ยืนยันตาม environment จริงใน Plan

## Plan Decisions / Risks

ใช้ `../TECHNOLOGY.md` เป็น selected technical baseline; Plan ยืนยัน exact implementation details/Deferred decisions ที่เกี่ยวข้อง หรือเสนอ Technology Deviation เมื่อมี concrete constraint จริง

- repository/application structure และ runtime/deployment details ที่เหมาะกับข้อจำกัดจริงภายใน selected baseline
- authentication/authorization mechanism ขั้นต่ำ
- configuration/secrets/error handling/test harness
- minimal audit/identity primitives ที่มี current use case
- หลีกเลี่ยง microservices, event sourcing, workflow/document/reporting engines


## Done Outcome

Repository พร้อมให้ feature แรกใช้งาน authentication, authorization, configuration, transaction/error handling และ test baseline ได้โดยไม่ต้องสร้าง infrastructure เกิน requirement.

## Handoff Boundary

Feature Brief นี้เป็น Blueprint context ไม่ใช่ `spec.md`. เมื่อเริ่มพัฒนาจริง ให้ Spec Kit สร้าง user scenarios, acceptance criteria, technical plan และ tasks จากข้อมูลนี้ร่วมกับ Blueprint canonical documents และใช้ `../TECHNOLOGY.md` เป็น project-wide technical baseline สำหรับ Plan.
