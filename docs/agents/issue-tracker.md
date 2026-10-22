# Issue tracker: GitHub

Feature 002+ specifications and delivery tickets live in GitHub Issues for
`9GotStory/s2-assets`. Use `gh` with `--repo 9GotStory/s2-assets` explicitly.
Multica remains authoritative for Product Owner authorization, agent
coordination, delegation, execution runs and Lead review. Keep reciprocal issue
references; do not duplicate whole trackers or introduce a review ledger.

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

## Execution and acceptance

- Matt Pocock Skills define engineering workflow; they do not authorize actions
  beyond the active Product Owner decision and bounded Multica handoff.
- A label, assignment or resolved blocker is not implementation authorization.
- Do not auto-claim or dispatch work from tracker availability. Lead–Developer
  handoffs, result return and corrective rounds remain Multica operations.
- Once a bounded task is approved, normal handoffs and corrections within that
  scope do not require repetitive Product Owner intervention.
- Preserve separate implementation, Lead review, ChatGPT Independent Review and
  Product Owner acceptance. Developer self-review replaces none of those gates.
- No automatic issue closure, merge, deployment or adjacent task execution.
  Avoid automatic issue-closing directives. Product Owner separately authorizes
  acceptance, closure, integration, scope expansion and destructive operations.
- Follow Constitution v5.0.0, `AGENTS.md` and the active Multica issue for the
  feature-scoped workflow, approved route and bounded authorization. Setup and
  the amendment do not authorize `to-spec`, ticket publication or implementation.

## Labels

The triage skill is not installed. Do not create its label set, an Agent skills
Triage labels block or `triage-labels.md` as part of this setup. Review any labels
required for later authorized specification/ticket publication at that gate;
labels never grant execution authority.
