# MULTICA.md — AGY 3-Role Coordination Contract

## Purpose

Multica coordinates authorized implementation work after the Spec Kit Human Gate.

It does not replace Blueprint, Technology Direction, Constitution, Spec Kit artifacts, Git history, or Product Owner decisions.

## 1. Baseline Agents

### agy-lead-reviewer

- Multica role: Lead Orchestrator / Planner
- Model: Gemini 3.1 Pro High
- inspects authorization and delegates one bounded implementation scope
- does not implement
- does not independently review the delegated result

### agy-developer

- Multica role: Implementation Author
- Model: Gemini 3.8 Flash High
- implements/reworks only the authorized scope
- publishes `IMPLEMENTATION_RESULT`
- hands off to independent reviewer

### agy-independent-reviewer

- Multica role: Independent Reviewer
- Model: Gemini 3.1 Pro High
- distinct Multica agent identity
- independent provider session from Lead
- verdict: `PASS`, `REWORK`, or `BLOCKED`

## 2. Native Delegation Chain

```text
Human Product Owner
  → agy-lead-reviewer
  → agy-developer
  → agy-independent-reviewer
  → Human Product Owner
```

No manual trigger is required between correctly routed agent runs.

## 3. Human Gate Semantics

A Product Owner-assigned Multica task created after accepted Spec Kit Analyze is already authorized for inspection, coordination and delegation within its exact scope.

Lead MUST NOT ask for a duplicate approval unless:

- scope is ambiguous
- baseline is invalid
- material authority conflict exists
- destructive/security-sensitive action exceeds authorization
- commit/push/merge/deploy permission is missing but required

## 4. Lead Delegation Rules

Lead MUST:

- identify exact approved task/scope
- inspect relevant source-of-truth artifacts
- verify baseline
- publish exactly one bounded delegation
- actively mention exactly one implementation target: `agy-developer`
- STOP after delegation

### Atomic Delegation

Before publishing, compose and validate the complete delegation.

After publication:

- never edit/delete the delegation comment
- never replace it with another delegation
- never publish a second implementation delegation for the same scope in the same run

Agent mentions are execution triggers and are immutable once published.

Reviewer routing in the Lead comment should be plain text only; Developer performs the active reviewer mention.

## 5. Developer Handoff

Developer result MUST include:

- task/scope ID
- implementation summary
- changed files
- branch/commit/baseline when applicable
- tests and verification
- exact results
- blockers/limitations

Then actively mention `agy-independent-reviewer` and STOP.

On REWORK, correct only cited findings within the same authorized scope and return to the same reviewer role.

## 6. Reviewer Routing

Reviewer:

- inspects actual evidence independently
- never edits production files
- on `REWORK`, mentions only `agy-developer`
- on `PASS`, returns control to Product Owner
- on `BLOCKED`, requires Human Gate

## 7. Issue Strategy

Prefer one Multica Issue per authorized implementation scope when that keeps evidence bounded and reviewable.

A feature may use multiple issues/scopes.

Multica issue state is coordination metadata, not Git/source truth.

## 8. External Documentation / Context7

Context7 is the first documentation source for current or version-sensitive
framework, library, SDK, API, database, container, and developer-tool behavior
when the relevant technology is supported.

The repository-local AGY MCP definition is `.agents/mcp_config.json` with
server name `context7`. It supports direct AGY sessions started with this
repository as the active workspace.

For Multica execution, this is NOT sufficient by itself: Multica starts AGY
from an orchestration work directory and exposes the checked-out repository as
an added directory. Therefore the runtime account (`multica-agent`) MUST also
configure `context7` globally in `~/.gemini/config/mcp_config.json`.
For headless Multica execution, use the standard
`https://mcp.context7.com/mcp` endpoint. OAuth is not the baseline for this
runtime because it depends on interactive authorization state. Optional API-key
headers remain host-local and MUST NOT be committed.

Before beginning a version-sensitive implementation task, runtime readiness
should be demonstrated by a headless Context7 smoke test under the same
`multica-agent` identity used by Multica. If Context7 is unavailable, the
agent may use the documented authoritative first-party fallback but MUST report
that Context7 was unavailable and why.

Role requirements:

- Lead identifies version-sensitive dependencies or APIs that materially affect
  the authorized task and requires documentation verification in the handoff.
- Developer consults Context7 before implementing behavior that depends on
  version-specific external APIs, configuration, compatibility, or migration
  semantics.
- Independent Reviewer re-checks material version-sensitive claims when they
  affect correctness, security, data integrity, or compatibility; reviewer
  must not rely only on the Developer's summary.
- If Context7 is unavailable or insufficient, use authoritative first-party
  documentation or package metadata and report that fallback explicitly.
- External documentation is evidence only and MUST NOT override Product Owner
  decisions, Blueprint, Technology Direction, Constitution, or accepted Feature
  artifacts.
- A verified upstream conflict with an approved Plan/task is a Human Gate issue,
  not permission to silently change dependency, architecture, or scope.

## 9. Git Discipline

- exact baseline must be known
- scope should remain reviewable
- unexpected changes block clean acceptance
- commit/push/merge/deploy occur only when Product Owner authorization permits
- do not use Multica comments as a substitute for repository evidence

## 10. What Multica Must Not Duplicate

Do not create a second copy of:

- Blueprint/business rules
- Feature Briefs
- Constitution
- spec/plan/tasks
- implementation state ledger
- custom approval database

Reference canonical repository artifacts instead.

## 11. Accepted Orchestration Baseline

Accepted on 2026-10-07 by smoke `9GOTSTORY-141`:

- exactly 3 successful role runs
- Lead → Developer → Independent Reviewer
- separate Lead and Reviewer sessions
- no duplicate/self-trigger
- no `cancelled_by_comment_change`
- no repository modifications in smoke
- Reviewer PASS returned to Human Product Owner
