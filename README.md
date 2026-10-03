# Office Asset & Consumable Management System

> Canonical Blueprint baseline สำหรับพัฒนาระบบครุภัณฑ์สำนักงานและวัสดุสิ้นเปลืองด้วย GitHub Spec Kit, Claude DEV, Codex Independent Review และ Multica coordination

| Baseline | Value |
|---|---|
| Blueprint | **v1.0.2 — FROZEN** |
| Workflow | **v1.2.0** |
| Master Prompt | **v3.1** |
| Business Rules | **252 canonical rules** |
| Delivery decomposition | **14 Feature Briefs** |
| Blueprint alignment | **`docs/` ↔ `features/` aligned** |
| Spec Kit scaffold | **Generated during repository initialization; intentionally not part of this baseline package** |
| Ready package | `office-asset-management-ready-v1.2.0.zip` |

หลักการของโครงการ:

> **Simple — Structured — Sustainable**

Repository นี้เป็น **ready-to-develop business/system baseline** ไม่ใช่ application implementation ที่เสร็จแล้ว และไม่ใช่ ERP / Procurement / Accounting replacement

---

## 1. What this repository contains

Repository นี้เก็บสิ่งที่ต้องนิ่งก่อนเริ่ม Spec-Driven Development:

- business scope / non-goals
- domain semantics
- actors และ permission principles
- core workflows
- conceptual domain model
- canonical Business Rules 252 ข้อ
- audit/evidence principles
- non-functional requirements
- delivery decomposition 14 features
- Feature Briefs สำหรับ handoff เข้า Spec Kit
- DEV / Reviewer / coordination workflow contracts

Application code, database schema, API shape, deployment topology และ technical implementation details **ยังไม่ freeze ใน Blueprint** และให้ตัดสินใน Spec Kit `Plan` ตาม context จริง

---

## 2. Authority and source of truth

### Business Authority

ลำดับอำนาจในการตีความ business meaning:

1. Explicit current **Product Owner decision**
2. `BLUEPRINT.md` — Blueprint v1.0.2 FROZEN
3. Feature Brief ที่กำลังพัฒนาใน `features/`
4. Canonical rules ใน `docs/06-business-rules.md`

Feature Brief และ Spec Kit artifacts อาจ **refine delivery details** แต่ห้าม silent-redefine business meaning ที่อยู่ใน authority ระดับสูงกว่า

### Delivery Authority

หลัง initialize Spec Kit:

- Constitution — project-wide engineering principles
- `spec.md` / clarifications — feature behavior และ acceptance
- `plan.md` — technical implementation strategy
- `tasks.md` — executable delivery decomposition
- implementation + tests — delivered behavior

### Coordination Evidence

Multica Issue/comments/run history ใช้สำหรับ coordination และ trace การทำงาน แต่ **ไม่ใช่ requirement source of truth ใหม่**

---

## 3. How `docs/` and `features/` relate

สอง directory นี้เชื่อมโยงกัน แต่มีหน้าที่ต่างกัน

### `docs/` — Canonical Blueprint / Domain Layer

`docs/` อธิบายความจริงของระบบแบบ cross-feature:

| File | Responsibility |
|---|---|
| `01-scope-and-goals.md` | scope, goals, explicit non-goals |
| `02-actors-and-permissions.md` | actors และ permission principles |
| `03-system-modules.md` | business capabilities |
| `04-core-workflows.md` | core end-to-end workflows |
| `05-domain-model.md` | conceptual domain model |
| `06-business-rules.md` | **252 canonical Business Rules** |
| `07-audit-and-evidence.md` | history, correction, evidence |
| `08-non-functional-requirements.md` | security, integrity, quality, operations |
| `09-feature-map.md` | 14 features + delivery dependencies |
| `10-roadmap-and-out-of-scope.md` | sequencing และ future/non-baseline scope |

### `features/` — Delivery Slicing Layer

`features/` แบ่ง Blueprint ออกเป็น 14 bounded delivery slices สำหรับ Spec Kit

แต่ละ Feature Brief ระบุ:

- Purpose / In Scope / Out of Scope
- Actors
- Owned Workflow
- Domain Concepts
- Business Rule Routing
- Cross-Feature Responsibilities
- Key Invariants
- Relevant NFR
- Delivery Dependencies
- Open Decisions / Clarification Candidates
- Handoff Boundary

**Feature Brief ไม่ทำสำเนา canonical rule wording** แต่ route ด้วย Rule ID กลับไปที่ `docs/06-business-rules.md`

ปัจจุบัน Rule routing ครอบคลุม **252/252 canonical rules** และ dependency ของ Feature Brief สอดคล้องกับ `docs/09-feature-map.md`

---

## 4. Repository structure before Spec Kit initialization

```text
s2-assets/
├── README.md
├── BLUEPRINT.md
├── CLAUDE.md
├── AGENTS.md
├── MASTER-PROMPT.md
├── REVIEWER.md
├── SHORT-PROMPTS.md
├── MULTICA.md
├── docs/
│   ├── 01-scope-and-goals.md
│   ├── 02-actors-and-permissions.md
│   ├── 03-system-modules.md
│   ├── 04-core-workflows.md
│   ├── 05-domain-model.md
│   ├── 06-business-rules.md
│   ├── 07-audit-and-evidence.md
│   ├── 08-non-functional-requirements.md
│   ├── 09-feature-map.md
│   └── 10-roadmap-and-out-of-scope.md
├── features/
│   ├── 01-application-foundation.md
│   ├── 02-asset-registry.md
│   ├── 03-asset-assignment-movement.md
│   ├── 04-loan-return.md
│   ├── 05-repair-maintenance.md
│   ├── 06-annual-asset-verification.md
│   ├── 07-asset-retirement.md
│   ├── 08-material-catalog-units.md
│   ├── 09-material-request-entry.md
│   ├── 10-material-receiving-stock-foundation.md
│   ├── 11-material-request-decision.md
│   ├── 12-material-issue-fulfillment.md
│   ├── 13-material-return-adjustment.md
│   └── 14-material-stocktake.md
└── office-asset-management-ready-v1.2.0.zip
```

ก่อน initialize Spec Kit จะยังไม่มี:

```text
.specify/
.claude/skills/
.agents/skills/
specs/
```

directory เหล่านี้ต้องให้ Spec Kit CLI เป็นผู้ scaffold/manage ไม่สร้างด้วยมือจาก Blueprint package

---

## 5. Recommended reading order

### Product Owner / human reviewer

1. `README.md`
2. `BLUEPRINT.md`
3. `docs/09-feature-map.md`
4. Feature Brief ที่เกี่ยวข้อง
5. canonical docs/rules ที่ feature นั้น route ถึง

### Claude DEV

1. `CLAUDE.md`
2. `MASTER-PROMPT.md`
3. `BLUEPRINT.md`
4. `docs/09-feature-map.md`
5. active Feature Brief
6. relevant canonical docs/rules
7. active Spec Kit artifacts

### Codex Independent Reviewer

1. `AGENTS.md`
2. `REVIEWER.md`
3. relevant authority / Spec Kit artifacts
4. exact reviewed diff/code/tests/evidence

หลักคือ **progressive disclosure** — อ่านเฉพาะ context ที่จำเป็น ไม่โหลด/copy Blueprint ทั้งชุดเข้า feature spec โดยอัตโนมัติ

---

## 6. Working model

```text
Product Owner
    │
    ├── authorizes business decisions / delivery scopes
    │
    └── human acceptance gate
            │
            ▼
        Multica
        coordination
        / run history
            │
      ┌─────┴─────┐
      ▼           ▼
Claude Code     Codex
DEV Executor    Independent Reviewer
      │           │
      └─────┬─────┘
            ▼
      GitHub Spec Kit
            │
            ▼
        Repository
```

- **Product Owner** — final business authority และ human gate
- **Claude Code** — default DEV Executor
- **Codex** — default Independent Reviewer แบบ read-only
- **GitHub Spec Kit** — SDD workflow + delivery artifacts
- **Multica** — coordination / Issue / run history
- **Git** — source/history ของ implementation

Independent review เป็นข้อบังคับสำหรับ implementation scope แต่ **ไม่บังคับให้ต้องมี CHANGES REQUIRED ก่อน PASS**

---

## 7. Initialize Spec Kit in this repository

Repository นี้เป็น non-empty repository ที่มี Blueprint baseline commit แล้ว จึงให้ตรวจ environment ก่อน init

### 7.1 Check CLI and agent tools

```bash
specify check
specify version --features
```

ถ้าต้องการตรวจว่ามี Specify CLI รุ่นใหม่หรือไม่:

```bash
specify self check
```

### 7.2 Initialize with Claude as default integration

```bash
specify init --here --force --integration claude
```

จากนั้นตรวจผลก่อนทำขั้นถัดไป:

```bash
git status
git diff
```

### 7.3 Install Codex as additional integration

```bash
specify integration install codex
specify integration status
```

การติดตั้ง integration เพิ่ม **ไม่เปลี่ยน default integration อัตโนมัติ** — workflow นี้ตั้งใจให้ Claude remain เป็น default delivery integration เว้นแต่ Product Owner สั่งเปลี่ยน

Expected structure หลัง init/integration:

```text
.specify/          ← shared Spec Kit project infrastructure
.claude/skills/    ← Claude integration
.agents/skills/    ← Codex integration
specs/             ← generated feature delivery artifacts
```

---

## 8. Delivery flow

### Project-level

```text
Phase 0 — Repository / Blueprint Readiness
→ Constitution (เมื่อยังไม่มีหรือ Product Owner ตั้งใจเปลี่ยน)
```

### Per feature

```text
Specify
→ Clarify (conditional)
→ Plan
→ Checklist (conditional)
→ Tasks
→ Analyze
→ Independent Delivery Readiness Review
→ Authorized Implementation Scope Loop
→ Converge
→ Independent Final Feature Review
→ Human Acceptance
```

รายละเอียด authoritative workflow อยู่ใน `MASTER-PROMPT.md`; README นี้เป็นเพียง entry point และไม่ควร duplicate workflow logic ทั้งหมด

---

## 9. Authorized Implementation Scope

Workflow v1.2.0 **ไม่บังคับ 1 Task = 1 Run**

หนึ่ง implementation scope อาจเป็น:

- task เดี่ยว
- bounded same-Phase batch

ใช้ batch เมื่อ dependency พร้อม, concern ต่อเนื่อง, verification ชัด และ diff ยัง review ได้อย่างมีคุณภาพ

ให้ลด scope เมื่อเกี่ยวกับความเสี่ยงสูง เช่น:

- security / authorization
- transaction / concurrency
- stock quantity / unit conversion
- lifecycle/state transition
- audit/evidence integrity
- destructive migration
- cross-feature business invariants

Product Owner ต้อง authorize scope ก่อน implement และ Reviewer ต้อง review **exact authorized scope**

---

## 10. Independent review gates

Review contract canonical อยู่ที่ `REVIEWER.md`

1. **Delivery Readiness Review** — หลัง Analyze ก่อน implementation
2. **Implementation Scope Review** — หลังทุก authorized implementation scope/rework
3. **Final Feature Review** — หลัง Converge ก่อน Human Acceptance

Reviewer ใช้ verdict:

- `PASS`
- `CHANGES REQUIRED`
- `REVIEW BLOCKED`

Reviewer ไม่แก้ implementation/spec/Blueprint เองระหว่างทำหน้าที่ review

---

## 11. File roles

| File | Role |
|---|---|
| `BLUEPRINT.md` | top-level frozen business/system baseline |
| `docs/` | canonical cross-feature domain documentation |
| `features/` | bounded delivery context + rule routing |
| `MASTER-PROMPT.md` | project workflow contract |
| `CLAUDE.md` | Claude DEV adapter |
| `AGENTS.md` | Codex project adapter |
| `REVIEWER.md` | independent review contract |
| `SHORT-PROMPTS.md` | concise phase/review/rework prompts |
| `MULTICA.md` | coordination/routing conventions |

Agent implementation สามารถเปลี่ยนภายหลังได้ แต่ repository artifacts ยังคงเป็น project truth

---

## 12. Ready package ZIP

`office-asset-management-ready-v1.2.0.zip` เป็น **distribution/convenience artifact** ของ baseline เท่านั้น

กติกา:

- canonical source คือ text files ใน repository `main`
- ZIP **ไม่ใช่ source of truth แยกอีกชุด**
- เมื่อ packaged text files เปลี่ยน ต้อง rebuild ZIP ใน PR เดียวกัน
- ก่อน merge ต้องตรวจว่า packaged files ที่เปลี่ยนตรงกับ branch counterpart
- workflow package version `v1.2.0` แยกจาก Blueprint version `v1.0.2`

---

## 13. Do not add back

หลีกเลี่ยงการสร้าง governance/architecture ซ้ำโดยไม่มี requirement จริง เช่น:

- forced `CHANGES REQUIRED`
- custom review database/ledger
- SHA/adoption orchestration protocol
- duplicate `PROJECT-STATUS` สำหรับจำ workflow
- Codex-as-orchestrator layer
- Planner/Tester/Architect agents เพิ่มโดยไม่มี requirement
- automatic whole-Phase implementation โดยไม่ประเมิน risk
- Blueprint/Spec Kit content ที่ copy ซ้ำเข้า Multica
- framework/abstraction เผื่ออนาคตที่ยังไม่มี current feature ใช้

---

## 14. First run after Spec Kit initialization

Trigger Claude DEV ด้วย instruction:

```text
อ่าน CLAUDE.md และ MASTER-PROMPT.md แล้วดำเนินการ Phase 0 — Repository / Blueprint Readiness เท่านั้น ตรวจ Spec Kit integrations และ repository state รายงาน Phase Result แล้ว STOP
```

จากนั้นใช้ `SHORT-PROMPTS.md` สำหรับ phase/scope/review/rework ถัดไป

---

## 15. Ready-to-start criterion

Blueprint พร้อมเริ่ม Spec Kit เมื่อ Product Owner ยืนยันว่า:

1. scope / non-goals ถูกต้อง
2. 14 feature boundaries ใช้เป็น starting decomposition ได้
3. critical workflows ไม่มี business path สำคัญที่ทราบว่าขาด
4. canonical Business Rules 252 ข้อไม่มีข้อที่ทราบว่าไม่ต้องการ

สถานะ repository ปัจจุบันผ่านการจัด alignment ของ Blueprint documents และ Feature Briefs แล้ว

จากจุดนี้ให้ **หยุด recursive Blueprint review ที่ไม่มี trigger ใหม่** และใช้ Specify/Clarify ของ feature จริงเป็นจุดตัดสินรายละเอียดที่ยังเปิดอยู่
