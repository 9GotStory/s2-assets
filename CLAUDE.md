# CLAUDE.md — s2-assets

Office Asset & Consumable Management System (ระบบครุภัณฑ์สำนักงานและวัสดุสิ้นเปลือง): a
TypeScript pnpm workspace with a React 19 web app (`apps/web`), a Fastify 5 REST API
(`apps/api`) and PostgreSQL 18 through Kysely (`packages/db`). This file is the repository's
only rules file. Claude Code develops; the Product Owner decides.

## Authority

Higher sources win; a lower source never silently overrides a higher one.

1. Product Owner decisions, recorded on GitHub Issues (`docs/agents/issue-tracker.md`).
2. `BLUEPRINT.md` v1.0.2, frozen.
3. The active Feature Brief in `features/`.
4. The canonical Business Rules in `docs/06-business-rules.md`.
5. `TECHNOLOGY.md` v1.2.0, the selected technical baseline.
6. Approved specifications, decisions and tickets in the issue tracker.
7. Code, tests and evidence.

Changing the Blueprint, the Business Rules, the technical baseline, a feature's scope or this
file's rules needs a Product Owner decision; a material technology deviation also follows the
deviation process in `TECHNOLOGY.md`. When two sources conflict, stop at that boundary and ask
the Product Owner.

Git history, removed files and old branches are records, never requirements: consult them only
for provenance or forensics.
- `specs/001-application-foundation/` is the record of Feature 001, written in the retired Spec
  Kit format; all 46 of its tasks are done.
- Spec Kit, its Constitution (last 6.0.0) and `AGENTS.md` were retired on 2026-11-04 (#36).
  Mentions of them, and of Multica, AGY, the DEV Executor and the Independent Reviewer, in
  `BLUEPRINT.md`, `TECHNOLOGY.md`, `docs/`, `features/` and the Feature 001 artifacts describe
  earlier delivery: they select no tool, role or workflow for new work, and the business and
  technical content around them still binds.

## Workflow

Work follows Matt Pocock's skills (`mattpocock/skills`) and their main flow:

`/grill-with-docs` → `/prototype` when a question needs running code → `/to-spec` →
`/to-tickets` → `/implement` per ticket (or `/implement-spec`), which drives `/tdd` and closes
with `/code-review` → `/pr` → `/retro`.

- **On-ramps:** `/triage` for incoming issues, `/diagnosing-bugs` for hard bugs, `/wayfinder` for
  an effort too big for one session. `/ask-matt` routes when the fit is unclear.
- **Start:** work starts from a Product Owner decision: a slash command they run (such as
  `/implement <issue>`) or an instruction in the session. Finishing one task does not start the
  next. Labels, assignments and tracker state never authorize work, and nothing is dispatched or
  claimed automatically. Reuse approved specifications and tickets; revise one only at the
  Product Owner's request.
- **Scope:** an authorized ticket covers its own fixes, tests, refactors and re-reviews. Ask the
  Product Owner before new scope (publishing a specification or ticket included), an
  architecture change, a destructive or sensitive operation, production deployment or runtime
  provisioning, or a security exception. Close an issue only on their word. When authority,
  scope or the baseline is materially unclear, ask them; report a failed checkout, runtime or
  skill invocation exactly as it happened.
- **Review:** report self-review as self-review; a Claude Code session or subagent is never an
  independent reviewer. When a review's fixes change more than 200 lines, run `/code-review` over
  those fixes too.
- **Acceptance:** evidence-based (passing checks, runtime evidence where the change needs it),
  then the Product Owner's acceptance. Claude Code's own review verdict is never acceptance.
- **Merges:** GitHub `9GotStory/s2-assets` is the source of truth. Each feature has one
  integration branch, branched from `main` when the feature starts and named
  `feature/<NNN>-<slug>` after its row in `docs/09-feature-map.md` (for example
  `feature/003-asset-assignment-movement`). Branch each task from its feature's integration
  branch and target its pull request there. When a pull request stays in scope and its checks
  pass, merge it yourself:
  - run `gh pr merge <n> --repo 9GotStory/s2-assets --merge --match-head-commit <headRefOid>`
    as a standalone command;
  - then fetch and confirm that the merge commit's second parent is `<headRefOid>` and that
    `git diff --stat <merge>^1 <merge>` lists exactly the pull request's files.

  A feature the Product Owner has not accepted goes into `main` only on their word.

## Checks

`.github/workflows/ci.yml` defines the checks, and its `ci-gate` job names the jobs that must
pass. On a pull request, CI also runs `git diff --check` and `scripts/check-glossary.sh` against
the base. Locally, run each job through its script in `scripts/ci/`, `security-scan.sh` included,
before pushing, so that a finding reaches the Product Owner with the ticket's other decisions.
When CI does not run on a pull request, run each job locally and record each job's exact result
in the pull request: that record is the pull request's check. A change
that touches only documentation needs only `git diff --check <base>...HEAD`, where `<base>` is the
integration-branch commit the task started from.

## Agent skills

### Issue tracker

GitHub Issues of `9GotStory/s2-assets`, through the `gh` CLI. See `docs/agents/issue-tracker.md`,
also for pull request bodies.

### Triage labels

The five default labels. See `docs/agents/triage-labels.md`.

### Domain docs

One shared domain context over the existing canonical documentation. See `docs/agents/domain.md`.

## Current documentation (Context7)

Model memory goes stale. Verify version-sensitive behavior of frameworks, libraries, SDKs, APIs,
databases and container tooling before relying on it:

- **Context7 MCP first:** resolve the actual technology at the version the manifests pin
  (`package.json` files, `pnpm-lock.yaml`, the Containerfiles). Where Context7 lacks the
  technology or the fact, use first-party upstream documentation or package metadata, and say so.
- **Pinned versions:** use the versions the manifests pin; upgrading or substituting a
  dependency needs the Product Owner's approval.
- **Capability versus requirement:** documentation tells what a technology can do; the sources
  under Authority decide what s2-assets must do. When verified behavior contradicts approved
  authority, surface the conflict instead of working around it.
- **Recording:** record a version-specific conclusion that a decision rests on, with its version
  and source, in the spec, ticket or pull request.

## Engineering principles

- **Feature-bounded and simple.** Work one active feature at a time, within the boundaries and
  dependencies of `docs/09-feature-map.md`. Build only what current requirements need, following
  `Simple — Structured — Sustainable`: speculative architecture needs a current business
  requirement. `application-foundation` is a technical bootstrap exception, never a generic
  shared-framework catch-all.
- **Rootless Podman.** Normal local application services and infrastructure dependencies run in
  Rootless Podman; Git repositories, worktrees and engineering workflow tooling, Claude Code CLI
  included, stay on the Fedora host. Containers stay OCI-portable, and application code never
  couples to Podman APIs. Quadlet is the production service-management baseline; local
  development orchestration, including any use of Quadlet, follows `TECHNOLOGY.md`. Where it
  marks a development detail Deferred, the feature's specification decides it.
- **Server-side security and data integrity.** Authorization is authoritative server-side and
  fails closed; frontend validation is never authoritative for business invariants. PostgreSQL
  constraints and transactions are part of the integrity boundary where they apply. Business
  data is never fabricated to satisfy validation or tests, and business audit/history stays
  distinct from operational logging. Secrets stay outside the repository and out of output and
  evidence.
- **Verification against real invariants.** Tests put business invariants before implementation
  details and never weaken or redefine accepted business semantics. PostgreSQL transaction and
  concurrency semantics that matter in production are verified against real PostgreSQL, not
  database mocks alone. Size verification to the scope: lint, typecheck, unit, integration,
  browser/E2E, migration, security or container checks as they apply.

## Runtimes

**Development: one runtime.** The UID-1000 rootless Podman + user systemd Quadlet runtime, with
the Web at `http://127.0.0.1:5180` and the API at `http://127.0.0.1:3010`; its contract and
commands are in `docs/operations/development-runtime.md`.
- **Source:** a commit reaches the runtime only through
  `~/dev/s2-assets-quadlet/scripts/dev-runtime-update.sh --sha <commit>`, which backs up the
  database first; `--no-backup` belongs to the doc's rollback and restore procedures alone.
  Promoting a merged commit is development work. Read results only against the commit
  `dev-runtime-verify.sh` reports.
- **Accounts:** creating a development login needs a Product Owner decision.
- **Data:** a task cleans only what it created. UID 1000's Podman also holds other projects'
  units, images and volumes, among them Songhealth's accepted production image
  `localhost/songhealth-app:0.0.1`, which no rebuild reproduces: keep every `podman … prune`
  command off this host user. The rollback, the restore and `dev-runtime-uninstall.sh --purge`
  replace or delete the development database and need a Product Owner decision.

**Production.** Rootless Podman + systemd Quadlet as `TECHNOLOGY.md` defines; its units in
`deploy/podman/quadlet/` are a separate target from the development runtime.
