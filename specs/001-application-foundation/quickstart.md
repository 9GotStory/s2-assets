# Quickstart: Application Foundation

> **Status note (2026-10-14 — proposed reconciliation, not yet implemented):** This document describes the intended end-to-end behavior. On canonical HEAD `a7cc7188b5cc10d7e33e69529e8be3b757509537`, API/Web application entrypoints and service start commands are not present. Consequently the Compose `up` and `curl` examples below do **not** yet prove a runnable app stack; workspace scripts and the browser command may also be unavailable. **Do not treat this Quickstart as verified or claim browser E2E PASS.** Proposed T041–T044 will implement and then validate the missing bootstrap, update exact commands, and unblock T033. T039 will independently validate the complete Quickstart. No Production changes are authorized by this note.

This guide validates the Rootless Podman development workflow natively without host Node.js or PostgreSQL dependencies (other than Podman).

## Prerequisites
- Fedora Host
- Rootless Podman
- `podman-compose` version 1.6.0 installed

## 1. Provider Preflight
Ensure the correct deterministic Compose provider is available and selected for the entire session:
```bash
export PODMAN_COMPOSE_PROVIDER=podman-compose
if ! podman compose version | grep -q "podman-compose version 1.6"; then
  echo "ERROR: Requires podman-compose 1.6.0" >&2
  exit 1
fi
```

## 2. Start the Environment

**Prerequisite gate:** Run this step only after T041–T043 create and independently verify real start commands. Until then, Compose may create containers without a running API or Web application. T044 must prove the start process with task-owned resources.
Boot the stack using the Compose Spec file. (Note: PostgreSQL is private to the container network and NOT exposed to the host LAN).
```bash
podman compose -f deploy/podman/compose.yaml up -d
```

## 3. Verify Health & Configuration
```bash
curl http://localhost:3000/health
# Expected: {"status": "ok"}

curl http://localhost:3000/ready
# Expected: {"status": "ready", "db": "connected"}
```

## 4. Run Verifications & Tests

**Prerequisite gate:** The workspace/package scripts listed below are target verification commands, not evidence that those scripts currently exist. T041–T044 must reconcile the executable scripts and verify them before T033/T039 acceptance. Browser tests require a real service, explicit E2E base URL, isolated credentials, and the disposable pinned Playwright image.
Execute all application tasks inside the container context:
```bash
# Workspace Lint & Typecheck
podman compose exec api pnpm --filter "*" lint
podman compose exec api pnpm --filter "*" typecheck

# Unit Tests (Workspace)
podman compose exec api pnpm --filter "*" test:unit

# Real-PostgreSQL Integration Tests (API)
podman compose exec api pnpm --filter "api" test:integration

# Production Build (Workspace, includes both web and api)
podman compose exec api pnpm --filter "*" build

# Minimum Authentication/Session E2E Tests (Playwright)
# Note: E2E requires browser runtimes not present in the lightweight API container.
# It uses an ephemeral Playwright image connected to the app network.
podman run --rm --network s2-assets_default \
  -v "$(pwd)":/work/ -w /work/ \
  mcr.microsoft.com/playwright:v1.63.0-noble \
  bash -c "pnpm install && pnpm exec playwright test"
```

## 5. Teardown
To safely stop the containers (preserving the `postgres-data` named volume):
```bash
podman compose down
```

To perform a explicitly destructive teardown (deleting the database volume permanently):
```bash
podman compose down -v
```
