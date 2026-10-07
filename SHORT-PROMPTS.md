# SHORT-PROMPTS.md — Spec Kit + AGY 3-Role

Use only as concise operational prompts. Canonical workflow remains `MASTER-PROMPT.md`.

## Spec Kit — Constitution

Read `README.md`, `BLUEPRINT.md`, `TECHNOLOGY.md`, `MASTER-PROMPT.md`, and the Blueprint/Feature map. Create the project Constitution from existing project-wide principles only. Do not invent feature requirements. Report and STOP.

## Spec Kit — Specify

Create the active feature specification from the active Feature Brief and only relevant canonical rules/docs. Preserve authority and boundaries. Report and STOP.

## Spec Kit — Clarify

Resolve only material ambiguities blocking a correct Plan. Do not invent requirements. Report and STOP.

## Spec Kit — Plan

Plan from `TECHNOLOGY.md` and accepted spec. Resolve Deferred decisions needed by this feature. For version-sensitive technology behavior, verify Context7 first when supported and use authoritative first-party fallback when necessary. Prefer simplest sufficient design. Report and STOP.

## Spec Kit — Tasks

Create bounded executable tasks with dependencies and verification. Do not prebuild future-feature abstractions. Report and STOP.

## Spec Kit — Analyze

Check spec/plan/tasks/Constitution/Business Authority/Technology Direction consistency. Surface blocking conflicts before Human Gate. Report and STOP.

## AGY Lead — Authorized Handoff

Inspect the exact Product Owner-authorized implementation scope and baseline.
Identify any material version-sensitive dependency/API verification required
through Context7. Before posting, inspect server-side issue/comment history for
the transition key `{scope, baseline-or-candidate, Lead, Developer}`. If it
already exists, do not re-post or re-mention it. Otherwise delegate exactly one
bounded scope to `agy-developer`, actively mention only that agent exactly
once, never edit the published delegation, then STOP. Treat stream interruption
as ambiguous completion. If authority/scope or prior side-effect state is
unclear, return HANDOFF_BLOCKED without replaying the handoff.

## AGY Developer — Implement

Implement only the delegated scope. Before relying on version-sensitive external
APIs/configuration, verify Context7 first when supported; if insufficient, use
authoritative first-party documentation and report the fallback. Run required
verification and inspect final diff. Before publishing IMPLEMENTATION_RESULT or
mentioning the reviewer, inspect server-side history for the exact candidate.
Publish/mention `[@agy-independent-reviewer](mention://agent/cb25c497-7933-4c9b-9263-f914bb726a2e)` at most once. On resume/retry, never
replay an existing result or reviewer handoff solely because the stream failed.
Then STOP. Do not emit reviewer verdict.

## AGY Developer — Rework

Correct only the independent review findings inside the same authorized scope.
Re-run verification and produce a new corrective-result identity. Inspect
server-side history before publishing CORRECTIVE_RESULT or mentioning
`agy-independent-reviewer`; perform that transition at most once. Never replay
the prior reviewer handoff after a stream interruption. Then STOP.

## AGY Reviewer — Review

Independently inspect exact scope, repository evidence, diff and tests. Re-check
material version-sensitive external claims through Context7 when supported or
authoritative first-party fallback when necessary. Do not modify implementation.
Before any verdict after resume/retry, inspect server-side history. Return
exactly PASS / REWORK / BLOCKED. REWORK mentions only `[@agy-developer](mention://agent/450509d9-bea0-4d4e-a360-c484bfe93a37)` exactly
once for that candidate/finding set. PASS/BLOCKED is terminal: no agent mention,
no Lead return, no replay if already published; control returns to Product
Owner. STOP.

## Spec Kit — Converge

After authorized implementation scopes are complete, reconcile Spec Kit delivery artifacts with actual delivered state without changing canonical business authority. Report and STOP.

## Blueprint Conflict

STOP. Identify the exact conflict with Product Owner/Blueprint/Feature Brief/canonical rule. Do not silently edit authority. Request Human Gate.

## AGY Resume / Retry Guard

A provider stream interruption is ambiguous completion. Before repeating any
comment, mention, assignment, status change, commit, push, or other external
side effect, inspect current server-side state. Never replay an existing
transition. If safe at-most-once behavior cannot be established, STOP for Human
intervention.

Multica implementation issues remain Human-owned or unassigned between agent
runs; do not rely on a persistent agent assignee as an implicit router.

## Multica Structured Mentions

Use exact structured mention markdown only:

- `[@agy-lead-reviewer](mention://agent/a299846c-c6ad-45b0-a190-cb802a44caec)`
- `[@agy-developer](mention://agent/450509d9-bea0-4d4e-a360-c484bfe93a37)`
- `[@agy-independent-reviewer](mention://agent/cb25c497-7933-4c9b-9263-f914bb726a2e)`

Plain `@name` and `mention://agent/<name>` are not valid triggers.

## Daemon-Managed Run Guard

Do not start/restart the host daemon from inside a run. If runtime-managed
repository checkout fails, return BLOCKED; do not hide the failure with an
unmanaged manual clone into scratch.
