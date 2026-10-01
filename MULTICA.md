# MULTICA.md — Thin Coordination for DEV + Independent Review

## Purpose

Multica coordinates two role-separated AI runs without becoming a second development methodology.

```text
Product Owner
    ↓
Multica Feature Issue
    ├── Asset System DEV      → Claude Code
    └── Asset System Reviewer → Codex CLI
             ↓
         Repository
```

Multica owns coordination/run history only. Blueprint, Spec Kit artifacts, code/tests, and Product Owner decisions remain authoritative.

---

## 1. Baseline Configuration

```text
Project: Office Asset & Consumable Management System
Resource: Local Git checkout
Execution mode: Direct / in_place
Active Features: 1
Autopilot: off
Squads: off
Parallel feature work: off
```

Use sequential Direct / `in_place` for cumulative phase/scope/review runs on the same checkout.
Do not run DEV and Reviewer concurrently against the same project state.

---

## 2. Agents

### Agent A — Asset System DEV

```text
Runtime: Claude Code
Concurrency: 1
Default role: DEV Executor
```

Recommended Agent Instructions:

```text
You are the DEV Executor for the Office Asset & Consumable Management System.

At every run:
1. Read CLAUDE.md.
2. Follow MASTER-PROMPT.md.
3. Reconstruct current Spec Kit/repository state.
4. Treat the current Product Owner/Multica instruction as the authorized bounded work.

Rules:
- One authorized delivery phase or implementation/rework scope per run.
- An implementation scope may be one task or a safe bounded same-Phase batch.
- Never implement the whole Phase automatically just because tasks share a Phase heading.
- Never declare independent review PASS yourself.
- After implementation/rework and verification, report READY FOR INDEPENDENT REVIEW and STOP.
- Do not start the next scope automatically.
- Do not modify frozen Blueprint without Product Owner approval.
- Prefer Simple — Structured — Sustainable.
```

### Agent B — Asset System Reviewer

```text
Runtime: Codex CLI
Concurrency: 1
Default role: Independent Reviewer
```

Recommended Agent Instructions:

```text
You are the Independent Reviewer for the Office Asset & Consumable Management System.

At every review run:
1. Read AGENTS.md and REVIEWER.md.
2. Identify the exact requested review gate/scope.
3. Remain read-only: do not modify project files.
4. For a batch, review every included Task ID and their interactions.
5. Return PASS, CHANGES REQUIRED, or REVIEW BLOCKED using REVIEWER.md.
6. Do not force a correction cycle when work is already correct.
7. STOP after review.
```

No third orchestrator agent is needed.

---

## 3. Spec Kit Integrations

Initialize Claude as default in the non-empty baseline repository, then add Codex:

```bash
specify init --here --force --integration claude
specify integration install codex
specify integration status
```

Expected roots:

```text
.claude/skills/    ← Claude Spec Kit skills
.agents/skills/    ← Codex Spec Kit skills
.specify/          ← shared
specs/             ← shared feature artifacts
```

Codex does not need to invoke Spec Kit commands for ordinary review; its integration supports project portability/future role changes.

---

## 4. Issue Strategy

Use **one Multica Issue per Blueprint Feature**.

```text
01 — Application Foundation
02 — Asset Registry
...
14 — Material Stocktake
```

Do not create one Issue per Task unless a real operational need appears.

Example sequential runs:

```text
Claude — Specify
Claude — Clarify (if needed)
Claude — Plan
Claude — Tasks
Claude — Analyze
Codex  — Delivery Readiness Review
Claude — Implement T006–T009       (safe bounded batch example)
Codex  — Review T006–T009
Claude — Rework T008               (inside same authorized scope, if required)
Codex  — Re-review T006–T009
Claude — Implement T010            (next high-risk task, if authorized)
Codex  — Review T010
...
Claude — Converge
Codex  — Final Feature Review
Product Owner — Acceptance
```

---

## 5. Routing Rules

Role transitions are explicit.

### After Claude reports READY FOR INDEPENDENT REVIEW

```text
@Asset System Reviewer
ทำ Independent Implementation Scope Review ของ scope ล่าสุดตาม REVIEWER.md แบบ read-only ตรวจทุก Task ID ใน scope แล้ว STOP
```

### After Codex returns CHANGES REQUIRED

```text
@Asset System DEV
แก้เฉพาะ blocking findings ของ authorized implementation scope ล่าสุด รัน verification ที่เกี่ยวข้อง แล้วรายงาน READY FOR INDEPENDENT REVIEW จากนั้น STOP
```

### After Codex returns PASS

Product Owner decides whether to continue. If yes:

```text
@Asset System DEV
อ่าน Phase ปัจจุบันใน tasks.md แล้วดำเนินการ next safe bounded implementation scope ตาม MASTER-PROMPT.md เพียง scope เดียว จากนั้น STOP
```

If Product Owner wants an exact batch:

```text
@Asset System DEV
ดำเนินการเฉพาะ T006–T009 ตาม tasks.md ตรวจ dependency/risk ก่อน ห้ามขยาย scope ทำ verification ครบ แล้ว STOP เพื่อ Independent Review
```

---

## 6. Review Gates

### Gate A — Delivery Readiness
After Analyze, before first implementation scope.

### Gate B — Every Implementation Scope
After every implementation/rework scope before progression.

### Gate C — Final Feature
After Converge, before Human Acceptance.

Independent review is mandatory. `CHANGES REQUIRED` is not mandatory when no blocker exists.

---

## 7. Working Copy / Git Discipline

With Direct / `in_place`:
- DEV and Reviewer inspect the same checkout sequentially,
- Reviewer remains read-only,
- inspect `git status`/`git diff` as needed,
- never overlap DEV/Reviewer runs,
- commit/push at chosen checkpoints,
- Multica Issue state never substitutes for Git history.

Prefer excluding `.multica/` runtime metadata from Git unless explicitly needed later.

---

## 8. What Multica Must Not Duplicate

Do not copy into Multica as a second source:
- Blueprint
- 252 Business Rules
- Feature Briefs
- `spec.md`
- `plan.md`
- `tasks.md`
- review ledger/state database
- custom task authorization records

Issue descriptions should reference repository artifacts, not duplicate them.

---

## 9. No Review Theater

Wrong:

```text
Every scope must receive at least one CHANGES REQUIRED before PASS.
```

Correct:

```text
Every implementation scope must receive independent review before progression.
```

Reviewer quality is measured by evidence/correctness, not correction-round count.

---

## 10. Agent Replacement

Roles are replaceable, e.g. Codex = DEV and Claude = Reviewer.

When changing roles:
- prefer a clean implementation-scope or feature boundary,
- retain repository/Spec Kit artifacts,
- use explicit Multica role instructions,
- do not rebuild Blueprint/spec/history.

---

## 11. Baseline Summary

```text
Agents: 2
DEV: Claude Code
Reviewer: Codex
Implementation unit: authorized scope (1 task or safe same-Phase batch)
Independent review gates: 3
Agent concurrency: 1 each
Same local resource: sequential Direct / in_place
Active Features: 1
Autopilot: off
Squads: off
Custom governance ledger: none
```
