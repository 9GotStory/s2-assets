# Office Asset & Consumable Management System

> Canonical Blueprint baseline สำหรับระบบครุภัณฑ์สำนักงานและวัสดุสิ้นเปลือง; Feature 002 onward uses Claude Code CLI with Matt Pocock Skills and GitHub Issues tracking.

| Baseline | Value |
|---|---|
| Blueprint | **v1.0.2 — FROZEN** |
| Workflow | **Claude Code CLI + Matt Pocock Skills from Feature 002; rules in `CLAUDE.md`** |
| Technology Direction | **`TECHNOLOGY.md` v1.1.0 — SELECTED BASELINE** |
| Business Rules | **252 canonical rules** |
| Delivery decomposition | **14 Feature Briefs** |
| Feature 001 tooling (historical) | **Spec Kit 1.1.1 / AGY integration, retired 2026-11-04** |

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

Approved feature specifications and tickets refine delivery details แต่ห้าม silent-redefine business meaning ที่อยู่ใน authority สูงกว่า

`CLAUDE.md` selects Claude Code CLI and Matt Pocock Skills for Feature 002
onward. Spec Kit, Multica and AGY references in frozen/context documents are
historical delivery context; business scope, rules and technical authority
remain unchanged.

### Technical Direction

`TECHNOLOGY.md` v1.1.0 เป็น project-wide selected technical baseline

- feature specification ต้องเริ่มจาก baseline นี้
- exact minor/patch versions และ Deferred decisions ให้ specification resolve ตาม environment จริง
- material technology deviation ต้อง explicit พร้อมเหตุผล/ผลกระทบและ Product Owner decision ก่อน implementation
- local application development runtime ใช้ **Rootless Podman**
- Git, Git worktrees และ engineering workflow tooling (Claude Code CLI) อยู่บน host

### Project / Delivery Authority

For Feature 002 onward:

- `CLAUDE.md` — the repository's only rules file: authority, workflow and engineering principles
- approved feature specification/decisions — behavior, acceptance and implementation/testing decisions
- approved GitHub Issues — bounded delivery tickets and recorded Product Owner decisions
- implementation + tests — delivered behavior

Feature 001 historical artifact roles remain:

- Constitution (retired 2026-11-04; in Git history) — project-wide engineering principles
- `spec.md` / clarifications — feature behavior และ acceptance
- `plan.md` — implementation strategy
- `tasks.md` — executable delivery decomposition
- implementation + tests — delivered behavior

Product Owner decisions บันทึกใน GitHub Issues และ remain authoritative; agent-generated content cannot redefine business requirements.
Multica Issue/comments/run history ก่อน 2026-11-03 เป็น historical provenance เท่านั้น ไม่ใช่ช่องทาง coordination สำหรับงานใหม่ (ดู `CLAUDE.md`)

---

## 2. Blueprint and feature structure

`docs/` เป็น canonical cross-feature domain layer และ `features/` เป็น bounded delivery slicing layer

- 252 canonical Business Rules อยู่ใน `docs/06-business-rules.md`
- 14 features และ dependencies อยู่ใน `docs/09-feature-map.md`
- Feature Brief route กลับไปหา canonical Rule IDs แทนการ copy rule wording
- Feature 01 คือ `application-foundation`

---

## 3. Runtime and delivery model

### Feature 002 onward

```text
grill-with-docs
→ prototype (when a question needs running code)
→ to-spec
→ to-tickets
→ implement per ticket (drives tdd, closes with code-review)
→ pr
→ merge into the feature's integration branch
→ retro
→ Product Owner acceptance of the feature → main
```

Use the skills the work needs; reuse approved specifications and tickets. GitHub
Issues track specifications and tickets and record Product Owner decisions.
Claude Code develops; the Product Owner decides: `CLAUDE.md` holds the rules for
starting work, scope, self-review, merges into the feature's integration branch
and Product Owner acceptance before `main`.

### Feature 001 before Human Gate — historical

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

---

## 4. Feature 001 Spec Kit integration — historical

Feature 001 ใช้ Spec Kit **1.1.1** กับ integration **`agy`**. Spec Kit ถูก retire
เมื่อ 2026-11-04 (#36): ลบ `.specify/` (templates, scripts, integrations และ
Constitution) และ `.agents/` (AGY skills และ MCP config) แล้ว ประวัติอยู่ใน Git

`specs/001-application-foundation/` คงไว้เป็น record ของ Feature 001
(46 tasks เสร็จครบ)

---

## 5. Rootless Podman development baseline

Application runtime และ infrastructure dependencies สำหรับ normal development ต้องรันด้วย Rootless Podman ตาม `TECHNOLOGY.md`

```text
Fedora Host
├── Git / worktrees
├── Claude Code CLI + Matt Pocock Skills
│
└── Rootless Podman
    ├── web
    ├── api
    └── PostgreSQL
```

Development runtime รันเป็น rootless Podman + user-level systemd Quadlet ของ workspace user (UID 1000): Web `http://127.0.0.1:5180`, API `http://127.0.0.1:3010` ติดตั้ง อัปเดต และตรวจสอบด้วย `scripts/dev-runtime-*.sh` ตาม [`docs/operations/development-runtime.md`](docs/operations/development-runtime.md)

### Configuration: Public Application Origin (`PUBLIC_APP_ORIGIN`)

For QR code generation and minimal single-label printing (Ticket #29, T8):

- `PUBLIC_APP_ORIGIN`: Base URL (protocol + host[:port]) of the public web application used to construct canonical QR locator URLs (`${PUBLIC_APP_ORIGIN}/assets/:id`).
- **Validation rules**:
  - Maximum 512 UTF-8 bytes.
  - Must not contain whitespace, control characters, userinfo, query parameters, fragments, or paths (trailing slashes are stripped automatically).
  - Must use `https:` in production environments (`NODE_ENV=production`).
  - In non-production (`development`, `test`), `http:` is permitted only for loopback addresses (`localhost`, `127.0.0.1`, `[::1]`). Wildcard hosts (`0.0.0.0`, `[::]`, `*`) are rejected.
  - If invalid, application startup/composition fails closed without echoing raw input in error logs.
- **Runtime failure behavior**:
  - If `PUBLIC_APP_ORIGIN` is unset or omitted, the application starts normally, but requests to `GET /assets/:id/qr-label` will fail closed with HTTP 503 `SERVICE_UNAVAILABLE` and `Cache-Control: no-store`.

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

หนึ่ง feature ทำทีละช่วงตาม approved feature-scoped workflow; ห้ามใช้ feature แรกสร้าง framework เผื่อทุก feature หลัง

---

## 7. Reading order

### Product Owner / feature authoring

1. `README.md`
2. `BLUEPRINT.md`
3. `TECHNOLOGY.md`
4. `docs/09-feature-map.md`
5. active Feature Brief
6. relevant canonical docs/rules
7. approved active feature specification, decisions and tickets (historical Spec Kit artifacts for Feature 001)

### Implementation / review

1. `CLAUDE.md` — the repository's only rules file
2. relevant Business Authority / Technology Direction
3. exact authorized feature specification, decisions and ticket context
4. exact diff/tests/evidence for the authorized scope

ใช้ progressive disclosure; ห้าม copy Blueprint ทั้งชุดเข้า feature spec โดยอัตโนมัติ

---

## 8. Repository governance files

| File | Role |
|---|---|
| `BLUEPRINT.md` | frozen business/system baseline |
| `TECHNOLOGY.md` | selected technical baseline |
| `docs/` | canonical cross-feature domain documentation |
| `features/` | bounded delivery context + rule routing |
| `CLAUDE.md` | the only rules file: authority, workflow, checks, engineering principles |
| `docs/agents/` | Matt Skills configuration: issue tracker, triage labels, domain docs |
| `specs/001-application-foundation/` | Feature 001 record (retired Spec Kit format) |

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

---

## 10. Current start point

Feature 002 — `asset-registry` continues with Claude Code CLI and the accepted
Matt Skills setup under `CLAUDE.md`. Spec Kit, the Constitution and `AGENTS.md`
were retired on 2026-11-04 (#36). See `CLAUDE.md`,
`docs/agents/issue-tracker.md` and `docs/agents/domain.md`.

### Feature 001 start-point record — historical

After Spec Kit bootstrap and Constitution are accepted (historical sequence):

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
