# TECHNOLOGY.md — Project Technology Direction
## Office Asset & Consumable Management System

Version: **1.1.0**\
Status: **SELECTED BASELINE**

> Technical direction สำหรับการพัฒนา `s2-assets`. เอกสารนี้ไม่ใช่ Business Authority และไม่เปลี่ยนความหมายของ Blueprint/Business Rules

> **1.1.0 (2026-11-03):** Product Owner decision — ย้าย development runtime ออกจาก `multica-agent` (UID 1001) มาเป็น rootless Podman + user-level systemd Quadlet ของ workspace user (UID 1000) แบบเดียวกับ Songhealth แต่แยก resources กัน และเลิกใช้ Multica/AGY บน host (§9 Development environment / Development orchestration). Application stack และ production direction ไม่เปลี่ยน

---

## 1. Purpose and Authority

เอกสารนี้กำหนด **project-wide technical baseline** เพื่อให้ Product Owner, DEV Executor, Independent Reviewer และ Spec Kit `Plan` เริ่มจาก technology direction เดียวกัน โดยไม่ต้องเลือก stack ใหม่ทุก feature

Authority แยกเป็น:

1. **Business Authority** — Product Owner decision → `BLUEPRINT.md` / Feature Brief / canonical Business Rules
2. **Technical Direction** — `TECHNOLOGY.md`
3. **Feature Delivery Decision** — active `spec.md` / `plan.md` / `tasks.md` / implementation

กติกา:

- Business requirements/invariants มีอำนาจเหนือ technology preference
- `Plan` ต้องเริ่มจาก baseline นี้ ไม่ reselect stack ใหม่โดยไม่มีเหตุผล
- exact minor/patch versions ให้ resolve ตอน Application Foundation/feature Plan และ lock ใน package manager/container image
- รายการที่ระบุ **Deferred to Plan** ให้ Plan ตัดสินตาม environment/use case จริง
- การเปลี่ยน major technical direction เช่น database engine, backend framework, frontend framework หรือ production container runtime ต้องเป็น **explicit technology deviation** พร้อมเหตุผล/ผลกระทบ และให้ Product Owner รับทราบ/อนุมัติก่อน implementation
- การเปลี่ยน technology ไม่ต้อง bump Blueprint version หาก business semantics, feature boundaries และ Business Rules ไม่เปลี่ยน

---

## 2. Architecture Style

### Selected

- **Modular Monolith**
- **TypeScript end-to-end**
- **single repository / pnpm workspace**
- frontend และ backend แยก application boundary แต่พัฒนา/ทดสอบ/version ใน repository เดียว
- module boundaries ตาม business capability/Feature จริง
- synchronous request/transaction flow เป็น default
- PostgreSQL เป็น authoritative structured data store

### Do not introduce by default

- microservices
- distributed event bus
- event sourcing
- generic workflow engine
- Kubernetes
- service mesh
- separate repository per feature/service

เพิ่มได้ภายหลังเฉพาะเมื่อ current requirement แสดงปัญหาที่ baseline นี้แก้ไม่ได้อย่างเหมาะสม

---

## 3. Selected Runtime and Language

| Area | Baseline |
|---|---|
| Runtime | **Node.js 24 LTS** |
| Language | **TypeScript 6.x**, strict mode |
| Module system | **ESM** |
| Package manager | **pnpm** |
| Repository layout | **pnpm workspace / monorepo** |

### Version policy

- เลือก major line ที่รองรับ production และมี security support
- exact minor/patch version ถูก pin/lock ใน implementation
- security/bugfix updates ภายใน major line ไม่ต้องแก้ Blueprint
- major upgrade ต้องตรวจ compatibility/tests และบันทึกเป็น technical change ตามสัดส่วนความเสี่ยง

---

## 4. Frontend

### Selected baseline

| Concern | Technology |
|---|---|
| UI framework | **React 19** |
| Build/dev tooling | **Vite 8** |
| Routing | **React Router 7 — Data mode** |
| Server-state | **TanStack Query 5** |
| Data tables | **TanStack Table** |
| Forms | **React Hook Form** |
| Schema/validation | **Zod 4** |
| Styling | **Tailwind CSS 4** |
| UI components | **shadcn/ui** |
| Icons | **Lucide** |

### Frontend principles

- application เป็น authenticated internal web application; **SPA เป็น baseline**
- ไม่เลือก SSR/RSC/meta-framework เพียงเพราะเป็น trend
- search/filter/pagination เป็น first-class UX
- mobile-friendly โดยเฉพาะ verification/stocktake/QR workflows
- server state อยู่ใน TanStack Query; อย่าเพิ่ม global state library จนมี client-state use case จริง
- frontend validation มีเพื่อ UX แต่ server-side validation/authorization เป็น authoritative
- UI component abstraction สร้างเมื่อมี reuse จริง ไม่สร้าง design-system framework ล่วงหน้า

### Not baseline

- Next.js
- frontend micro-frontends
- Redux/Zustand เป็น default global store
- GraphQL client stack

รายการเหล่านี้ไม่ถูกห้ามถาวร แต่ต้องมี current requirement ที่ justify การเพิ่ม

---

## 5. Backend and API

### Selected baseline

| Concern | Technology |
|---|---|
| HTTP framework | **Fastify 5** |
| API style | **REST JSON** |
| API contract | **OpenAPI** |
| Boundary validation | **Zod / JSON Schema ตาม integration ที่เลือกใน Plan** |
| Logging | **Pino structured logging** |

### Backend principles

- organize modules ตาม business capability ไม่ใช่ generic layer hierarchy
- business invariants enforce ฝั่ง server เสมอ
- transaction boundary อยู่ใกล้ business action ที่ต้อง atomic
- source business record + stock/history effect ต้อง commit/rollback อย่างสอดคล้อง
- operational logs ไม่ใช้แทน business audit/history
- API errors ต้อง deterministic และไม่เปิดเผย sensitive implementation detail
- pagination/filter/sort เป็น explicit contract สำหรับ list/search endpoints

### Not baseline

- NestJS
- GraphQL
- gRPC สำหรับ browser CRUD workflow
- message broker / async workflow engine
- generic repository/service framework ที่ไม่มี use case จริง

---

## 6. Database and Data Access

### Selected baseline

| Concern | Technology |
|---|---|
| Database | **PostgreSQL 18** |
| Driver | **pg** |
| Typed SQL/data access | **Kysely** |
| Migration | **explicit reviewable migrations** |

### Database principles

PostgreSQL เป็นส่วนหนึ่งของ integrity boundary ไม่ใช่เพียง persistence bucket

ใช้ database constraints/transactions เมื่อเหมาะสม เช่น:

- primary/foreign keys
- unique constraints
- not-null constraints
- check constraints
- appropriate `NUMERIC` precision สำหรับ quantity/conversion
- transaction isolation / row locking / optimistic strategy ตาม Plan
- indexes ตาม query/workload จริง

สำหรับ stock-affecting operations ต้องพิสูจน์ว่า concurrent execution ยังรักษา invariants ตาม Blueprint/NFR

### Explicit guidance

- Current Stock ต้อง derive/reconcile จาก authoritative Stock Movements
- ห้ามใช้ direct balance edit เป็น shortcut
- test transaction/concurrency กับ PostgreSQL จริงใน integration tests
- อย่าซ่อน SQL/transaction semantics ที่สำคัญไว้หลัง ORM abstraction ที่ตรวจยาก

### Not baseline

- MySQL/MariaDB
- SQLite เป็น production database
- MongoDB/document database เป็น authoritative store
- Redis เป็น primary/session requirement ตั้งแต่เริ่ม
- Elasticsearch/OpenSearch สำหรับ basic application search

PostgreSQL native indexing/search capabilities ให้ใช้ก่อนจนมี evidence ว่าไม่พอ

---

## 7. Authentication and Authorization

### Selected direction

- authentication mechanism เป็น **Deferred to Application Foundation Plan** เพราะขึ้นกับ deployment identity environment จริง
- หากมี organization Identity Provider ให้ prefer **OIDC**
- หากไม่มี IdP ให้ Plan สามารถเลือก local credential authentication ที่เหมาะสม
- authenticated web session ให้ prefer **server-side session + HttpOnly/Secure/SameSite cookie**
- authorization เป็น server-side capability/permission checks และต้อง fail closed

### Local credential fallback, if selected

- password hashing ใช้ **Argon2id** หรือ current equivalent ที่ Plan ยืนยัน
- session lifecycle/revocation ต้องควบคุมฝั่ง server
- CSRF protection พิจารณาตาม cookie/session architecture จริง

### Not baseline

- JWT ใน `localStorage` เป็น default
- frontend-only authorization
- QR/deep link ที่ bypass permission checks
- enterprise IAM/RBAC engine ที่ไม่มี use case จริง

---

## 8. Files and Evidence Storage

### Initial direction

- structured metadata/reference อยู่ใน PostgreSQL
- binary evidence/document files เก็บใน persistent filesystem หรือ storage ที่ deployment environment รองรับ
- database เก็บ stable reference + metadata ไม่เก็บไฟล์ binary โดย default

### Deferred to Plan

- exact filesystem path/volume strategy
- retention/size limits
- antivirus/content scanning requirement
- object storage

### Not baseline

- MinIO/S3-compatible object storage ตั้งแต่วันแรกโดยไม่มี deployment requirement

---

## 9. Container, Development Runtime, and Deployment

### Selected baseline

| Concern | Technology |
|---|---|
| Image format | **OCI-compatible Containerfile/image** |
| Development container runtime | **Rootless Podman** |
| Production container runtime | **Rootless Podman** |
| Production service management | **systemd + Quadlet** |
| Image registry | **GHCR** |
| Reverse proxy | **Deferred to Plan; Caddy preferred when no infrastructure standard exists** |

Application ต้องไม่เขียนให้ผูกกับ Podman API โดยตรง; OCI image ควรรันกับ compatible runtime ได้

### Development environment

Local development MUST use **Rootless Podman** as the application runtime baseline.

The source repository, Git worktrees and Claude Code CLI remain on the host operating system under the workspace user (UID 1000). Application services and infrastructure dependencies execute in Rootless Podman containers owned by that same user.

Baseline development topology:

```text
Fedora Host — workspace user (UID 1000)
├── Git repository / worktrees
├── Claude Code CLI
│
└── Rootless Podman + user systemd Quadlet (development runtime)
    ├── web
    ├── api
    └── PostgreSQL
```

Development principles:

- ไม่ require PostgreSQL ที่ติดตั้งบน host สำหรับ normal development
- ไม่ require host-installed application Node.js dependencies สำหรับ normal development
- ใช้ bind mount หรือ equivalent development mount เมื่อเหมาะสมสำหรับ source-driven hot reload
- development/test commands ที่พึ่ง application runtime หรือ database state ให้รันใน containers
- ใช้ runtime/database major line เดียวกับ selected project baseline
- แยก development tooling ออกจาก production image stage เมื่อ production ไม่จำเป็นต้องใช้
- container configuration ต้องคง OCI-compatible และห้ามผูก application เข้ากับ Podman API โดยตรง
- persistent development data ใช้ explicit named volumes หรือ equivalent managed storage
- secrets ห้าม commit ลง image, Containerfile, Compose-compatible configuration หรือ repository

### Development orchestration

Persistent development runtime ใช้ **user-level systemd Quadlet units** ของ workspace user (`deploy/dev-quadlet/`) ติดตั้ง/อัปเดต/ตรวจสอบด้วย repository scripts ขนาดเล็ก (`scripts/dev-runtime-*.sh`) ตามสัญญาใน `docs/operations/development-runtime.md`:

- runtime รัน source checkout ที่ promoted commit เดียว และ promote commit ใหม่ผ่าน script ที่ backup ฐานข้อมูลก่อน
- resources ทุกตัว (units, containers, network, volume, podman secrets, loopback ports) ใช้ชื่อเฉพาะ `s2-assets` และต้องไม่ใช้ร่วมกับ runtime ของโปรเจกต์อื่นบน host เดียวกัน
- Podman-compatible Compose configuration (`deploy/podman/compose.yaml` + `scripts/dev.sh`) ยังใช้ได้สำหรับ disposable test stacks ของ Feature 001

ห้ามสร้าง Kubernetes หรือ custom orchestration framework

### Expected production topology

```text
HTTPS
  │
  ▼
Reverse Proxy
  ├── static web
  └── /api → Fastify API
                │
                ▼
           PostgreSQL
```

เริ่มจาก services เท่าที่ต้องใช้จริง เช่น:

- web
- api
- db
- backup/maintenance job เมื่อจำเป็น

### Not baseline

- Kubernetes
- Docker Swarm
- privileged container daemon dependency
- Redis/RabbitMQ/Kafka side services
- observability stack หลาย service ตั้งแต่วันแรก

---

## 10. Testing

### Selected baseline

| Test layer | Technology / approach |
|---|---|
| Unit/domain | **Vitest** |
| API/integration | **Vitest + real PostgreSQL** |
| Browser E2E | **Playwright** |

Test priority ให้ยึด business invariants มากกว่า implementation details

High-value integration/concurrency coverage ได้แก่:

- negative-stock prevention
- concurrent Issue/Receiving/Return behavior
- conversion snapshot/fractional quantity
- partial/multiple Issue
- Opening Balance cutover/no-double-count
- Return/Correction/Adjustment traceability
- stock reconciliation
- stocktake late/concurrent movement
- active loan overlap
- effective-time assignment semantics
- repair/retirement guards

Mock database ไม่เพียงพอสำหรับยืนยัน transaction/concurrency semantics ที่ production ใช้ PostgreSQL

---

## 11. CI/CD and Supply Chain

### Selected baseline

- **GitHub Actions**
- **GHCR** for OCI images
- locked dependencies
- lint
- typecheck
- unit/integration tests
- production build
- critical Playwright tests ตามความเหมาะสม
- dependency/container vulnerability scanning เช่น **Trivy**

Release/deploy automation ให้เพิ่มตาม deployment environment จริงโดยไม่สร้าง orchestration framework แยก

---

## 12. Operations, Logging, Backup

### Baseline

- health endpoint
- readiness check ตาม dependency ที่จำเป็น
- structured application logs → stdout/journald
- correlation/request ID
- data-minimized logs
- PostgreSQL backup
- evidence/file backup
- off-host copy ตาม environment
- periodic restore verification

### Important separation

```text
Operational Log ≠ Business Audit / History
```

Business audit/history ที่จำเป็นต้อง query/trace ตาม domain อยู่ใน structured application data ตาม Blueprint ไม่พึ่ง journald/application logs เป็นหลักฐานแทน

### Deferred to Plan / Operations

- exact RPO/RTO
- retention schedule
- PITR/WAL archiving
- Prometheus/Grafana metrics
- centralized log aggregation
- alert routing

เพิ่มเมื่อ deployment/operations requirement ชัดเจน

---

## 13. Suggested Repository Shape

รูปแบบเริ่มต้นที่ Plan ควรพิจารณา:

```text
s2-assets/
├── apps/
│   ├── web/
│   └── api/
├── packages/
│   ├── db/
│   └── contracts/       # only when real cross-app reuse exists
├── tests/
│   └── e2e/
├── deploy/
│   └── podman/
├── docs/
├── features/
├── specs/
└── pnpm-workspace.yaml
```

นี่เป็น direction ไม่ใช่คำสั่งให้สร้างทุก directory ตั้งแต่ Task แรก

อย่าสร้าง `common`, `core`, `shared-services`, `event-bus` หรือ generic abstraction package ล่วงหน้าเพียงเพราะอาจใช้ในอนาคต

---

## 14. Deferred Decisions for Application Foundation Plan

Feature `01-application-foundation` Plan ต้องยืนยันอย่างน้อย:

- exact supported Node.js/TypeScript/package versions
- exact Fastify/Zod/OpenAPI integration
- exact Kysely/migration tooling
- authentication provider/mechanism
- minimum capability/permission model
- reverse proxy choice ตาม hosting
- session storage/schema
- secrets/configuration strategy
- production filesystem/volume layout
- development Containerfile/stage strategy
- Rootless Podman local development topology
- source bind-mount / hot-reload strategy
- development PostgreSQL volume lifecycle
- development/test command entrypoints
- container UID/GID and filesystem permission strategy
- backup/restore implementation
- health/readiness contract
- CI checks และ image build/publish strategy
- deployment topology/ports/network boundaries

Plan ต้องเลือก **simplest sufficient implementation** ภายใน baseline นี้

---

## 15. Technology Deviation Rule

เมื่อ requirement หรือ environment ทำให้ baseline นี้ใช้ไม่ได้อย่างเหมาะสม:

1. ระบุ technology baseline ปัจจุบัน
2. ระบุ concrete constraint/problem
3. ระบุ proposed deviation และ alternatives ที่พิจารณา
4. อธิบายผลต่อ security, data integrity, operations, tests และ maintainability
5. ระบุว่า business semantics/Blueprint ได้รับผลหรือไม่
6. ขอ Product Owner decision เมื่อเป็น material change
7. update `TECHNOLOGY.md` หาก baseline project-wide เปลี่ยนจริง

ห้าม agent เปลี่ยน stack เพราะ personal preference, familiarity หรือ speculative future scale

---

## 16. Explicit Non-Baseline Technology

จนกว่าจะมี requirement จริง สิ่งต่อไปนี้ไม่ใช่ baseline:

- microservices
- Kubernetes
- event sourcing
- Kafka / RabbitMQ
- Redis
- Elasticsearch / OpenSearch
- MinIO
- GraphQL
- generic BPM/workflow engine
- generic enterprise service/repository framework
- separate observability platform ต่อระบบโดยไม่มี operational need

หลักคือ:

> **Use the simplest technology set that preserves the Blueprint's security, traceability, transaction and data-integrity requirements.**
