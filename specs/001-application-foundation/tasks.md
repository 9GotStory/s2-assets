# Tasks: Feature 001 — application-foundation

## Phase 1: Setup
**Purpose**: Project initialization, exact dependency baselines, and development environment.

- [ ] T001 Initialize pnpm 12.9.1 workspace with `pnpm-workspace.yaml` and root `package.json` specifying exact Node.js 24.21.0 version.
- [ ] T002 [P] Create `packages/db/package.json` configuring exact TypeScript 6.0.3, Kysely 0.29.6, and pg 8.23.1.
- [ ] T003 [P] Create `apps/api/package.json` configuring exact Fastify 5.12.5, Zod 4.6.5, `@fastify/type-provider-zod` 1.0.0, `@fastify/swagger` 9.9.1, TypeScript 6.0.3, and Vitest 5.0.3.
- [ ] T004 [P] Create `apps/web/package.json` configuring exact React 19.3.0, Vite 8.3.3, React Router 7.18.4, and TypeScript 6.0.3.
- [ ] T005 [P] Create `deploy/podman/compose.yaml` (Compose Spec) defining `api`, `web`, and a private `postgres:18.6-alpine` database network with a named volume (`postgres-data`). Configure `userns=keep-id` for host mounts.
- [ ] T006 Implement deterministic Compose provider preflight script in `scripts/dev.sh` ensuring `export PODMAN_COMPOSE_PROVIDER=podman-compose` is set and execution fails closed non-zero if `podman-compose 1.6.0` is absent.

---

## Phase 2: Foundational blockers
**Purpose**: Blocking prerequisites including configuration, migrations, error handling, and test harness setup.
**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T007 Implement Kysely explicit migration runner/CLI script in `packages/db/src/migrator.ts`.
- [ ] T008 Create database migration `packages/db/src/migrations/0001_foundation.ts` for users (`id`: UUID Primary Key, `username`: String Unique canonical login identifier, `password_hash`: String Argon2id, `is_active`: Boolean Default true, `created_at`: Timestamp, `updated_at`: Timestamp), sessions (`id`: String SHA-256 Digest of Secure Opaque Token, `user_id`: UUID Foreign Key to `users`, `expires_at`: Timestamp, `created_at`: Timestamp), roles (`id`: String Primary Key explicit identifier e.g., 'ADMINISTRATOR', 'SYSTEM_MAINTAINER', `description`: String), and user_roles (`user_id`: UUID Foreign Key, `role_id`: String Foreign Key).
- [ ] T009 Implement integration test in `apps/api/tests/integration/db.test.ts` to verify migrations apply successfully to a clean real PostgreSQL database.
- [ ] T010 Create unit tests in `apps/api/tests/unit/config.test.ts` verifying missing required configuration is rejected, malformed required configuration is rejected, and the application cannot enter the ready operational path with invalid configuration.
- [ ] T011 Implement Zod-based config loader in `apps/api/src/config/env.ts` that fails closed immediately on missing or malformed required configuration.
- [ ] T012 Create unit tests in `apps/api/tests/unit/logger.test.ts` verifying configured secret fields are redacted and raw secrets do not appear in emitted operational logs.
- [ ] T013 Implement Pino logger with secrets redaction in `apps/api/src/plugins/logger.ts`.
- [ ] T014 Create unit tests in `apps/api/tests/unit/error-handler.test.ts` verifying deterministic machine-readable error code, safe user-facing message, request/correlation ID, minimized validation details, no stack trace leakage, no query/internal implementation leakage, and no secret leakage.
- [ ] T015 Implement standard Fastify error handler conforming exactly to `api-error.md` in `apps/api/src/plugins/error-handler.ts`.

**Checkpoint**: Foundation ready - user story implementation can now begin.

---

## Phase 3: User Story 1 - Session Establishment and Lifecycle (Priority: P1) 🎯 MVP
**Goal**: The system must establish secure sessions using local credentials and deny access on expiration/revocation.
**Independent Test**: Can be tested by logging in via API, receiving a cookie, using it for a subsequent request, and observing rejection after logout.

### Tests for User Story 1
- [ ] T016 [US1] Create integration tests in `apps/api/tests/integration/auth.test.ts` for valid local login, invalid credentials, disabled user, session expiry, session revocation, secure cookie attributes, and CSRF behavior.

### Implementation for User Story 1
- [ ] T017 [US1] Install `argon2` 0.45.1, `@fastify/cookie` 11.1.2, and `@fastify/csrf-protection` 8.0.1 in `apps/api/package.json`.
- [ ] T018 [P] [US1] Implement `UserService` in `apps/api/src/services/user.service.ts` using Argon2id for password hashing and verification.
- [ ] T019 [P] [US1] Implement `SessionService` in `apps/api/src/services/session.service.ts` to generate raw opaque tokens, store ONLY the SHA-256 digest in the database, and enforce an 8-hour expiry.
- [ ] T020 [US1] Implement Fastify Auth plugin in `apps/api/src/plugins/auth.ts` verifying session digests and enforcing `SameSite=Lax`, `HttpOnly`, and `Secure` cookies.
- [ ] T021 [US1] Implement token-based CSRF protection middleware for state-changing requests in `apps/api/src/plugins/csrf.ts`.
- [ ] T022 [US1] Implement Auth REST endpoints (login, logout, session-check) in `apps/api/src/routes/auth.routes.ts`.

---

## Phase 4: User Story 2 - Capability Enforcement (Priority: P1)
**Goal**: The system must enforce server-side authorization mapping roles to capabilities dynamically per request.
**Independent Test**: Assign a capability to a user and observe successful access, then revoke the role and observe immediate rejection on the next protected request.

### Tests for User Story 2
- [ ] T023 [US2] Create integration tests in `apps/api/tests/integration/authorization.test.ts` verifying unauthenticated access is denied, authenticated without capability is denied, authenticated with capability is allowed, and capability revocation is effective on the next request.

### Implementation for User Story 2
- [ ] T024 [P] [US2] Implement code-defined capability mapping logic in `apps/api/src/services/capability.service.ts` to dynamically resolve current roles to capabilities without caching in session.
- [ ] T025 [US2] Implement authorization middleware in `apps/api/src/middleware/authorization.ts` to enforce capabilities authoritatively on protected routes.
- [ ] T026 [US2] Apply authorization middleware to a protected route in `apps/api/src/routes/system.routes.ts` verifying enforcement.

---

## Phase 5: User Story 3 - Traceable Audit and Error Handling (Priority: P2)
**Goal**: Record audit history securely within transaction boundaries and handle missing dependencies/errors safely.
**Independent Test**: Trigger an API action to verify `AuditContext` records, and sever database connectivity to verify `/ready` fail-closed behavior.

### Tests for User Story 3
- [ ] T027 [US3] Create integration tests in `apps/api/tests/integration/transaction.test.ts` using independent real PostgreSQL connections to explicitly prove the accepted foundation behavior using native Kysely transaction APIs directly. Must execute at least two writes inside a native transaction, deliberately fail after an intermediate write, prove no partial committed state remains, and not use an outer rollback harness that masks production semantics.
- [ ] T028 [US3] Create integration tests in `apps/api/tests/integration/health.test.ts` verifying database unavailability causes `/ready` failure and safe operation failure.

### Implementation for User Story 3
- [ ] T029 [P] [US3] Define `AuditContext` explicit type (`actor`, `action`, `recorded_at`) in `apps/api/src/types/audit-context.ts`.
- [ ] T030 [US3] Implement `/health` (liveness) and `/ready` (gates on PostgreSQL connectivity) endpoints in `apps/api/src/routes/health.routes.ts`.

---

## Phase 6: User Story 4 - Reproducible Development Environment (Priority: P2)
**Goal**: Web frontend implementation and isolated testing of the end-to-end foundation.
**Independent Test**: Run a browser-based E2E authentication flow in an isolated Playwright container.

### Implementation for User Story 4
- [ ] T031 [P] [US4] Implement minimum web UI for login, protected dashboard, and CSRF token handling in `apps/web/src/pages/Login.tsx` and `apps/web/src/pages/Dashboard.tsx`.
- [ ] T032 [P] [US4] Configure Playwright 1.63.0 E2E test setup in `apps/web/playwright.config.ts`.
#### Gap-reconciliation prerequisites (proposed 2026-10-14; require Human Gate)

**Why added:** The accepted US4/SC-002 requires *running* API and Web services. T001–T032 produced primitives, React pages and Playwright configuration but did not include application entrypoints or executable startup. Preserve original task IDs; use T041–T044 as bounded addenda before returning to T033.

- [ ] **T041 [US4] — API startup/bootstrap.** Create minimum Fastify composition in `apps/api/src/app.ts` and runtime entrypoint in `apps/api/src/server.ts`; register accepted config, logging/error, auth, CSRF, authorization and actual `/auth/*`, `/system/*`, `/health`, `/ready` routes in safe order. Add only necessary `apps/api/package.json` dev/start scripts and focused app-wiring verification. Fail closed, no silent DB migration, no additional auth framework, no Asset/Material workflow.
- [ ] **T042 [P] [US4] — Web SPA bootstrap.** Create minimal Vite/React HTML entrypoint, React root, login/dashboard routing and the necessary TypeScript/Vite configuration in `apps/web/`; update only required web dependencies/scripts and frozen `pnpm-lock.yaml`. Reuse T031 pages and existing auth contract; resolve `/auth/*` same-origin connectivity for development without changing backend security or selecting a production reverse proxy.
- [ ] **T043 [US4] — Rootless development startup wiring.** Make existing `deploy/podman/compose.yaml`, `scripts/dev.sh` and package scripts actually boot PostgreSQL, API and Web using selected Node/pnpm baselines. Keep PostgreSQL network private, use development-only loopback exposure for host ports, preserve volume ownership and unrelated Fedora workloads, support explicit migrations and graceful teardown; no auto migration or production deployment.
- [ ] **T044 [US4] — Runnable stack smoke/preflight.** Prove development API and Web start on Rootless Podman; explicitly migrate an isolated development/test database, verify health/readiness/authentication/session/CSRF/logout via real HTTP and a safely provisioned disposable test identity. Record precise commands/evidence and test-owned cleanup. Do not claim Browser E2E PASS here; T033 owns the actual Chromium flow.
 
**Dependency gate:** T041 + T042 → T043 → T044 → T033 → T039. Do not implement T041–T044 before documentation approval and bounded Human Gate.

- [ ] T033 [US4] Implement minimum authentication/session Playwright E2E test in `apps/web/tests/e2e/auth.spec.ts` executing inside an isolated Playwright container boundary (`mcr.microsoft.com/playwright:v1.63.0-noble`). **Blocked until T041–T044 demonstrate runnable real development services; no fabricated E2E PASS.**

---

## Phase 7: Polish & Cross-Cutting Concerns
**Purpose**: Final verification, CI, backup semantics, and Quadlet production artifacts.

- [ ] T034 [P] Create `scripts/backup.sh` defining non-interactive logical backup without a pseudo-TTY (`podman exec <postgres-container> pg_dump -F c`).
- [ ] T035 [P] Create `scripts/restore.sh` defining restore verification against an isolated test database (`podman exec -i <postgres-container> pg_restore`).
- [ ] T036 [P] Create `deploy/podman/api.Containerfile` for the API OCI image using Node.js 24.21.0.
- [ ] T037 [P] Create production Quadlet definitions `api.container`, `api-migration.container` (one-shot migration responsibility that executes explicit migration command, depends on PostgreSQL, and runs before API service rollout/start without causing API auto-migration), `postgres.container`, `postgres-data.volume`, `s2-assets.network` in `deploy/podman/quadlet/`.
- [ ] T038 Create explicit CI pipeline in `.github/workflows/ci.yml` verifying frozen dependency installation, workspace lint, typecheck, unit tests, real PostgreSQL integration tests, web/API production build, Playwright E2E, and Trivy scan.
- [ ] T039 Perform full workspace verification confirming Feature 001 produces the tested static web production artifact and that the Quickstart operates correctly.
- [ ] T040 Perform explicit boundary verification reviewing the implemented Feature 001 diff against FR-007, SC-005, and Constitution Feature-Bounded Delivery principle, verifying implementation contains no generic transaction framework, no generic audit platform, no event sourcing/event bus, no generic workflow engine, no enterprise IAM/RBAC framework, no speculative shared-services layer, no Asset/Material domain implementation, and no reverse-proxy product selection.

---

## Traceability Summary
- **FR-001**: T016-T022
- **FR-002**: T023-T026
- **FR-003**: T029
- **FR-004**: T010, T011, T012, T013
- **FR-012**: T028, T030
- **FR-005**: T005, T006, T041–T044 (runnable development stack), T036, T037 (separately gated release artifacts)
- **FR-006**: T009, T027, T038
- **FR-007/SC-005**: T040 explicit final boundary verification
- **FR-008**: Verified through explicit constraint mappings in T008 and T027
- **FR-009**: T025, T026
- **FR-010**: T027 native Kysely transaction verification
- **FR-011**: T014, T015
- **SC-001**: T023, T026
- **SC-002**: T005, T006, T041–T044 (bootstrap reconciliation), T033 (browser proof), T039 (full workspace)
- **SC-003**: T027, T038
- **SC-004**: T029
- **Production Migration Responsibility**: T037
