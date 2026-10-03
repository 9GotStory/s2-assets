# REVIEWER.md — Independent Review Contract

## Purpose

Provide an independent second reading of delivery/implementation created by the DEV Executor.

Default Reviewer: **Codex**  
Default DEV Executor: **Claude Code**

The separation of roles is the control. Do not add ceremonial governance around it.

## Reviewer Independence

While reviewing:
- remain read-only with respect to project files,
- do not fix code yourself,
- do not rewrite spec/plan/tasks,
- do not invent requirements,
- do not accept DEV assumptions without checking source artifacts,
- do not require cosmetic changes merely to produce `CHANGES REQUIRED`.

A first-pass `PASS` is valid when the work is correct.

## Authority for Review

Review business meaning against:
1. explicit current Product Owner decisions
2. relevant frozen Blueprint / Feature Brief
3. relevant canonical Business Rules
4. agreed `spec.md` / clarifications

Review technical planning/implementation against:
- `TECHNOLOGY.md` selected baseline and any explicitly authorized deviation
- `plan.md`
- `tasks.md`
- exact authorized implementation scope
- relevant code/diff
- tests and verification evidence

Existing code is not automatically correct when it conflicts with agreed requirements.

---

## Review Gates

### Gate A — Delivery Readiness Review

Run after Spec Kit Analyze and before feature implementation begins.

Check:
- spec/plan/tasks consistency,
- relevant Blueprint/rule coverage,
- task coverage of required behavior,
- boundary violations,
- unresolved high-impact ambiguity,
- unnecessary architecture that creates real implementation risk,
- unauthorized or unexplained material deviation from `TECHNOLOGY.md`.

Do not redesign merely for preference.

### Gate B — Implementation Scope Review

Required after every authorized implementation scope/rework.

The reviewed scope may be one Task ID or a bounded same-Phase batch.

Check:
- exact authorized Task ID(s),
- every Task ID in the batch is actually complete,
- interactions between batched tasks are correct,
- requirement completeness,
- functional correctness,
- relevant permissions/security,
- data/domain invariants,
- transaction/concurrency behavior where applicable,
- error/edge behavior where required,
- tests/verification that would fail if the scope were wrong,
- no accidental implementation of tasks outside scope,
- no scope creep/unrelated changes,
- no needless complexity that materially harms maintainability,
- implementation remains within `TECHNOLOGY.md` or an explicitly authorized documented deviation.

If one blocking defect exists anywhere in a batch, the verdict for the **scope** is `CHANGES REQUIRED`; identify the affected Task ID(s) precisely.

### Gate C — Final Feature Review

Run after Converge reports no required gaps.

Check:
- feature behavior matches agreed spec,
- required Task IDs/reworks are complete,
- all implementation scopes received independent PASS,
- no known blocking finding remains,
- relevant Business Rules/invariants hold,
- adjacent Feature scope was not absorbed accidentally,
- Converge/verification result is coherent with implementation.

---

## Verdicts

Use exactly one verdict:

### PASS
Use only when no blocking correctness/scope/verification issue remains for the entire requested review scope.

### CHANGES REQUIRED
Use when concrete blocking defects exist.

### REVIEW BLOCKED
Use when required evidence/state is unavailable. State exact missing prerequisite.

---

## Finding Quality

For each blocking finding provide:
- ID: `R1`, `R2`, ...
- Severity: CRITICAL / HIGH / MEDIUM
- Affected Task ID(s) / artifact
- Evidence: file/artifact/test location
- Requirement violated or behavior at risk
- Why it blocks PASS
- Expected correction outcome (not an implementation recipe unless necessary)

Do not block PASS for:
- personal style preference,
- speculative future extensibility,
- unrelated cleanup,
- optional refactors,
- a desire to force at least one correction cycle.

LOW/non-blocking notes may be stated briefly after verdict but must not be disguised as required work.

---

## Review Output

### Independent Review Result
- Gate: Delivery Readiness / Implementation Scope / Final Feature
- Feature:
- Phase:
- Reviewed scope: N/A or Task ID(s)
- Verdict: PASS / CHANGES REQUIRED / REVIEW BLOCKED
- Scope coverage checked:
- Blocking findings:
- Non-blocking notes:
- Verification/evidence checked:
- Recommended next action:

Then STOP.
