# AGENTS.md — AGY Project Adapter

## Default Roles

This project uses three role-separated Multica agents after the Human Gate:

- `agy-lead-reviewer` — Lead Orchestrator / Planner
- `agy-developer` — Implementation Author
- `agy-independent-reviewer` — Independent Reviewer

The Product Owner remains final authority.

## Shared Authority

All roles MUST respect, in order:

1. explicit current Product Owner decision
2. `BLUEPRINT.md` v1.0.2 FROZEN
3. active Feature Brief
4. canonical Business Rules
5. `TECHNOLOGY.md` v1.0.1 for technical direction
6. Constitution
7. active Spec Kit artifacts
8. exact authorized Multica task/scope

Lower-level artifacts MUST NOT silently redefine higher authority.

## External Documentation and Context7

For current or version-sensitive behavior of frameworks, libraries, SDKs, APIs,
database tooling, container tooling, and developer tooling, agents MUST verify
the relevant documentation instead of relying on model memory.

Use the configured Context7 MCP as the first documentation source when it
supports the relevant technology.

- The repository-local MCP definition is `.agents/mcp_config.json`; the expected
  server name is `context7`. This is used by direct Antigravity CLI sessions
  whose active workspace root is this repository.
- Multica launches Antigravity from its orchestration work directory and exposes
  the repository as an added directory. In that topology, repository-local MCP
  discovery is not sufficient. The `multica-agent` runtime MUST also provision
  the same `context7` server globally at
  `~/.gemini/config/mcp_config.json`. For headless Multica execution, prefer the
  standard `https://mcp.context7.com/mcp` endpoint; OAuth is not the runtime
  baseline because it requires interactive authorization state.
- The global runtime MCP file is host-local configuration and MUST NOT contain
  committed credentials or be copied into this repository. If a Context7 API
  key is used, provide it only through host-local headers/secret configuration.
- Resolve documentation for the actual library/tool and exact version relevant
  to the approved plan, manifest, lockfile, or authorized task.
- Use Context7 to verify supported APIs, configuration, compatibility,
  migration behavior, and current usage patterns before implementing or making
  version-sensitive technical decisions.
- If Context7 is unavailable, incomplete, or cannot establish the required
  fact, use authoritative first-party upstream documentation or authoritative
  package metadata and report the fallback source.
- Context7 and external documentation are technical evidence, not Product
  authority. Product Owner decisions, Blueprint, Technology Direction,
  Constitution, and approved Feature artifacts remain authoritative.
- When a decision materially depends on version-specific external behavior,
  record the verified conclusion and relevant version/source in implementation
  or review evidence.
- If verified upstream behavior conflicts with an approved Plan or task, STOP
  and surface the conflict instead of silently substituting a dependency,
  workaround, or architecture.


## Exact Multica Mention Targets

Agent-to-agent execution triggers MUST use Multica structured mention markdown
with the exact agent UUID. Plain `@name` text and name-based
`mention://agent/<name>` links are not valid execution triggers.

Canonical role mentions:

- Lead: `[@agy-lead-reviewer](mention://agent/a299846c-c6ad-45b0-a190-cb802a44caec)`
- Developer: `[@agy-developer](mention://agent/450509d9-bea0-4d4e-a360-c484bfe93a37)`
- Independent Reviewer: `[@agy-independent-reviewer](mention://agent/cb25c497-7933-4c9b-9263-f914bb726a2e)`

Do not synthesize a mention URI from the display name. If the target UUID cannot
be verified, STOP instead of posting a non-triggering handoff.

- Every trigger/handoff comment MUST contain exactly one executable structured agent mention.
- Never include a downstream agent structured mention in the same comment, even as an example, quoted instruction, or future-step template.
- Human → Lead comments mention only Lead; Lead → Developer comments mention only Developer; Developer → Reviewer comments mention only Reviewer.

## Shared Invariants

- Developer != Reviewer.
- Lead does not implement and does not review the delegated result.
- Reviewer independently inspects repository evidence.
- One bounded authorized scope at a time.
- No silent scope expansion.
- No speculative infrastructure.
- No automatic Blueprint edits.
- Rootless Podman is the local application runtime baseline.
- Git/Spec Kit/Multica/AGY stay on the host.
- No commit/push/merge/deploy unless explicitly authorized.
- Report and STOP after the role's assigned action.
- Agent-to-agent handoffs are at-most-once external side effects.
- A resumed/retried run MUST inspect current server-side issue/comment state before
  repeating any comment, mention, assignment, status change, commit, push, or
  other externally visible action.
- A stream interruption is an ambiguous-completion event: never assume an
  external side effect failed merely because the local provider stream failed.
- The same transition key
  `{task-or-scope, candidate-or-baseline, from-role, to-role}` MUST NOT trigger
  the downstream agent more than once.
- Multica implementation issues MUST NOT retain an agent assignee as an implicit
  routing target while the role chain is in progress. Use explicit role
  transitions; keep the issue Human-owned or unassigned between agent runs.
- Reviewer `PASS` and `BLOCKED` are terminal for automation: no agent mention,
  no redelegation, and no automatic return to Lead. Control returns to the Human
  Product Owner.
- If safe at-most-once behavior cannot be established from server-side evidence,
  STOP and require Human intervention instead of replaying the action.
- Inside a daemon-managed Multica task, do not treat `multica daemon status` as
  authoritative host-daemon state and do not attempt to start/restart the host
  daemon from the task.
- If runtime-managed repository checkout is unavailable or `multica repo checkout`
  fails inside the task, STOP/BLOCK rather than bypassing the runtime with an
  ad-hoc manual `git clone` into scratch or another unmanaged path.

See `MASTER-PROMPT.md`, `MULTICA.md`, and `REVIEWER.md` for workflow details.

## Multica Ownership Boundary

Issue assignment is Human-only orchestration control.

- Agents MUST NOT run `multica issue assign` to assign or unassign themselves,
  another agent, a squad, or a member.
- Agents MUST NOT claim persistent issue ownership as part of starting,
  continuing, reviewing, retrying, or recovering a task.
- Human-triggered implementation chains SHOULD begin with the issue unassigned
  (or Human-owned where supported) and use exactly one structured mention per
  transition.
- Before any agent-to-agent handoff, inspect current issue state. If the issue
  is assigned to an agent, STOP and return `BLOCKED` for Human correction;
  do not hand off while persistent agent ownership remains.
- Status changes do not imply ownership and MUST NOT be paired with an
  assignment operation by an agent.

## Stream-Interruption Recovery Guard

A provider/stream interruption is ambiguous completion, never proof that the
previous external action failed.

On any run whose trigger, context, or history mentions an interruption,
continuation, retry, replay, or prior failed run, the agent MUST inspect
server-side state before any externally visible action:

1. `multica issue get <issue>`
2. `multica issue comment list <issue>` including the relevant thread
3. `multica issue runs <issue> --full-id`
4. `multica issue timeline <issue> --full-id`

The agent MUST then determine whether the exact transition/result already
exists. If an existing comment, trigger, delegated child run, implementation
result, reviewer verdict, commit SHA, or other server-side evidence proves the
transition happened, the agent MUST NOT repeat the comment, mention,
delegation, status change, commit, push, or other side effect.

In particular:

- Lead MUST NOT redelegate merely because a Developer run ended with
  `The stream was interrupted`.
- Developer MUST NOT republish an `IMPLEMENTATION_RESULT` or Reviewer handoff
  already present for the same candidate.
- Reviewer MUST NOT republish PASS/BLOCKED for the same candidate, and MUST NOT
  re-trigger Lead after a terminal verdict.
- If server-side evidence is insufficient to establish safe at-most-once
  behavior, STOP and return `BLOCKED` for Human inspection instead of replay.
