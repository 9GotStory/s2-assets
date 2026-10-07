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
