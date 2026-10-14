# Phase 0: Research & Decisions

## Technical Decisions

### 1. Runtime and Exact Dependency Baseline
- **Decision**: Pinned exactly to stable releases within the selected project major lines as of 2026-10-07.
  - **Node.js**: 24.21.0 LTS
  - **TypeScript**: 6.0.3
  - **pnpm**: 12.9.1
  - **React**: 19.3.0
  - **Vite**: 8.3.3
  - **React Router**: 7.18.4 (Data mode)
  - **Fastify**: 5.12.5
  - **Zod**: 4.6.5
  - **@fastify/type-provider-zod**: 1.0.0
  - **@fastify/swagger**: 9.9.1
  - **PostgreSQL**: 18.6 (`postgres:18.6-alpine`)
  - **pg**: 8.23.1
  - **Kysely**: 0.29.6
  - **Vitest**: 5.0.3
  - **Playwright**: 1.63.0
- **Rationale**: Meets `TECHNOLOGY.md` baseline without silently upgrading major lines. Provides deterministic builds via exact pins.

### 2. Backend & API Contract
- **Decision**: Fastify 5.12.5 with official `@fastify/type-provider-zod` 1.0.0. OpenAPI 3.0 via `@fastify/swagger` 9.9.1.
- **Rationale**: Minimal setup with the current official scoped package. Eliminates redundant schema-generation libraries.
- **Error Contract**: Structured JSON `{ "error": { "code": "...", "message": "...", "request_id": "...", "details": {} } }`. Implementation details are strictly minimized.

### 3. Database & Migrations
- **Decision**: PostgreSQL 18.6. Update policy: Accept supported 18.x minor updates (containing bug, data-integrity, and security fixes) after testing. DB remains unpublished and private.
- **Migration Strategy**: Explicit `pnpm run db:migrate` executing Kysely's `Migrator` class via a custom TS script. 
- **Migration Execution Lifecycle**: NO auto-migration on API startup. Development runs explicitly. CI runs explicitly before tests. Production runs via a dedicated Quadlet transient task before service rollout. Rollback via `pnpm run db:migrate:down`.

### 4. Integration and Transaction Tests
- **Decision**: Real PostgreSQL 18.6 in Rootless Podman.
- **Test Strategy**: Tests proving real commit/rollback, isolation, locking, or concurrency behavior use independent real transactions/connections. They DO NOT rely on an outer rollback test transaction that masks production semantics.

### 5. Authentication (Product Owner Decision: LOCAL_CREDENTIALS)
- **Decision**: Local stable user identity with `argon2` 0.45.1 for password hashing.
- **Cookie & CSRF**: `@fastify/cookie` 11.1.2 and `@fastify/csrf-protection` 8.0.1. Cookie policy: `HttpOnly: true`, `Secure: true` (in production), `SameSite: 'Lax'`, `Path: '/'`. Since `SameSite: Lax` permits top-level navigation, state-changing requests use token-based CSRF protection.
- **Opaque Token Mechanics**: Client cookie receives raw token generated via `crypto.randomBytes(32).toString('base64url')`. DB stores ONLY the SHA-256 digest (`crypto.createHash('sha256').update(rawToken).digest('hex')`).
- **Session Lifecycle**: Rolling 8-hour expiry stored in DB. Immediate server-side revocation via hard delete of the session digest. Disabled users immediately fail evaluation. No OIDC/OAuth abstractions.

### 6. Roles and Capabilities
- **Decision**: `Administrator` and `System Maintainer` are Roles. Roles map to users in the database (`user_roles`). Capabilities are code-defined (e.g., `system:maintain`) mapping to these Roles.
- **Rationale**: The session identifies the authenticated user but does NOT cache authoritative capability state. Protected requests resolve current active-user + current capability state server-side dynamically. A code-defined capability map is sufficient and prevents creating a speculative enterprise RBAC engine.

### 7. Configuration and Readiness
- **Decision**: Zod-based configuration validation fails-fast immediately on missing secrets. 
- **Readiness Contract**: `/health` checks liveness. `/ready` gates on the PostgreSQL dependency. A lost DB dependency makes dependent operations fail safely and flips `/ready` to unavailable.
- **Secret Handling**: Zero secret leakage in logs (via Pino redaction) or error payloads.

### 8. Audit Context Primitive
- **Decision**: Explicit typed value `AuditContext = { actor: string, action: string, recorded_at: Date }`.
- **Rationale**: Downstream domain operations consume this object when creating history. No generic `withAudit(...)` transaction framework is built. Distinct from Pino operational logging.

### 9. Rootless Podman Orchestration
- **Decision**: `compose.yaml` (Compose Spec) executed via `podman compose` explicitly delegating to `podman-compose 1.6.0`. 
- **Development Boundaries**: Web/API exposed to host for development. PostgreSQL is strictly private to the application network (not exposed to LAN or host). Named volume for DB.
- **Permissions**: Configured with `userns=keep-id` (handled seamlessly by `podman-compose`), ensuring source bind mounts remain writable without privilege escalation or hardcoding UID 1000.

### 10. Production Boundary
- **Decision**: Reverse proxy product is **Deferred**. Feature 001 produces the tested static production web build artifact.
- **Contract**: HTTPS/static-serving integration belongs to the selected deployment reverse-proxy layer. Because the reverse-proxy product is still Deferred, Feature 001 does not invent a separate web server/container solely to host static files.
- **Runtime**: Rootless Podman + systemd/Quadlet baseline preserved.
- **Quadlet Responsibility**: Feature 001 provides `postgres.container`, `api.container`, `postgres-data.volume`, `s2-assets.network`.

### 11. Backup and Recovery
- **Decision**: Logical backup executed non-interactively via `podman exec <postgres-container> pg_dump -F c` (deterministic custom format) to eliminate host-installed PostgreSQL client requirements without allocating a pseudo-TTY. The matching restore uses `podman exec -i <postgres-container> pg_restore`.
- **Data Boundary**: Feature 001 has NO persistent business/evidence file storage to back up. No PITR/WAL/HA infrastructure introduced.

### 12. CI and Supply Chain
- **Decision**: Explicit pipeline covering: frozen dependency install, lint, typecheck, unit tests, real-PostgreSQL integration tests, production build, minimum auth Playwright E2E coverage, Trivy dependency/container scanning, and OCI image build.
- **Publish Policy**: Does NOT automatically publish to GHCR. Publishing requires an explicit authorized release trigger.

## Plan Reconciliation Research — 2026-10-15

These decisions supplement the accepted decisions above for the existing requirements. They are a documentation candidate based on `a7cc7188b5cc10d7e33e69529e8be3b757509537`, not implementation results. The prior Analyze report is reused; neither Analyze nor Tasks was invoked in this pass. No existing package pin, identity model or production boundary changes.

### 13. Application composition and lifetime
- **Decision**: Separate the Fastify app factory from the listening entrypoint; validate configuration before listening, register accepted security plugins in their effective application scope before routes, and close the owned pool on app shutdown. Initialize cookie signing through CSRF before auth when signing is required, preserving accepted plugin behavior.
- **Rationale**: Existing route-level tests can build their own app, so module success does not establish actual runtime composition. A shared factory plus real process/HTTP checks covers FR-001/002/004/011/012 without replacing those tests.
- **Alternatives considered**: Continuing to rely on test harnesses omits the running app; creating another service/auth framework exceeds the Feature Brief; automatically migrating on API boot contradicts the accepted explicit migration lifecycle.
- **Evidence**: Context7 `/fastify/fastify/v5.0.0`: [app/server separation](https://github.com/fastify/fastify/blob/v5.0.0/docs/Guides/Testing.md), [container listener](https://github.com/fastify/fastify/blob/v5.0.0/docs/Guides/Getting-Started.md), [close hooks](https://github.com/fastify/fastify/blob/v5.0.0/docs/Reference/Hooks.md). This is major-version guidance, not an exact Fastify 5.12.5 execution result. Actual registration/signing constraints were checked against accepted repository plugin code.

### 14. SPA and browser-to-API connection
- **Decision**: Mount React DOM and React Router Data mode around existing pages. Supply the missing matching `react-dom:19.3.0` counterpart; pin only necessary compatible type declarations during authorized implementation. Use a development-only Vite proxy for unchanged `/auth` and `/system` paths to `http://api:3000`, with `0.0.0.0:5173`, strict port selection and explicit `web` host allowlisting.
- **Rationale**: Both existing pages already call relative auth endpoints with credentials. Keeping one browser origin retains their cookie/CSRF flow while the Vite server uses container DNS for API access. This connection design is an inference from those calls and official proxy behavior, to be verified over HTTP/browser execution.
- **Alternatives considered**: Separate browser API origins require additional CORS/cookie configuration; SSR/Framework mode would replace the selected SPA/Data mode; a production proxy choice is outside this correction.
- **Evidence**: Context7 was consulted first; the catalog lacked the exact Router/Vite versions. Exact-version first-party fallback: [React Router 7.18.4 Data mode installation](https://reactrouter.com/7.18.4/start/data/installation), [Vite 8.3.3 server options](https://github.com/vitejs/vite/blob/v8.3.3/docs/config/server-options.md), and [React DOM createRoot](https://react.dev/reference/react-dom/client/createRoot). Existing pins are retained, not upgraded.

### 15. Reproducible Rootless Podman commands
- **Decision**: Use the existing Compose topology with a minimal development tooling image/stage, exact Node/pnpm provisioning, one frozen install before app startup, explicit foreground workspace commands, per-project resources and bounded service checks. Retain `keep-id` and Fedora shared SELinux mount permissions; publish application ports on loopback only.
- **Rationale**: Source mounts and port declarations alone launch neither app. Provisioning dependencies in containers avoids a host Node requirement, and serial preparation avoids concurrent writes. The existing private DB boundary and named data volume remain.
- **Alternatives considered**: Host runtime installation violates the project boundary; application auto-install on every service restart races shared state; Quadlet for ordinary development and custom orchestration frameworks are unnecessary.
- **Evidence**: Context7 `/containers/podman-compose`: [one-shot preparation example](https://github.com/containers/podman-compose/blob/main/examples/nodeproj/README.md), [Compose provider implementation](https://github.com/containers/podman-compose/blob/main/podman_compose.py), [provider extensions](https://github.com/containers/podman-compose/blob/main/docs/Extensions.md). Context7 `/websites/pnpm_io`: [frozen install](https://pnpm.io/cli/install). These provider/pnpm sources describe behavior but are not exact-version container verification. The accepted `podman-compose 1.6.0` and pnpm `12.9.1` pins must pass the later runtime gate; no toolchain was installed here.

### 16. Migration, fixtures and real HTTP prerequisites
- **Decision**: Keep the migration CLI explicit and separate from API startup. On a dedicated marked test database, explicitly create run-owned Argon2id identities/grants, exercise the real app, then remove only owned rows and secrets. A connectivity-only `/ready` is not evidence of schema installation. Add process/HTTP verification before existing T033, including missing configuration, capability/session/CSRF behavior and isolated dependency loss/recovery.
- **Rationale**: A fresh database can answer `SELECT 1` before foundation tables exist, and authentication cannot succeed without a test identity. Existing modules already provide the necessary operations; no new schema or production provisioning flow is required.
- **Alternatives considered**: Silent seeds/default accounts or using a shared/production database violate the isolation boundary; redefining readiness changes accepted behavior; `inject` and discovery-only checks cannot prove the listener and container connection.
- **Evidence**: Existing `packages/db/src/migrator.ts`, foundation migration, UserService, CSRF/auth plugins and `health.routes.ts`, the accepted migration decision above, and the prior Analyze findings. These decisions need no replacement product requirements.

### 17. Isolated browser runner
- **Decision**: Retain `mcr.microsoft.com/playwright:v1.63.0-noble` and matching project package. Prepare the pinned toolchain/project in a disposable runner-owned application workspace; connect it to the selected project's application network and run `pnpm --filter web test:e2e` with `E2E_BASE_URL=http://web:5173`. Archive existing failure diagnostics without secret material, then clean up the runner.
- **Rationale**: Runner `localhost` cannot identify the Web service, package installation/config discovery must happen in the correct workspace, and reinstalling over the live app's dependency tree risks corrupting running services. The browser image must not be assumed to include project pnpm/dependencies or the exact selected Node runtime.
- **Alternatives considered**: Executing Playwright inside the API image lacks the agreed isolated browser boundary; installing browser tooling on the host violates container-only application tooling; allowing all Vite hosts is unnecessary.
- **Evidence**: Context7 `/microsoft/playwright/v1.63.0` and [Playwright 1.63.0 Docker documentation](https://github.com/microsoft/playwright/blob/v1.63.0/docs/src/docker.md), plus accepted `apps/web/playwright.config.ts`. T033 still owns actual Chromium execution and remains unstarted.

No new Product Owner clarification is required by this design. Exact dependency/image compatibility and the executable guide remain implementation verification obligations; this research is not a runtime PASS. Phase 1 retains the existing data model and API error contract unchanged because composition adds no entity or API response semantics.
