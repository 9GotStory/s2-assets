# Implementation Plan: application-foundation

**Branch**: `feature/001-application-foundation` | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)

## Summary

This plan establishes the explicit, feature-bounded project technical baseline. It resolves the Product Owner's `LOCAL_CREDENTIALS` decision, implements strict server-side capability checking, pins exact dependency versions as of 2026-10-07, establishes deterministic `podman-compose 1.6.0` orchestration, and sets up real PostgreSQL Rootless Podman integration testing without speculative frameworks.

## Technical Context

**Language/Version**: Node.js 24.21.0 LTS, TypeScript 6.0.3

**Primary Dependencies**: React 19.3.0, Vite 8.3.3, Fastify 5.12.5, Kysely 0.29.6, Zod 4.6.5, @fastify/type-provider-zod 1.0.0

**Storage**: PostgreSQL 18.6 (`pg` 8.23.1)

**Testing**: Vitest 5.0.3, Playwright 1.63.0

**Target Platform**: Rootless Podman via `podman compose` (using `podman-compose 1.6.0` provider), OCI-compatible containers via Quadlet (Production)

**Project Type**: Monorepo (pnpm workspace 12.9.1)

**Constraints**: Configuration fails closed; Authorization fails closed and evaluates per request; Rootless Podman is the runtime baseline; No outer-transaction rollback masks for concurrency testing.

## Traceability Matrix

| Requirement | Plan Component | Verification Path | Unresolved Dependency |
|---|---|---|---|
| **FR-001** (Session/Local Auth) | `argon2` 0.45.1, secure opaque token digest in DB, `SameSite: Lax` | Unit/E2E test evaluating session creation/expiration | None |
| **FR-002** (Fail-closed Auth) | Middleware evaluates current active-user + code-mapped capability per request | Integration tests verifying immediate revocation effect | None |
| **FR-003** (Audit Context) | Explicit `AuditContext` type (`actor`, `action`, `recorded_at`) | Typecheck and unit tests passing context to mock domain logic | None |
| **FR-004** (Config Fail-closed) | Zod schema validation at startup, Pino redaction | Unit tests verifying boot panic on missing ENV and redacted logs | None |
| **FR-012** (DB Unavailability) | `/ready` gates on DB, HTTP 503 on lost connection | Integration tests dropping DB network | None |
| **FR-005** (Rootless Podman) | `compose.yaml` (Compose Spec) run via `podman-compose 1.6.0` provider | Quickstart verification | None |
| **FR-006** (Real PG Tests) | Real `postgres:18.6-alpine` container without transaction-masking for concurrency | Integration tests executing against container DB | None |
| **FR-007** (No Speculative Infra) | Only `users`, `sessions`, `roles`, `user_roles` modeled. No generic workflow/audit tables | Code review / Analyze phase | None |
| **FR-008** (No Fabricated Data) | Factories create logically sound users | DB constraints enforced in tests | None |
| **FR-009** (Server Authoritative) | Auth middleware enforced at Fastify router level | Integration tests attempting bypass | None |
| **FR-010** (Atomic Transactions) | Explicit Kysely transactions for domain mutations | Integration tests verifying rollback state | None |
| **FR-011** (Error Contract) | `api-error.md` contract, standardized error handler | Unit tests checking payload structure | None |
| **SC-001** (100% Protected) | Global route auth enforcement | Integration test suite | None |
| **SC-002** (Reproducible Podman) | `compose.yaml`, `keep-id`, runnable Fastify/Vite entrypoints and development startup commands | Boot API/Web/PostgreSQL and verify login/logout in the rootless development stack | T041–T044 (previously missing from task coverage) |
| **SC-003** (Integration Safe Tests)| Unmasked PostgreSQL tests | CI pipeline | None |
| **SC-004** (Audit Primitive) | `AuditContext` passed explicitly | Integration tests | None |
| **SC-005** (Zero Frameworks) | Verified explicitly during planning | Manual Review | None |

## Bootstrap Gap Reconciliation — Proposed 2026-10-14 (Human Gate Pending)

**Evidence / reason:** FR-005, US4 acceptance scenario 1 and SC-002 already require an actually runnable API, Web and PostgreSQL development stack. The original T001–T040 decomposition built packages, plugins, React pages, Compose services and Playwright config, but did not task an API application entrypoint, a web SPA entrypoint/router, or executable development service commands. Current `apps/api/src` has no server/app composition entrypoint; `apps/web/src` contains page components only; Compose has no application commands. Therefore T033 browser E2E is blocked even though T031/T032 were accepted individually. This is a **task/plan omission**, not a change to the authoritative Spec, Blueprint or stack.

**Corrective scope (existing requirement coverage only):**

1. **T041 — Fastify application composition and startup:** A minimal testable app factory and bounded server entrypoint register the accepted configuration, logger/error handler, auth, CSRF, authorization and approved routes in secure order. Boot fails closed on invalid configuration; no new auth protocol, auto-migration, global framework or domain logic. Add only required scripts and focused verification.
2. **T042 — Vite/React SPA bootstrap:** Add the minimum HTML entrypoint, React root/router, TypeScript/Vite setup and strictly necessary pinned dependencies/scripts to render existing T031 Login/Dashboard. Route navigation remains client UX only; backend authorization remains authoritative. Define an explicit **development-only** same-origin API proxy to the existing internal API service if needed; no reverse-proxy product or production web server.
3. **T043 — Executable development services:** Supply explicit API/Web development start commands in existing Rootless Podman Compose/scripts; private PostgreSQL network, container-only runtime, reproducible Node 24.21.0 and pnpm 12.9.1, source mounts and deterministic readiness checks. Avoid exposed LAN endpoints where loopback will suffice; avoid generic orchestration and do not disturb unrelated Fedora containers. Never auto-run schema migration on app startup.
4. **T044 — Real local smoke/prerequisite verification:** Reproduce clean development bootstrap, run explicit database migrations, verify `/health`, `/ready`, `/auth/login`, `/auth/session-check`, protected-route denial and CSRF-aware logout with a test-only identity/credentials handled safely, then clean up *only test-owned* resources. This does not replace actual browser E2E.

**Dependency gate:** T041 and T042 can proceed independently after this reconciliation is approved; T043 requires both; T044 requires T043; **existing T033** then exercises a real browser in isolated `mcr.microsoft.com/playwright:v1.63.0-noble`. Do not mark T033 green on test discovery, mocks or static inspection. Preserve existing T001–T032 and existing T034–T040 identities and scope; do not auto-complete previously accepted tasks.

**Acceptance/traceability:** FR-001 runtime session path, FR-004 secure initialization, FR-005 and SC-002 runnable rootless stack, US4 acceptance scenario 1, and T033 browser test prerequisites map to T041–T044. T039 remains the final full-workspace/Quickstart check. Existing Phase 7 CI, backup and production definitions remain separately gated; this correction does not authorize those tasks or Production deployment.

**Status:** Documentation proposal only; this section does not grant implementation, merge, deployment or runtime changes. A separate Product Owner Human Gate and independent review are required before bounded execution.

## Constitution Check

*GATE: Passed*

1. **Authority Preservation**: Exact versions and the `LOCAL_CREDENTIALS` approach comply perfectly with `TECHNOLOGY.md` and PO decisions.
2. **Feature-Bounded Delivery**: Capability mapping is code-defined to prevent enterprise IAM framework bloat.
3. **Rootless Podman Development**: Strict `compose.yaml` boundary. Postgres is not exposed to host/LAN. Assumes proper unprivileged permissions via `userns=keep-id`.
4. **Server-Side Security**: Local credentials hashed via `argon2`. Session stores SHA-256 digests only and doesn't cache capability state.
5. **Verification Against Real Invariants**: Tests strictly mandate independent connections for concurrency testing, avoiding rollback-masking.
6. **Human-Gated Independent Delivery**: The Plan is complete and awaits tasking.

## Project Structure

```text
s2-assets/
├── apps/
│   ├── api/
│   └── web/
├── packages/
│   └── db/
├── deploy/
│   └── podman/
│       └── compose.yaml
├── pnpm-workspace.yaml
```
