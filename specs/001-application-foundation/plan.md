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
| **SC-002** (Reproducible Podman) | `compose.yaml` and `keep-id` user mapping | Quickstart verification | None |
| **SC-003** (Integration Safe Tests)| Unmasked PostgreSQL tests | CI pipeline | None |
| **SC-004** (Audit Primitive) | `AuditContext` passed explicitly | Integration tests | None |
| **SC-005** (Zero Frameworks) | Verified explicitly during planning | Manual Review | None |

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
