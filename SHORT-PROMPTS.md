# SHORT-PROMPTS.md — Spec Kit + AGY 3-Role

Use only as concise operational prompts. Canonical workflow remains `MASTER-PROMPT.md`.

## Spec Kit — Constitution

Read `README.md`, `BLUEPRINT.md`, `TECHNOLOGY.md`, `MASTER-PROMPT.md`, and the Blueprint/Feature map. Create the project Constitution from existing project-wide principles only. Do not invent feature requirements. Report and STOP.

## Spec Kit — Specify

Create the active feature specification from the active Feature Brief and only relevant canonical rules/docs. Preserve authority and boundaries. Report and STOP.

## Spec Kit — Clarify

Resolve only material ambiguities blocking a correct Plan. Do not invent requirements. Report and STOP.

## Spec Kit — Plan

Plan from `TECHNOLOGY.md` and accepted spec. Resolve Deferred decisions needed by this feature. Prefer simplest sufficient design. Report and STOP.

## Spec Kit — Tasks

Create bounded executable tasks with dependencies and verification. Do not prebuild future-feature abstractions. Report and STOP.

## Spec Kit — Analyze

Check spec/plan/tasks/Constitution/Business Authority/Technology Direction consistency. Surface blocking conflicts before Human Gate. Report and STOP.

## AGY Lead — Authorized Handoff

Inspect the exact Product Owner-authorized implementation scope and baseline. Delegate exactly one bounded scope to `agy-developer`, actively mention only that agent, never edit the published delegation, then STOP. If authority/scope is unclear, return HANDOFF_BLOCKED.

## AGY Developer — Implement

Implement only the delegated scope. Run required verification, inspect final diff, publish IMPLEMENTATION_RESULT, actively mention `agy-independent-reviewer`, then STOP. Do not emit reviewer verdict.

## AGY Developer — Rework

Correct only the independent review findings inside the same authorized scope. Re-run verification, publish CORRECTIVE_RESULT, mention `agy-independent-reviewer`, then STOP.

## AGY Reviewer — Review

Independently inspect exact scope, repository evidence, diff and tests. Do not modify implementation. Return exactly PASS / REWORK / BLOCKED. REWORK mentions only `agy-developer`; PASS/BLOCKED returns to Product Owner. STOP.

## Spec Kit — Converge

After authorized implementation scopes are complete, reconcile Spec Kit delivery artifacts with actual delivered state without changing canonical business authority. Report and STOP.

## Blueprint Conflict

STOP. Identify the exact conflict with Product Owner/Blueprint/Feature Brief/canonical rule. Do not silently edit authority. Request Human Gate.
