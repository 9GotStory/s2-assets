# MASTER PROMPT — GitHub Spec Kit + Independent Review
## Office Asset & Consumable Management System
Version: 3.2
Blueprint: `office-asset-management-blueprint-v1.0.2`

---

## 1. Working Model

Roles:
- **Product Owner:** final business authority and human gate
- **Claude Code:** default DEV Executor and primary Spec Kit delivery agent
- **Codex:** default Independent Reviewer
- **GitHub Spec Kit:** SDD workflow/artifacts
- **Multica:** coordination and run history

Roles are replaceable. Repository artifacts hold project truth; agent identity does not.

Core rule:

> One authorized step/scope → verification/review → report → STOP.

Core principle:

> Simple — Structured — Sustainable.

Do not build a second orchestration/governance framework on top of Spec Kit.

---

## 2. Authority

### Business Authority
1. current explicit Product Owner decision
2. frozen Blueprint v1.0.2
3. relevant Feature Brief
4. canonical Business Rules

### Technical Direction
`TECHNOLOGY.md` defines the project-wide selected technical baseline for planning and implementation.

- It is subordinate to Business Authority.
- Feature `plan.md` must begin from this baseline rather than silently reselecting the stack.
- Exact minor/patch versions and items explicitly marked Deferred may be resolved in Plan.
- Material deviations (for example database engine, frontend/backend framework, or production container runtime) require explicit rationale/impact and Product Owner decision before implementation.

### Project Principles
The Constitution governs project-wide engineering principles and must remain compatible with Business Authority and the selected Technical Direction.

### Feature Delivery Artifacts
- `spec.md` / clarifications
- `plan.md` and supporting artifacts
- `tasks.md`
- implementation/tests

Lower-level artifacts may refine delivery but may not silently redefine higher business authority.

---

## 3. Context Discipline

Use progressive disclosure:
1. `BLUEPRINT.md`
2. `docs/09-feature-map.md`
3. active `features/<feature>.md`
4. only relevant canonical docs/rules
5. `TECHNOLOGY.md` for Plan/Tasks/Implementation/technical review
6. active Spec Kit artifacts
7. relevant implementation/diff/tests

Do not load or duplicate all Blueprint content by default.

---

## 4. Non-Negotiable Rules

1. One active Feature at a time.
2. One authorized delivery phase, implementation scope, or review run at a time.
3. Report and STOP after each step.
4. Product Owner authorizes continuation.
5. DEV never independently approves its own implementation.
6. Independent implementation-scope review is mandatory before progression.
7. Reviewer may PASS first time; never force `CHANGES REQUIRED` for ceremony.
8. Reviewer remains read-only while reviewing.
9. Do not edit frozen Blueprint automatically.
10. Do not invent requirements.
11. `Clarification Candidate — Not Yet Requirement` remains a question until resolved.
12. Prefer current requirements + existing conventions + simplest sufficient design.
13. No speculative infrastructure/abstractions without current need.
14. No unrelated refactors during bounded scopes.
15. Do not recreate SHA/adoption/custom evidence/state-ledger machinery.
16. Do not silently replace the selected stack in `TECHNOLOGY.md`; material deviation must be explicit and authorized before implementation.

---

## 5. Spec Kit Integration Model

Use the commands/skills actually installed by Spec Kit.

Recommended setup:
- Claude = default integration
- Codex = additional multi-install-safe integration

Conceptual flow:

`Constitution`
→ `Specify`
→ optional `Clarify`
→ `Plan`
→ optional `Checklist`
→ `Tasks`
→ `Analyze`
→ **Independent Delivery Readiness Review**
→ implementation-scope/review loop
→ `Converge`
→ **Independent Final Feature Review**
→ Human Acceptance

---

# PROJECT START

## 6. Phase 0 — Repository / Blueprint Readiness

DEV verifies:
- intended repository and Git state,
- Spec Kit initialized,
- Claude/Codex integrations installed/healthy,
- Blueprint v1.0.2 present,
- all 14 Feature Briefs present,
- `TECHNOLOGY.md` selected baseline present and readable,
- current active feature/spec state understood.

Do not initialize Spec Kit inside this phase if initialization has not yet been done; report the missing prerequisite instead.
Do not modify application code.

Return Phase Result and STOP.

---

## 7. Constitution

Run only when authorized and Constitution is absent or intentionally revised.

Keep it concise/project-wide: Security First, Simple–Structured–Sustainable, Requirement-Driven Development, Domain/Data Integrity, Least Privilege, Proportionate Auditability/Verification, Operational Sustainability, and no silent Blueprint semantic drift.

Do not copy 252 Business Rules or feature-specific workflows into Constitution.

Inspect generated result, report and STOP.

---

# FEATURE DELIVERY

## 8. Select One Feature

Use `docs/09-feature-map.md` and relevant Feature Brief.

Default first feature: `01-application-foundation`, unless Product Owner explicitly chooses otherwise.

A Feature Brief is Blueprint context/routing, not a pre-generated `spec.md`.

---

## 9. Specify

Use installed Spec Kit Specify skill.

Define WHAT/WHY:
- goals/actors,
- user stories/scenarios,
- observable requirements,
- permissions/state behavior,
- meaningful edge cases,
- success criteria,
- important exclusions.

Do not choose technical mechanisms unless they are business constraints.
Do not promote Clarification Candidates into requirements without resolution.

Inspect `spec.md` for missing/invented requirements and ambiguity. Report, STOP.

---

## 10. Clarify — Conditional

Run only when ambiguity can materially change workflow, permissions, state transitions, data integrity, acceptance behavior, audit semantics, or cross-feature responsibility.

Do not ask questions that safely belong to Plan.

After clarification, summarize decisions/open blockers. STOP.

If unnecessary, report that it can be skipped.

---

## 11. Plan

Run after spec is sufficiently clear.

Read `TECHNOLOGY.md` before technical planning. Treat its selected stack as the project baseline, not as a suggestion to re-evaluate from scratch.

Plan may decide architecture details, exact compatible package versions, project structure, data model, contracts/interfaces, transaction boundaries, permission enforcement, audit implementation, testing strategy, deployment details, and operational/migration concerns.

Resolve items marked **Deferred to Plan** in `TECHNOLOGY.md` when they are relevant to the active Feature.

If a current requirement/environment creates a material conflict with the selected technical baseline:
- document the concrete constraint,
- identify the proposed deviation and impact,
- do not silently substitute technology,
- obtain Product Owner decision before implementation when the deviation changes a project-wide selected technology.

Use least complex design satisfying current requirements. Preserve Feature boundaries. Avoid hypothetical future extensibility.

Inspect generated Plan for business semantic drift, unauthorized technology drift, and overengineering. Report, STOP.

---

## 12. Checklist — Conditional

Use when focused requirements-quality validation adds real value, especially complex state/permissions/stock/audit/cross-feature behavior.

Checklist evaluates requirements, not code.
Repair owning requirements artifact when defects are found.

Report, STOP.

---

## 13. Tasks

Generate dependency-ordered, bounded, verifiable tasks.

Spec Kit Phase headings in `tasks.md` are meaningful grouping context for later implementation-scope selection.

Do not create tasks that implement an entire feature in one step when decomposition is practical.
Do not rewrite Spec Kit task structure merely for custom orchestration.

Inspect coverage/order and identify the first dependency-ready area. Do not implement yet. Report, STOP.

---

## 14. Analyze

Run Spec Kit Analyze before implementation unless Product Owner explicitly skips genuinely trivial work.

Use Analyze for spec/plan/tasks consistency, then do a lightweight alignment check against Feature Brief/canonical rules.

Resolve CRITICAL/HIGH correctness defects in owning artifacts before Delivery Readiness Review.

Report, STOP.

---

## 15. Independent Delivery Readiness Review — REQUIRED

Before first implementation scope, Codex performs Gate A from `REVIEWER.md` read-only.

If `PASS`: Product Owner may authorize first implementation scope.

If `CHANGES REQUIRED`: Claude corrects only cited delivery-artifact defects, reports, and Codex re-reviews until PASS or Product Owner intervenes.

Never force an artificial correction cycle.

---

# IMPLEMENTATION SCOPE LOOP

## 16. Select / Authorize a Bounded Implementation Scope

An implementation scope is either:
- one Task ID, or
- a bounded batch of dependency-ready Task IDs from the **same `tasks.md` Phase**.

Before implementation, DEV reads the current Phase and incomplete dependency-ready tasks.

Batch only when all are true:
1. same Phase,
2. dependencies ready,
3. no Product Owner/business decision is expected between tasks,
4. tasks form one coherent technical concern,
5. batch has clear verification,
6. resulting diff remains independently reviewable,
7. batching does not obscure multiple high-risk mutations.

Prefer a single task/smaller batch for:
- security/authorization,
- transaction/concurrency,
- stock quantity/unit conversion integrity,
- lifecycle/state transitions,
- audit/evidence integrity,
- migrations/destructive operations,
- high-risk cross-feature business rules.

Phase boundaries are grouping hints, **not automatic authorization to implement the entire Phase**.

If Product Owner explicitly authorizes `T006–T009`, implement exactly that scope only after dependency/blocker check. If unsafe/incoherent, STOP and explain rather than silently changing scope.

If Product Owner says only “Continue” after a prior PASS, DEV selects the next safe bounded scope using these rules, states that scope in the result, and does not expand beyond it.

If the installed Spec Kit Implement skill can be scoped cleanly to the authorized scope, use it; otherwise execute directly under the same boundaries without inventing custom governance.

---

## 17. DEV Execution

Claude DEV:
- inspect relevant artifacts/code before editing,
- implement only authorized scope + minimal required support,
- preserve individual Task IDs from `tasks.md`,
- add/update proportionate tests,
- run verification covering the whole scope,
- do bounded self-check,
- never declare independent PASS.

Return:

### DEV Implementation Scope Result
- Feature
- Phase
- Authorized scope: Task ID(s)
- Status: READY FOR INDEPENDENT REVIEW / BLOCKED
- Files changed
- Behavior delivered per Task ID
- Verification
- Relevant rules/invariants checked
- Issues/assumptions
- Recommended next action: Independent Implementation Scope Review

STOP.

---

## 18. Independent Implementation Scope Review — REQUIRED

Codex performs Gate B from `REVIEWER.md` against the **exact authorized scope/diff**.

For a batch, Reviewer must verify:
- every Task ID in scope,
- interactions between tasks,
- batch-level verification,
- no accidental work from tasks outside scope.

Reviewer must not modify project files.

### PASS
The entire scope is independently accepted technically. Next implementation scope still waits for Product Owner continuation.

### CHANGES REQUIRED
Claude receives concrete findings and reworks the **same authorized scope only**.

After rework:
- rerun relevant verification,
- report `READY FOR INDEPENDENT REVIEW`,
- Codex re-reviews the same scope.

Repeat only for real blocking findings.

### REVIEW BLOCKED
Resolve exact missing prerequisite; do not proceed to a new scope.

---

## 19. Product Owner Gate

After independent `PASS`, STOP.

Only explicit Product Owner continuation authorizes progression to another implementation scope.

Do not treat Multica Issue state or Reviewer PASS as automatic authorization for future work.

---

# COMPLETION

## 20. Converge

After all planned implementation scopes/tasks have independently passed, DEV runs installed Spec Kit Converge.

If required gaps are appended:
- route them through the same bounded implementation-scope/review loop.

If no required gaps remain:
- report feature ready for Independent Final Feature Review.

STOP.

---

## 21. Independent Final Feature Review — REQUIRED

Codex performs Gate C from `REVIEWER.md` after Converge.

If `CHANGES REQUIRED`, correction routes to the owning artifact/task/scope; Reviewer does not fix directly.

When `PASS`, report feature ready for Human Acceptance.

STOP.

---

## 22. Human Feature Acceptance

Product Owner decides whether Feature is accepted/closed and whether another Feature may start.

Completion requires:
- agreed spec satisfied,
- material clarifications resolved,
- plan/tasks coherent,
- all required implementation Task IDs covered by independently PASSed scopes,
- Converge has no required gaps,
- Final Feature Review PASS,
- relevant Feature invariants/Business Rules hold.

Return Feature Completion Report only when Product Owner requests acceptance assessment.

---

# EXCEPTIONS / PORTABILITY

## 23. Blueprint Change Candidate

If probable Blueprint defect is found:
- do not edit Blueprint,
- state current rule/statement,
- observed problem,
- impact,
- required Product Owner decision,
- STOP.

---

## 24. Agent Replacement

Repository truth remains portable.

If Product Owner later assigns Codex as DEV or Claude as Reviewer, follow explicit role assignment and applicable workflow contract without recreating specs/history.

Prefer role changes at a clean scope/feature boundary when practical.

---

## 25. Fresh Session Recovery

Reconstruct from:
- Git status/history,
- installed Spec Kit integrations,
- active `specs/` artifacts,
- `tasks.md` Phase/task completion,
- relevant Blueprint/Feature Brief,
- `TECHNOLOGY.md` for technical baseline when the current stage is Plan/Tasks/Implementation/review,
- latest explicit Product Owner instruction/review result available in current context.

Do not create custom `PROJECT-STATUS`, review ledger, or adoption state solely for orchestration memory.

Report current stage + one recommended next action/scope, STOP.

---

## 26. Meaning of “Continue”

“ดำเนินการต่อ / Continue” authorizes exactly one clearly recommended next action.

For implementation after Reviewer PASS, that action may be a **bounded implementation scope** (one task or safe same-Phase batch), not necessarily one Task ID.

Role transitions in Multica remain explicit:
- after DEV result → trigger Reviewer,
- after `CHANGES REQUIRED` → trigger DEV rework,
- after Reviewer PASS → Product Owner may trigger DEV for next bounded scope.

Do not guess agent routing when ambiguous.

---

## 27. Reporting

### Phase Result
- Phase
- Feature
- Status: PASS / NEEDS DECISION / BLOCKED
- Artifacts changed
- Key findings
- Open decisions/blockers
- Recommended next action

### Independent Review Result
Use `REVIEWER.md` format.

Then STOP.

---

## 28. Anti-Overengineering Filter

Before adding architecture/process/infrastructure ask:
1. Which current requirement needs it?
2. Which current Feature needs it now?
3. What concrete problem occurs without it?
4. Can existing conventions solve it?
5. Is there a simpler option?
6. Does it create a second source of truth or operational burden?

If not justified now, do not add it.

---

## 29. First Instruction

After repository setup, Claude DEV reads `CLAUDE.md`, this file, and `TECHNOLOGY.md`, then performs **Phase 0 — Repository / Blueprint Readiness only**, reports and STOPs.
