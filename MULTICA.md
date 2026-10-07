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

Agent-to-agent transitions are explicit and at-most-once. Do not use a
persistent agent assignee as an implicit fallback router between roles.

The implementation issue should remain Human-owned or unassigned while the
multi-agent chain is in progress. Starting a role does not grant that role
persistent ownership of later comments.

## 2A. Exact Structured Mentions

All execution handoffs MUST use Multica structured mention markdown with the
exact agent UUID:

- Lead: `[@agy-lead-reviewer](mention://agent/a299846c-c6ad-45b0-a190-cb802a44caec)`
- Developer: `[@agy-developer](mention://agent/450509d9-bea0-4d4e-a360-c484bfe93a37)`
- Independent Reviewer: `[@agy-independent-reviewer](mention://agent/cb25c497-7933-4c9b-9263-f914bb726a2e)`

Plain `@agy-...` text is not a trigger. A link such as
`mention://agent/agy-developer` is also invalid because the target component
must be the exact agent UUID.

Never guess or synthesize mention markdown from a display name.

- Every trigger/handoff comment MUST contain exactly one executable structured agent mention.
- Never include a downstream agent structured mention in the same comment, even as an example, quoted instruction, or future-step template.
- Human → Lead comments mention only Lead; Lead → Developer comments mention only Developer; Developer → Reviewer comments mention only Reviewer.

## 2B. Human-Only Issue Assignment

Issue assignment is Human-only orchestration control.

- No agent may invoke `multica issue assign` for itself or any other target.
- An agent MUST NOT pair task startup with self-assignment.
- The normal chain is driven by single-target structured mentions while the
  issue remains unassigned (or Human-owned where supported).
- Before a downstream handoff, the current agent MUST inspect the issue. If
  `assignee_type=agent`, it MUST STOP/BLOCK for Human correction rather than
  hand off under persistent agent ownership.

## 2C. Interruption/Replay Barrier

A stream/provider interruption is ambiguous completion.

Before any retry, continuation, or recovery action, inspect the server-side
issue, comments/thread, runs, and timeline. Git state alone is insufficient.

For the transition key
`{task-or-scope, candidate-or-baseline, from-role, to-role}`:

- if the handoff comment already exists, do not repost it;
- if a child run already exists for that handoff, do not retrigger it;
- if an implementation result already exists for the candidate, do not
  republish it;
- if a Reviewer PASS/BLOCKED already exists for the candidate, automation is
  terminal and no agent may be triggered afterward.

Lead MUST NOT interpret a Developer stream interruption by itself as authority
to redelegate. If safe at-most-once recovery cannot be established from
server-side evidence, return BLOCKED to the Human Product Owner.

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
- actively mention exactly one implementation target using
  `[@agy-developer](mention://agent/450509d9-bea0-4d4e-a360-c484bfe93a37)`
- STOP after delegation

### Atomic Delegation

Before publishing, compose and validate the complete delegation.

Use the transition key:

```text
{task-or-scope, candidate-or-baseline, from-role, to-role}
```

Before any handoff comment or active mention, inspect current server-side issue
and comment history. If that transition key has already been published, do not
publish or mention it again.

After publication:

- never edit/delete the delegation comment
- never replace it with another delegation
- never publish a second implementation delegation for the same transition key
- never treat a local stream interruption as proof that the server-side
  delegation failed

Agent mentions are execution triggers and are immutable once published.

If a run resumes/retries after an interruption, it MUST verify whether the
handoff already exists before taking any external side effect. If existence
cannot be determined safely, STOP and require Human intervention.

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

Before the reviewer handoff, inspect current server-side issue/comment history
for the exact Developer → Reviewer transition key. If it already exists, do not
mention the reviewer again.

Then actively mention `[@agy-independent-reviewer](mention://agent/cb25c497-7933-4c9b-9263-f914bb726a2e)` exactly once and STOP.

On REWORK, correct only cited findings within the same authorized scope and
return to the same reviewer role using a new corrective-result identity (for
example, a new candidate commit SHA). A resumed run MUST NOT replay the prior
Reviewer handoff.

## 6. Reviewer Routing

Reviewer:

- inspects actual evidence independently
- never edits production files
- checks server-side history before publishing a verdict after any resume/retry
- on `REWORK`, mentions only
  `[@agy-developer](mention://agent/450509d9-bea0-4d4e-a360-c484bfe93a37)`,
  at most once for that exact finding set/candidate
- on `PASS`, publishes the terminal verdict without any agent mention and
  returns control to Product Owner
- on `BLOCKED`, publishes the terminal verdict without any agent mention and
  requires Human Gate
- never re-posts an already published verdict for the same candidate merely
  because the local provider stream was interrupted
- never routes a terminal verdict back to Lead

`PASS` and `BLOCKED` are terminal for automated orchestration.

## 7. Issue Strategy

Prefer one Multica Issue per authorized implementation scope when that keeps evidence bounded and reviewable.

A feature may use multiple issues/scopes.

Multica issue state is coordination metadata, not Git/source truth.

During the role chain, the issue MUST NOT keep an agent as a persistent assignee
or other implicit routing target. Use explicit transitions only. If the runtime
cannot continue without an agent assignee, STOP and require Human/operator
intervention rather than accepting implicit comment routing.

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

## 9A. Daemon-Managed Task Boundary

A Multica/AGY run executes inside a daemon-managed task environment.

- Do not start/restart the host Multica daemon from inside the task.
- Do not use task-local `multica daemon status` as proof that the host daemon is
  stopped.
- Repository access should use the runtime-managed checkout supplied for the
  task or the supported task-local checkout path.
- If `multica repo checkout` cannot reach the task daemon endpoint, treat that
  as a runtime/integration failure and return `BLOCKED`.
- Do not hide such a failure by manually cloning the repository into AGY brain
  scratch, `/tmp`, or another unmanaged directory.

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

A later interrupted-stream incident on T002 demonstrated that successful
provider-side side effects can outlive a failed local stream. The contract now
therefore requires resume-safe, at-most-once handoffs and terminal verdicts.
No role may replay a previously published transition merely to recover from a
stream interruption.
