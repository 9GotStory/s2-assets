# Implementation Plan: application-foundation

**Branch**: `feature/001-application-foundation` | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)

**Reconciliation candidate**: 2026-10-15, based on `a7cc7188b5cc10d7e33e69529e8be3b757509537`. Documentation only; independent review and Human Gate pending. Existing accepted T001–T032 work and all existing task identities are preserved. Draft PR #7 is preliminary evidence, not approved authority. This pass does not generate tasks or authorize implementation.

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
| **FR-001** (Session/Local Auth) | Accepted services/routes composed into a listening API; existing login/dashboard mounted in SPA | Existing unit/integration tests plus real HTTP session lifecycle and T033 browser flow | API/SPA bootstrap, explicit migration and disposable identities |
| **FR-002** (Fail-closed Auth) | Middleware evaluates current active-user + code-mapped capability per request | Existing integration tests plus HTTP capability denial/grant/revocation | Application registration and test identities |
| **FR-003** (Audit Context) | Explicit `AuditContext` type (`actor`, `action`, `recorded_at`) | Typecheck and unit tests passing context to mock domain logic | None |
| **FR-004** (Config Fail-closed) | Existing Zod loader and redacted logger run before listening; existing CSRF signing rules preserved | Existing unit tests plus actual entrypoint failure with invalid configuration | Bootstrap and signing-secret registration order |
| **FR-012** (DB Unavailability) | Existing `/ready` gates on DB, HTTP 503 on lost connection | Existing integration tests plus isolated HTTP dependency-outage check | Runtime route registration; schema initialization is a separate gate |
| **FR-005** (Rootless Podman) | Existing Compose topology with executable API/Web commands and pinned container tooling | Clean isolated startup using the revised Quickstart | Development image, frozen dependency preparation and commands |
| **FR-006** (Real PG Tests) | Real `postgres:18.6-alpine` container without transaction-masking for concurrency | Integration tests executing against container DB | None |
| **FR-007** (No Speculative Infra) | Only `users`, `sessions`, `roles`, `user_roles` modeled. No generic workflow/audit tables | Code review / Analyze phase | None |
| **FR-008** (No Fabricated Data) | Factories create logically sound users | DB constraints enforced in tests | None |
| **FR-009** (Server Authoritative) | Auth middleware enforced at Fastify router level; SPA navigation adds no authority | Existing integration tests plus direct HTTP/deep-link checks | Runtime router composition |
| **FR-010** (Atomic Transactions) | Explicit Kysely transactions for domain mutations | Integration tests verifying rollback state | None |
| **FR-011** (Error Contract) | Unchanged `api-error.md` contract and accepted handler registered in the app | Existing unit tests plus safe actual HTTP errors | Application registration |
| **SC-001** (100% Protected) | Global route auth enforcement and route-specific capability checks in the actual app | Registered-route inventory and HTTP denial/grant tests | Application composition |
| **SC-002** (Reproducible Podman) | Existing private DB plus runnable Fastify/Vite, `keep-id`, explicit initialization | Revised Quickstart, HTTP smoke, T033 and final T039 | Gates below; Compose container creation alone is insufficient |
| **SC-003** (Integration Safe Tests)| Unmasked PostgreSQL tests | CI pipeline | None |
| **SC-004** (Audit Primitive) | `AuditContext` passed explicitly | Integration tests | None |
| **SC-005** (Zero Frameworks) | Verified explicitly during planning | Manual Review | None |

## Constitution Check

*Original design gate: Passed. Reconciliation: author-side design check only; independent review and Human Gate pending.*

1. **Authority Preservation**: Exact versions and the `LOCAL_CREDENTIALS` approach comply perfectly with `TECHNOLOGY.md` and PO decisions.
2. **Feature-Bounded Delivery**: Capability mapping is code-defined to prevent enterprise IAM framework bloat.
3. **Rootless Podman Development**: Strict `compose.yaml` boundary. Postgres is not exposed to host/LAN. Assumes proper unprivileged permissions via `userns=keep-id`.
4. **Server-Side Security**: Local credentials hashed via `argon2`. Session stores SHA-256 digests only and doesn't cache capability state.
5. **Verification Against Real Invariants**: Tests strictly mandate independent connections for concurrency testing, avoiding rollback-masking.
6. **Human-Gated Independent Delivery**: This reconciled Plan is a candidate for independent review and Human acceptance. Task generation and implementation remain separately authorized steps.

**Pre-research and post-design check (2026-10-15)**: The proposed design retains all six principles and introduces no technology deviation, schema change, business feature, production reverse-proxy choice or generic framework. This is an author-side design check, not independent approval or evidence that the missing runtime already works. Runtime verification remains outstanding.

## Reconciled Application and Development Design

The prior GAPS FOUND analysis is the input; it is not rerun here. FR-001/002/004/005/009/011/012, SC-001/002 and US4 already require the following composition. Research decisions and primary documentation are recorded in [research.md](./research.md); executable target-state validation is in [quickstart.md](./quickstart.md).

### API bootstrap and process boundary

- Add a minimal `apps/api/src/app.ts` factory and `apps/api/src/server.ts` entrypoint. The factory composes the real application without listening; the entrypoint validates runtime configuration, obtains the app, waits for plugin initialization and listens on container interface `0.0.0.0:3000`. No business operations are served if required initialization fails. Preserve test dependency injection without weakening the runtime configuration path.
- Use the accepted configuration, Pino redaction/error handler, `UserService`, `SessionService`, capability service and route modules. The composition owns one shared PostgreSQL pool; injected clients are not closed by consumers. SIGTERM/SIGINT close Fastify and the owned pool, and startup failures release acquired resources and exit nonzero without logging secrets.
- Validate configuration first. Install the accepted logger/error handling and cookie/CSRF integration before auth routes. Register CSRF before auth when it must initialize cookie signing, then auth, then auth/system/health routes in the same effective security scope. Do not preregister an unsigned cookie plugin and then require signed CSRF cookies in production. Existing CSRF minimum secret strength, production Secure cookies, rolling session expiry and exact login bootstrap exception remain authoritative.
- Mount auth routes once at `/auth`, system routes once at `/system`; mount health routes at root. `/health` and `/ready` remain explicitly public. Every other unmarked route remains authenticated by default; `/system/info` requires `system:maintain`. Do not publish test-only CSRF helper routes or add broad auth/CSRF exemptions. Preserve existing OpenAPI/validation integration; no new API framework.
- Planned command contracts: API `dev` runs the source entrypoint with Node development watching, `start:dev` runs that same entrypoint without watching for process/smoke checks, `build` emits runnable ESM, `start` runs the emitted artifact, and `typecheck` checks strict TypeScript. Exact build configuration must correctly handle existing TypeScript imports. These scripts are future implementation work, not present at this candidate SHA.

### SPA bootstrap and development connectivity

- Add `apps/web/index.html`, `src/main.tsx`, `src/router.tsx` and the minimal Vite/strict TypeScript configuration. Mount with React DOM, create the React Router 7 Data mode router outside the React tree, and render existing T031 Login/Dashboard. `/` redirects to `/login`; `/login` and `/dashboard` support direct navigation/reload. Existing Dashboard session checking remains client UX; server authorization remains authoritative.
- Add only required runtime counterpart `react-dom` matching React `19.3.0` and compatible exact TypeScript declaration pins where missing; preserve all existing pins. Any necessary dependency/lockfile changes belong to later implementation and must pass a frozen install. Do not generate a new scaffold over accepted pages or introduce Framework mode, SSR or RSC.
- Vite listens on `0.0.0.0:5173` with strict port selection. Development-only proxies forward `/auth` and `/system` unchanged to `http://api:3000`. Existing relative requests, credentials and CSRF header handling remain intact. No CORS layer or new `/api` prefix is needed. This does not select a production reverse proxy.
- Permit the explicit container hostname `web` in Vite's host allowlist; never allow all hosts. A separate browser container uses `E2E_BASE_URL=http://web:5173` on the application network, while a host browser uses loopback. Planned web scripts are `dev`, `build` and `typecheck`; the accepted `test:e2e` command/configuration remains.

### Rootless startup and dependency preparation

- Retain normal services `postgres`, `api`, `web`, the private database network, named PostgreSQL data volume, and API membership in both networks. Verify that the volume covers the selected PostgreSQL image's effective data directory and that schema/data survives a normal down/up cycle. PostgreSQL is not published. API and Web publish loopback-only host ports (defaults 3000/5173), configurable explicitly if occupied; startup must not silently switch ports or disturb other projects.
- Add a minimal `deploy/podman/dev.Containerfile` to provision the approved Node `24.21.0` and pnpm `12.9.1` toolchain, keeping it separate from T036 production image work. Source-driven commands and all dependency installation execute inside Rootless Podman. Preserve `userns=keep-id`, writable user-owned dependency/cache storage, and Fedora SELinux shared source-mount labeling without privileged mode, blanket ownership changes or disabling SELinux.
- Compose API/Web commands execute signal-transparent foreground processes (`node --watch apps/api/src/server.ts` and `node apps/web/node_modules/vite/bin/vite.js apps/web`) to support direct SIGTERM delivery and observed graceful shutdown within standard stop timeouts without intermediary process signal-swallowing. A bounded preparation step builds local tooling and performs `pnpm install --frozen-lockfile` once before starting writers; do not race installs in both services. Verify runtime/package-manager versions, and fail rather than regenerate a mismatched lockfile. Native dependencies must work in the selected development image.
- A dedicated fixed-purpose verification runner `scripts/verify-foundation.sh` enforces isolated execution under modes `targeted` and `integration-ci`. In CI, it manages a private owned rootless Podman endpoint (mode 0600 in a private directory, without `:z`/`:Z` socket mount, with fail-closed endpoint guards and without fallback) to prevent host socket permission leakage and SELinux relabeling.
- Keep `scripts/dev.sh` a small fixed-purpose helper: existing no-argument/source behavior remains provider preflight; `prepare` prepares the container toolchain/dependencies; `test-identity setup|cleanup`, `http-smoke`, and `e2e` run the specific checks below in containers. It must honor the same explicit project, Compose file and private environment file as direct Compose commands, reject unknown actions and propagate failures. No scheduler or generic orchestration layer.
- A unique Compose project names its own networks/volumes. `depends_on` ordering alone is not readiness: use a bounded PostgreSQL availability check before explicit migrations and bounded HTTP checks after startup. Normal teardown preserves the named data volume. No application service receives a Podman socket or starts nested container tooling.

### Explicit migration and test identity lifecycle

- Retain T007's migration runner and existing root `db:migrate`/`db:migrate:down` commands. Development order is dependency preparation → PostgreSQL available → explicit one-shot `pnpm run db:migrate` → fixture preparation when testing → API/Web startup → HTTP checks. A migration failure stops this path. Repeated migration on an initialized database must be safe; API startup never runs migrations. CI/production migration responsibilities remain the accepted separate lifecycle.
- `/ready` keeps T030's connectivity contract: HTTP 200 with `{"status":"ok"}` when PostgreSQL responds, HTTP 503 with the accepted safe error contract otherwise. It does not assert schema installation. Successful explicit migration plus an authenticated HTTP operation proves that separate schema gate; do not redefine readiness or weaken the migration gate.
- Disposable auth fixtures in `apps/api/tests/fixtures/identity.ts` are test infrastructure, not business data or production user provisioning. Run setup explicitly with `NODE_ENV=test`, a unique `FOUNDATION_TEST_RUN_ID`, and `FOUNDATION_TEST_DATABASE_URL` equal to the explicitly selected isolated `s2_foundation_...` database. Reject production mode, a missing/mismatched target, an unmarked database or preexisting conflicting identities. No baked-in usernames/passwords or automatic API-startup seed.
- Create only run-owned active identities needed for smoke/browser checks: one with the accepted `SYSTEM_MAINTAINER` role and one without that capability. Hash random externally supplied test passwords using accepted Argon2id logic. Retain the existing schema/code capability map. Record exact created identifiers and any created role rows in private run state so cleanup removes only owned sessions, grants, users and unused role rows created by this run. Never delete preexisting roles/users or reset a shared database.
- Credentials, cookie jars, CSRF tokens and ownership state stay in a mode-restricted runtime directory outside the repository and images; pass credentials to container runners by environment names/private files, not literal command arguments or logs. Cleanup is attempted even after a failed check, preserves the check's failure exit, and reports any cleanup failure. Production initial-account provisioning is outside this reconciliation.

### Real HTTP verification and gate before T033

Use a bounded API-side test runner in `apps/api/tests/http/foundation.test.ts` against the actual listening services; it must not substitute `inject`, mocks, a fallback test app or test discovery. The `http-smoke` helper runs `pnpm --filter api test:http` inside the development container, with `HTTP_API_URL=http://api:3000` and `HTTP_WEB_URL=http://web:5173`. Its implementation may use native Node HTTP/fetch and existing test tooling; no additional test platform is required. Restore deliberately changed fixture grants/state after each check, or provision fresh run-owned identities, so a later browser run does not inherit revoked credentials or dirty state.

For dependency interruption, the host helper controls only the exactly identified PostgreSQL service of the dedicated test project; the container runner observes the real HTTP behavior. Restore that service in failure cleanup. Do not mount a Podman socket into API/Web or let application code operate the runtime.

| Gate | Required evidence | Dependency |
|---|---|---|
| Application composition | Actual entrypoint rejects invalid required configuration with nonzero exit/no operational listener; plugins initialize in safe order | Accepted modules plus API bootstrap |
| Reproducible runtime | Pinned tooling/frozen install; three live services; reachable API/Web; explicit successful migration | API/SPA bootstrap plus development wiring |
| HTTP security/session | Public probes; 401 unauthenticated; 403 insufficient capability; authorized `/system/info`; immediate role revocation; real login/session-check; invalid/missing CSRF denied; valid logout; subsequent session rejected; safe errors | Runtime plus isolated fixtures |
| Dependency failure | Only test-owned PostgreSQL is interrupted: `/health` remains live, `/ready` is 503, DB-dependent operations cannot succeed; recovery verified | Dedicated disposable stack; restore dependency even on failure |
| Browser prerequisite | SPA `/login` and direct `/dashboard` return the app; same-origin proxy passes cookies/CSRF; pinned browser runner reaches `web` by service DNS | All preceding gates |
| Existing T033 | Real Chromium login/dashboard/logout/session rejection with explicit base URL | Preceding gates independently verified and implementation authorization granted |

Keep existing real-PostgreSQL transaction/integration tests and accepted semantics. Add focused composition/HTTP evidence rather than replacing their coverage. Native PostgreSQL transaction assertions must still use independent connections, never mocks or a masking outer rollback transaction.

The `e2e` helper uses the accepted `mcr.microsoft.com/playwright:v1.63.0-noble` boundary and matching project Playwright package, prepares pinned Node/pnpm tooling and a frozen dependency install in a disposable runner-owned application workspace, joins only this project's application network, and invokes `pnpm --filter web test:e2e`. It must not reinstall dependencies over running API/Web mounts, assume pnpm exists in the browser image, or copy Git/Spec Kit/agent tooling into the runner. Preserve existing Chromium/single-worker/failure-diagnostic configuration. No browser test is implemented or run by this Plan pass.

### Sequencing and acceptance boundary

API composition and SPA bootstrap may be prepared independently; their integration precedes real HTTP verification, which precedes T033. No new task IDs are assigned here. A later separately authorized `$speckit-tasks` reconciliation must preserve every existing ID and accepted T001–T032 work, and encode these prerequisites before T033. Do not adopt Draft PR #7's T041–T044 as already-approved tasks.

T034–T040 remain separately gated and retain their scope. T039 eventually proves the entire implemented Quickstart and static production web artifact; lint/typecheck/build, real PostgreSQL integration, browser/CI and other accepted final checks are not waived by HTTP smoke. Production image, Quadlet, backup/restore, publishing, deployment and Feature 002 are not authorized by this candidate.

Phase 1 reuses `data-model.md` and `contracts/api-error.md` unchanged: no entity, constraint or REST response semantic changes are required. The runtime/proxy/command contract is specified above; Quickstart is updated to match it without changing the existing specification or task list.

## Project Structure

Target layout below includes planned files; this documentation candidate creates none of the application/runtime files.

```text
s2-assets/
├── apps/
│   ├── api/
│   │   ├── src/{app,server}.ts
│   │   └── tests/{fixtures/identity.ts,http/foundation.test.ts}
│   └── web/
│       ├── index.html
│       ├── src/{main,router}.tsx
│       ├── src/pages/{Login,Dashboard}.tsx  # accepted T031
│       └── playwright.config.ts            # accepted T032
├── packages/
│   └── db/
├── deploy/
│   └── podman/
│       ├── compose.yaml
│       └── dev.Containerfile
├── scripts/
│   ├── dev.sh
│   ├── verify-foundation.sh
│   └── tests/verify-foundation.test.sh
├── pnpm-workspace.yaml
```
