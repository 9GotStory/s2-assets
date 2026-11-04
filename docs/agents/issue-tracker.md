# Issue tracker: GitHub

Feature 002+ specifications and delivery tickets live in GitHub Issues for
`9GotStory/s2-assets`, which also record Product Owner decisions. Use `gh` with
`--repo 9GotStory/s2-assets` explicitly. Keep reciprocal issue references; do
not duplicate whole trackers or introduce a review ledger.

## Reading and publication

- Read an issue and its comments with
  `gh issue view <number> --repo 9GotStory/s2-assets --json number,title,body,labels,comments`.
- List relevant issues with `gh issue list` and narrow state/label filters.
- Publish a specification or ticket only after Product Owner approval. A skill's
  default publication step does not grant that approval.
- For an authorized create/edit/comment action, write the exact UTF-8 body to a
  task-local file and use `--body-file`. Preserve actual newlines.
- Use an approved parent specification and bounded child tickets. Each child
  references the approved specification revision, applicable rule IDs,
  acceptance criteria, agreed test seams and genuine blocking dependencies.
- Verify native sub-issue and dependency support when publication is authorized.
  Use native relationships if available; otherwise record explicit `Part of` and
  `Blocked by` references. Native dependency operations use the blocker database
  ID, not its issue number. Do not invent tracker IDs.
- **PRs as a request surface: no.**

## Product Owner decisions

- Product Owner decisions (approval, authorization, acceptance, merge,
  deployment) are recorded on the relevant issue, in its body or a comment.
  Cite that record in every handoff and result.
- A decision given only in a Claude Code session is current authority for that
  session; cite it as in-session and report its issue record as pending.
- Post a result, review or decision comment only when the Product Owner
  authorizes that comment.

## Execution and acceptance

- Matt Pocock Skills define engineering workflow; they do not authorize actions
  beyond the active Product Owner decision and bounded handoff (`AGENTS.md`).
- A label, assignment or resolved blocker is not implementation authorization.
- Work starts from a Product Owner handoff, never from tracker availability.
- Within an approved bounded task, corrective rounds need no new Product Owner
  approval; scope expansion does.
- Preserve separate implementation, Independent Review in a separate Claude Code
  session and Product Owner acceptance. Author self-review replaces none of
  those gates.
- No automatic issue closure, merge, deployment or adjacent task execution.
  Avoid automatic issue-closing directives. Product Owner separately authorizes
  acceptance, closure, integration, scope expansion and destructive operations.
- Follow Constitution v6.0.0, `AGENTS.md` and the active GitHub Issue for the
  workflow and bounded authorization. Setup and the amendment do not authorize
  `to-spec`, ticket publication or implementation.

## Labels

Triage role labels are mapped in `docs/agents/triage-labels.md`. No label,
including `ready-for-agent` or `ready-for-human`, grants execution authority.
Review any further labels required for authorized specification/ticket
publication at that gate.
