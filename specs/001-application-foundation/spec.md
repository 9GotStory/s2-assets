# Feature Specification: application-foundation

**Feature Branch**: `feature/001-application-foundation`

**Created**: 2026-10-07

**Status**: Draft

**Input**: User description: Establish only the minimum application/runtime/security/auth/configuration/audit/test foundation genuinely required by subsequent business features.


## User Scenarios & Testing *(mandatory)*

### User Story 1 - Secure Application Access (Priority: P1)

System Maintainers and authorized actors must be able to securely authenticate and maintain a session, ensuring that only identified actors can interact with the system.

**Why this priority**: Without authentication, no business features can enforce capability-based access control or securely log audit history.

**Independent Test**: Can be fully tested by verifying that unauthenticated requests fail closed and successful authentication via the configured provider establishes an active session that tracks the user identity.

**Acceptance Scenarios**:

1. **Given** an unauthenticated request to a protected resource, **When** the request is made, **Then** the system must fail closed and deny access.
2. **Given** successful authentication via the configured provider, **When** the user signs in, **Then** the system must establish a secure session linked to the user's identity.
3. **Given** an active authenticated session, **When** the session is expired or explicitly revoked, **Then** subsequent requests using that session must be denied.
4. **Given** an active authenticated session, **When** the user's role or capability is revoked, **Then** subsequent protected requests made with that session must evaluate the new capability and fail closed immediately.

---

### User Story 2 - Capability Enforcement (Priority: P1)

The system must enforce server-side authorization to ensure users can only perform actions permitted by their assigned capabilities.

**Why this priority**: Fail-closed authorization is a core non-functional requirement and essential for data integrity.

**Independent Test**: Can be fully tested by assigning different capabilities to test users and verifying that access to restricted endpoints is granted or denied accordingly.

**Acceptance Scenarios**:

1. **Given** an authenticated user without the required capability, **When** they attempt a restricted action, **Then** the system must fail closed and return an authorization error.
2. **Given** an authenticated user with the required capability, **When** they attempt a restricted action, **Then** the system must proceed with the action.

---

### User Story 3 - Traceable Audit and Error Handling (Priority: P2)

The system must provide primitive mechanisms to record audit history (who, what, when) and manage transactions/errors reliably without fabricating data.

**Why this priority**: Required for traceability and ensuring transactions remain in a consistent state without losing context or requiring complex recovery.

**Independent Test**: Can be fully tested by triggering actions that write audit logs within a transaction boundary and triggering errors to ensure safe rollbacks.

**Acceptance Scenarios**:

1. **Given** a business action requiring audit tracking, **When** the action completes, **Then** the system must record the actor, action, and timestamp (Recorded At) alongside the data.
2. **Given** an operation within a transaction boundary, **When** an error occurs, **Then** the transaction must rollback safely without leaving data in a partial state.
3. **Given** missing or malformed required configuration, **When** the application attempts to initialize or serve requests, **Then** it must not enter a ready state for dependent functionality and must not leak secrets.
4. **Given** an unavailable database, **When** a database-dependent operation is attempted, **Then** the operation must fail safely without proceeding as successful.

---

### User Story 4 - Reproducible Development Environment (Priority: P2)

Developers must be able to reliably build, run, and test the application using Rootless Podman without conflicting with host tools.

**Why this priority**: Essential for onboarding, CI/CD, and consistent feature development before downstream features can be built.

**Independent Test**: Can be fully tested by spinning up the local development environment using Rootless Podman and running the test suite.

**Acceptance Scenarios**:

1. **Given** a clean development machine with Podman, **When** the development environment is started, **Then** the database, API, and web components must run successfully in Rootless Podman containers.
2. **Given** the application running in Podman, **When** integration tests are executed, **Then** the test suite must verify transaction invariants against the real PostgreSQL container.


## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST establish an authenticated session for valid users (authentication provider deferred to Plan phase). Subsequent requests using an expired or revoked session MUST be denied.
- **FR-002**: System MUST enforce authorization server-side and fail closed for all protected resources. Changed authorization capabilities MUST be effective immediately on the next protected request.
- **FR-003**: System MUST provide reusable audit context primitives (actor, action, recorded time). Downstream domain features may persist structured business history using these primitives when their requirements demand it. The system MUST NOT build a generic event-sourcing or centralized audit platform.
- **FR-004**: System MUST ensure that if required configuration or secrets are missing or malformed, it MUST NOT enter a ready or operational state for functionality depending on that configuration, and MUST NOT serve protected or business operations in an unsafe partially configured state. Sensitive values MUST NOT be exposed through source control, operational logs, or externally returned errors. (Exact startup and readiness mechanics are deferred to Plan).
- **FR-012**: System MUST ensure that database-dependent operations fail safely and do not proceed as successful if the database is unavailable. (Exact retry and startup mechanics are deferred to Plan).
- **FR-005**: System MUST run local application services and infrastructure dependencies inside Rootless Podman, preserving OCI portability.
- **FR-006**: System MUST verify PostgreSQL transaction semantics against a real PostgreSQL instance during integration tests.
- **FR-007**: System MUST NOT include generic workflow engines, shared-service abstractions, or speculative infrastructure that lacks a current requirement (Rule SYS-02).
- **FR-008**: System MUST NOT fabricate business data to satisfy validation or tests.
- **FR-009**: System MUST NOT bypass authoritative server-side authorization checks for alternative entry points such as QR codes or deep links.
- **FR-010**: Operations designated as transactional MUST NOT leave a partial committed state after failure.
- **FR-011**: Externally returned errors MUST NOT expose sensitive internal implementation details.

### Key Entities

- **User/Identity**: Represents an authenticated actor interacting with the system.
- **Role/Capability**: Defines the permissions boundary for authoritative capability-based authorization checks (e.g., Administrator, Asset Custodian, Supply Officer, Verification Staff, Requester, Read-only User, System Maintainer).
- **Audit Context Primitive**: Standardized reusable context (actor, action, recorded time) attached to business records.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of protected endpoints enforce server-side authorization and fail closed on unauthorized access.
- **SC-002**: The entire application stack (database, backend, frontend) successfully boots in a reproducible Rootless Podman environment on a clean host.
- **SC-003**: Integration tests successfully execute against a real PostgreSQL instance to verify transaction safety without using database mocks alone.
- **SC-004**: Audit primitives correctly capture actor, action, and recorded time for integration into business records without requiring redundant data entry.
- **SC-005**: Zero generic workflow engines, enterprise frameworks, or Asset/Material domain workflows are introduced during this feature.

## Assumptions

- The exact authentication provider (e.g., OIDC or local credentials) will be determined during the Application Foundation Plan as directed by `TECHNOLOGY.md`.
- Exact local development topology, Containerfile stage layout, and bind mounts remain Plan decisions, ensuring compatibility with Rootless Podman.
- No actual asset or material workflows will be developed in this feature; only the foundation for them.
- Git, GitHub Spec Kit, Multica, and AI agents remain on the host operating system.
- Quadlet is the production service-management baseline, not mandatory for day-to-day local development orchestration.
