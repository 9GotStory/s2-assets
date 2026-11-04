# Office Asset & Consumable Management System

> Canonical Blueprint baseline สำหรับพัฒนาระบบครุภัณฑ์สำนักงานและวัสดุสิ้นเปลืองด้วย GitHub Spec Kit, AGY/Antigravity และ Multica

| Baseline | Value |
|---|---|
| Blueprint | **v1.0.2 — FROZEN** |
| Workflow | **Spec Kit + Human-gated independent delivery** |
| Technology Direction | **`TECHNOLOGY.md` v1.0.1 — SELECTED BASELINE** |
| Business Rules | **252 canonical rules** |
| Delivery decomposition | **14 Feature Briefs** |
| Spec Kit | **1.1.1 / AGY integration** |

หลักการของโครงการ:

> **Simple — Structured — Sustainable**

Repository นี้เป็น ready-to-develop business/system baseline ไม่ใช่ ERP / Procurement / Accounting replacement

---

## 1. Authority and source of truth

### Business Authority

1. Explicit current **Product Owner decision**
2. `BLUEPRINT.md` — Blueprint v1.0.2 FROZEN
3. active Feature Brief ใน `features/`
4. canonical rules ใน `docs/06-business-rules.md`

Spec Kit artifacts refine delivery details แต่ห้าม silent-redefine business meaning ที่อยู่ใน authority สูงกว่า

### Technical Direction

`TECHNOLOGY.md` v1.0.1 เป็น project-wide selected technical baseline

- Plan ต้องเริ่มจาก baseline นี้
- exact minor/patch versions และ Deferred decisions ให้ Plan resolve ตาม environment จริง
- material technology deviation ต้อง explicit พร้อมเหตุผล/ผลกระทบและ Product Owner decision ก่อน implementation
- local application development runtime ใช้ **Rootless Podman**
- Git, Git worktrees, Spec Kit, Multica และ AGY agents อยู่บน host

### Project / Delivery Authority

หลัง initialize Spec Kit:

- Constitution — project-wide engineering principles
- `spec.md` / clarifications — feature behavior และ acceptance
- `plan.md` — implementation strategy
- `tasks.md` — executable delivery decomposition
- implementation + tests — delivered behavior

Multica Issue/comments/run history เป็น coordination evidence ไม่ใช่ requirement source of truth ใหม่
Agent assignment, delegation, mentions และ reviewer routing เป็น runtime coordination และไม่ใช่ repository governance

---

## 2. Blueprint and feature structure

`docs/` เป็น canonical cross-feature domain layer และ `features/` เป็น bounded delivery slicing layer

- 252 canonical Business Rules อยู่ใน `docs/06-business-rules.md`
- 14 features และ dependencies อยู่ใน `docs/09-feature-map.md`
- Feature Brief route กลับไปหา canonical Rule IDs แทนการ copy rule wording
- Feature 01 คือ `application-foundation`

---

## 3. Runtime and delivery model

### Before Human Gate

ใช้ GitHub Spec Kit ผ่าน AGY integration:

```text
Constitution
→ Specify
→ Clarify (when needed)
→ Plan
→ Checklist (when useful)
→ Tasks
→ Analyze
→ Human Gate
```

### After Human Gate

การ implementation หลัง Human Gate ต้องรักษาหลัก:

```text
Authorized bounded implementation
→ independent review
→ Human Product Owner acceptance
```

กติกาหลัก:

- implementation author ห้าม approve งานของตนเอง
- independent review ต้องตรวจ repository evidence จริง
- corrective revision ต้องอยู่ใน scope เดิม
- Human Product Owner เป็น final acceptance
- การเลือก agent, delegation, mentions, retries และ routing กำหนดใน Multica/runtime configuration ไม่ hardcode ใน repository

---

## 4. Spec Kit integration

Repository นี้ใช้ Spec Kit **1.1.1** และ integration **`agy`**

Expected project infrastructure:

```text
.specify/
.agents/skills/
specs/
```

Initialize existing repository:

```bash
specify init \
  --here \
  --force \
  --non-interactive \
  --integration agy \
  --script sh
```

ไม่ติดตั้ง Claude/Codex integration เป็น default workflow

---

## 5. Rootless Podman development baseline

Application runtime และ infrastructure dependencies สำหรับ normal development ต้องรันด้วย Rootless Podman ตาม `TECHNOLOGY.md`

```text
Fedora Host
├── Git / worktrees
├── GitHub Spec Kit
├── Multica
├── AGY agents
│
└── Rootless Podman
    ├── web
    ├── api
    └── PostgreSQL
```

Quadlet เป็น production service-management baseline ไม่ใช่ requirement สำหรับ day-to-day development

---

## 6. Delivery order

Feature sequencing canonical อยู่ที่ `docs/09-feature-map.md`

เริ่มจาก:

1. `application-foundation`
2. `asset-registry`
3. `asset-assignment-movement`
4. `loan-return`
5. `repair-maintenance`
6. `annual-asset-verification`
7. `asset-retirement`
8. `material-catalog-units`
9. `material-request-entry`
10. `material-receiving-stock-foundation`
11. `material-request-decision`
12. `material-issue-fulfillment`
13. `material-return-adjustment`
14. `material-stocktake`

หนึ่ง feature ทำทีละช่วงตาม Spec Kit; ห้ามใช้ feature แรกสร้าง framework เผื่อทุก feature หลัง

---

## 7. Reading order

### Product Owner / Spec Kit authoring

1. `README.md`
2. `BLUEPRINT.md`
3. `TECHNOLOGY.md`
4. `docs/09-feature-map.md`
5. active Feature Brief
6. relevant canonical docs/rules
7. active Spec Kit artifacts

### Implementation / review

1. `AGENTS.md`
2. `CLAUDE.md` เพิ่มเติมสำหรับ implementation executor เมื่อ applicable
3. relevant Business Authority / Technology Direction
4. exact active Spec Kit artifacts
5. exact diff/tests/evidence for the authorized scope

ใช้ progressive disclosure; ห้าม copy Blueprint ทั้งชุดเข้า feature spec โดยอัตโนมัติ

---

## 8. Repository governance files

| File | Role |
|---|---|
| `BLUEPRINT.md` | frozen business/system baseline |
| `TECHNOLOGY.md` | selected technical baseline |
| `docs/` | canonical cross-feature domain documentation |
| `features/` | bounded delivery context + rule routing |
| `.specify/memory/constitution.md` | project engineering constitution |
| `AGENTS.md` | shared repository authority and engineering contract |
| `CLAUDE.md` | implementation executor contract |

Repository text/source artifacts on the active canonical branch are source of truth; generated packages are not a second source of truth.

---

## 9. Anti-overengineering boundary

Do not add without a current requirement:

- microservices / Kubernetes / service mesh
- event sourcing / generic event bus
- generic workflow/BPM engine
- generic shared-services framework
- extra planner/tester/architect agents
- custom review ledger or second state database
- automatic whole-phase implementation without bounded authorization
- one implementation author approving their own work

---

## 10. Current start point

After Spec Kit bootstrap and Constitution are accepted:

```text
Feature 001 — application-foundation
Specify
→ Clarify
→ Plan
→ Tasks
→ Analyze
→ Human Gate
→ bounded implementation
→ independent review
→ Human acceptance
```
