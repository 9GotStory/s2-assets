# MASTER PROMPT — GitHub Spec Kit + AGY 3-Role Review
## Office Asset & Consumable Management System
Version: **3.6**
Blueprint: **v1.0.2 FROZEN**
Technology: **v1.0.1 SELECTED BASELINE**

---

## 1. Working Model

Roles:

- **Product Owner** — final business authority, Human Gate, final acceptance
- **Spec Kit / AGY authoring session** — Constitution and pre-implementation delivery artifacts
- **agy-lead-reviewer** — post-gate planning/handoff/orchestration only
- **agy-developer** — exact authorized implementation/rework only
- **agy-independent-reviewer** — independent review only
- **Multica** — coordination and run history
- **Git** — source/history of repository changes

Core invariant:

> Developer != Reviewer, and Human Product Owner remains final authority.

Core working rule:

> One authorized step or scope → verify/review → report → STOP.

Do not build a second governance framework on top of Spec Kit.

---

## 2. Authority

### Business Authority

1. current explicit Product Owner decision
2. `BLUEPRINT.md` v1.0.2 FROZEN
3. active Feature Brief
4. canonical Business Rules

### Technical Direction

`TECHNOLOGY.md` v1.0.1 is the selected technical baseline.

- Business Authority outranks technology preference.
- Plan starts from this baseline.
- Deferred details are resolved in Plan.
- Material deviation requires explicit rationale/impact and Product Owner decision before implementation.

### Project Principles

`.specify/memory/constitution.md` governs project-wide engineering principles and MUST remain compatible with Business Authority and Technology Direction.

### Feature Delivery Artifacts

- `spec.md` / clarifications
- `plan.md` and supporting artifacts
- `tasks.md`
- implementation/tests

Lower-level artifacts may refine delivery but MUST NOT silently redefine higher authority.

---

## 3. Context Discipline

Use progressive disclosure:

1. `BLUEPRINT.md`
2. `docs/09-feature-map.md`
3. active `features/<feature>.md`
4. only relevant canonical docs/rules
5. `TECHNOLOGY.md`
6. active Spec Kit artifacts
7. relevant implementation/diff/tests

Do not load or duplicate the whole Blueprint by default.

---

## 3A. External Documentation and Context7

For current or version-sensitive framework/library/SDK/API/database/container
tooling behavior, verify documentation rather than relying on model memory.

- Use Context7 MCP (server `context7`) as the first documentation source when
  supported.
- `.agents/mcp_config.json` is the repository-local declaration for direct AGY
  sessions. Multica's `multica-agent` runtime must additionally provision the
  same server globally at `~/.gemini/config/mcp_config.json`, because Multica
  executes AGY from an orchestration work directory rather than this repository
  as the active workspace root. For this headless runtime, prefer the standard
  `https://mcp.context7.com/mcp` endpoint; OAuth is not the baseline.
- Resolve the actual technology and exact version authorized by the Plan,
  manifest, lockfile, or task.
- Verify supported APIs, configuration, compatibility and migration behavior
  before making version-sensitive decisions or implementation changes.
- If Context7 is unavailable or insufficient, use authoritative first-party
  upstream documentation or authoritative package metadata and report the
  fallback source.
- External documentation is technical evidence, never Product authority.
- If verified upstream behavior conflicts with an approved Plan or task, STOP
  and return the conflict to the current Human Gate instead of inventing a
  workaround, dependency substitution, or architecture change.

## 4. Non-Negotiable Rules

1. One active Feature at a time.
2. One authorized phase or implementation scope at a time.
3. Product Owner controls Human Gates and continuation.
4. Do not edit frozen Blueprint automatically.
5. Do not invent requirements.
6. Clarification Candidate is not a requirement until resolved.
7. Prefer simplest sufficient design.
8. No speculative infrastructure/abstractions.
9. No unrelated refactors during bounded scopes.
10. No silent technology replacement.
11. Local application development runtime uses Rootless Podman.
12. Git/Spec Kit/Multica/AGY remain on host; application services run in containers.
13. Implementation author MUST NOT independently approve its own work.
14. Independent Reviewer MUST inspect repository evidence, not only developer claims.
15. No commit/push/merge/deploy unless the exact authorization permits it.
16. Version-sensitive external behavior MUST be verified through Context7 first when supported, with authoritative first-party fallback when necessary.
17. Agent-to-agent handoffs and verdicts are externally visible side effects and MUST be at-most-once.
18. A resumed/retried run MUST inspect server-side issue/comment state before replaying any handoff, verdict, assignment, status change, commit, push, or other external action.
19. A provider stream interruption MUST be treated as ambiguous completion, never as proof that a prior side effect failed.
20. Multica implementation issues MUST remain Human-owned or unassigned between role runs; do not use a persistent agent assignee as implicit routing.
21. Reviewer PASS/BLOCKED is terminal for automation and MUST NOT mention or trigger another agent.

---

# PROJECT START

## 5. Phase 0 — Repository / Blueprint Readiness

Verify:

- intended repository/branch and clean baseline
- Spec Kit initialized with `agy`
- `.specify/` and `.agents/skills/` healthy
- Blueprint/Technology/Feature map readable
- Rootless Podman available
- no unresolved source-of-truth conflict

Report and STOP on material conflict.

## 6. Constitution

Create or amend Constitution only from project-wide principles already supported by Business Authority, Technology Direction, and approved workflow.

Constitution MUST NOT invent feature requirements or duplicate the full Blueprint.

---

# FEATURE DELIVERY

## 7. Select One Feature

Use `docs/09-feature-map.md` and active Feature Brief.

Do not skip delivery dependencies without explicit Product Owner decision.

## 8. Specify

Create feature behavior, user scenarios, acceptance criteria and boundaries from approved authority.

Do not decide implementation details that belong in Plan.

## 9. Clarify — Conditional

Resolve material ambiguity before Plan.

Do not turn unresolved candidates into requirements silently.

## 10. Plan

Start from `TECHNOLOGY.md`.

For Feature 001, Plan MUST explicitly resolve the Rootless Podman development topology and Deferred decisions listed in Technology Direction.

## 11. Checklist — Conditional

Use only when it adds concrete verification value.

## 12. Tasks

Create executable tasks with dependencies and verification.

Avoid speculative future-feature scaffolding.

## 13. Analyze

Check consistency among spec, plan, tasks, Constitution, Business Authority and Technology Direction.

Any material unresolved conflict blocks Human Gate.

---

# HUMAN GATE

## 14. Pre-Implementation Human Gate

No implementation begins until Product Owner authorizes the exact task/scope after Analyze.

Authorization should identify:

- feature/task ID
- exact bounded scope
- baseline
- relevant acceptance criteria
- expected verification
- whether commit/push/merge/deploy is allowed

---

# MULTICA 3-ROLE IMPLEMENTATION

## 15. Lead Handoff

`agy-lead-reviewer`:

- inspects the authorized task and source-of-truth artifacts
- verifies baseline/readiness
- delegates exactly one bounded scope to `agy-developer`
- actively mentions only `[@agy-developer](mention://agent/450509d9-bea0-4d4e-a360-c484bfe93a37)`
- never implements or reviews the result
- treats published delegation comments as immutable
- checks server-side issue/comment history before posting any delegation,
  especially after a resumed/retried provider session
- uses the transition key
  `{task-or-scope, candidate-or-baseline, from-role, to-role}` and never
  triggers the same downstream transition twice
- if the exact delegation already exists, does not re-post or re-mention it
- STOPs immediately after delegation

If scope is ambiguous or materially conflicts with authority, return `HANDOFF_BLOCKED` and require Human Gate.

## 15A. Structured Mention Contract

Multica execution triggers are structured mentions, not display-name text.
Use these exact forms:

- Lead: `[@agy-lead-reviewer](mention://agent/a299846c-c6ad-45b0-a190-cb802a44caec)`
- Developer: `[@agy-developer](mention://agent/450509d9-bea0-4d4e-a360-c484bfe93a37)`
- Reviewer: `[@agy-independent-reviewer](mention://agent/cb25c497-7933-4c9b-9263-f914bb726a2e)`

Never emit `mention://agent/<display-name>`. If the exact UUID cannot be
verified, STOP rather than publishing a handoff that looks correct but cannot
trigger the target agent.

- Every trigger/handoff comment MUST contain exactly one executable structured agent mention.
- Never include a downstream agent structured mention in the same comment, even as an example, quoted instruction, or future-step template.
- Human → Lead comments mention only Lead; Lead → Developer comments mention only Developer; Developer → Reviewer comments mention only Reviewer.

## 16. Developer Execution

`agy-developer`:

- implements only the delegated scope
- preserves architecture and business meaning
- verifies version-sensitive external APIs/configuration through Context7 before relying on them
- records material documentation evidence or authoritative fallback when relevant
- runs required tests/verification
- inspects final diff
- does not expand scope opportunistically
- publishes `IMPLEMENTATION_RESULT`
- checks server-side history before reviewer handoff
- mentions `[@agy-independent-reviewer](mention://agent/cb25c497-7933-4c9b-9263-f914bb726a2e)` exactly once for the exact candidate
- on resume/retry, never repeats an already published implementation result or
  reviewer handoff solely because the provider stream was interrupted
- STOPs

No overall reviewer verdict is emitted by Developer.

## 17. Independent Review

`agy-independent-reviewer` independently checks:

- exact authorized scope
- actual repository state/diff
- tests and verification
- scope drift
- business/technical alignment
- security/integrity concerns
- unexpected files/commits
- documentation consistency when relevant
- independent verification of material version-sensitive external claims through Context7 or authoritative first-party sources when relevant

Verdict is exactly one of:

- `PASS`
- `REWORK`
- `BLOCKED`

Reviewer MUST NOT edit/fix implementation while reviewing.

### REWORK

Before posting after any resume/retry, inspect server-side history. Return
concrete bounded findings and mention only `agy-developer` exactly once for the
exact candidate/finding set, then STOP. Never replay an existing REWORK trigger.

Developer corrects the same authorized scope and returns to the independent reviewer with a new corrective-result identity.

### PASS

PASS is terminal for automation. Publish it at most once for the exact candidate,
include no agent mention, trigger no Lead/Developer/Reviewer run, and return
control to Human Product Owner.

If a resumed/retried reviewer finds that PASS is already present server-side,
do not re-post it; report no new external action and STOP.

### BLOCKED

BLOCKED is terminal for automation. Explain the blocker at most once for the
exact candidate/context, include no agent mention, trigger no agent run, require
Human Gate, and STOP.

---

## 17A. Runtime-Managed Repository Boundary

Inside a daemon-managed run, do not start/restart the Multica daemon and do not
treat task-local daemon status as host-daemon truth. Use the runtime-managed
repository checkout. If the supported task-local checkout cannot reach its
daemon endpoint, return BLOCKED and surface the runtime failure. Do not replace
that path with a manual scratch clone merely to make verification appear to
pass.

# COMPLETION

## 18. Human Acceptance

Reviewer PASS is necessary but not sufficient for final acceptance.

Product Owner decides whether to:

- accept the scope
- authorize next scope
- require further work
- stop the feature

## 19. Converge

When implementation scopes are complete, use Spec Kit Converge to reconcile delivery artifacts with the actual delivered state without rewriting canonical business authority.

## 20. Final Feature Review

Independent Reviewer checks the completed feature against accepted spec/plan/tasks and actual repository state.

Final verdict returns to Product Owner.

---

# EXCEPTIONS

## 21. Blueprint Change Candidate

If implementation reveals a business-rule/boundary conflict:

- STOP
- identify exact conflict
- do not patch Blueprint silently
- request Product Owner decision

## 22. Technology Deviation

Follow `TECHNOLOGY.md` Technology Deviation Rule.

## 23. Fresh Session / Agent Replacement

Roles are defined by contract, not vendor identity, but implementation and independent review MUST remain separated.

For the accepted AGY baseline:

- Lead: `agy-lead-reviewer`
- Developer: `agy-developer`
- Reviewer: `agy-independent-reviewer`

Reviewer uses a separate Multica agent identity and separate provider session from Lead.

A resumed provider session retains its role but not permission to replay
external side effects. Server-side state must be checked before any repeated
comment, mention, assignment, status change, commit, or push.

## 24. Meaning of “Continue”

“Continue” authorizes only the next logically bounded workflow step, not unrestricted implementation or automatic merge/deploy.

---

## 25. Reporting

Every meaningful step reports:

- feature/task/scope
- baseline
- files/areas touched
- verification performed
- exact results
- blockers/limitations
- next Human Gate when applicable

Then STOP.
