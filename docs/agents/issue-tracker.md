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
- For a create/edit/comment action, write the exact UTF-8 body to a task-local
  file and use `--body-file`. Preserve actual newlines.
- Use an approved parent specification and bounded child tickets. Each child
  references the approved specification revision, applicable rule IDs,
  acceptance criteria, agreed test seams and genuine blocking dependencies.
- Verify native sub-issue and dependency support when publication is authorized.
  Use native relationships if available; otherwise record explicit `Part of` and
  `Blocked by` references. Native dependency operations use the blocker database
  ID, not its issue number. Do not invent tracker IDs.
- **PRs as a request surface: no.**

## Product Owner decisions

- Record each Product Owner decision on the issue it decides, as a comment, when
  it is made: what was decided, the Product Owner's words quoted, and the date.
  When the Product Owner picks an offered option, quote the option too: it is
  the scope they agreed to.
- Cite that record in commits, pull requests and results.

## Pull requests

- A pull request body fills `/pr`'s template (Summary, Evidence, Merge Danger).
  Its Evidence holds the exact results of the checks run at the head
  (`CLAUDE.md`, Checks) and the `code-review` findings, reported as
  self-review.
- Avoid issue-closing keywords in commits and pull requests; close an issue on
  the Product Owner's word.

## Labels

Triage role labels are mapped in `docs/agents/triage-labels.md`. No label,
including `ready-for-agent` or `ready-for-human`, and no assignment or resolved
blocker grants execution authority. Review any further labels required for
authorized specification/ticket publication at that gate.
