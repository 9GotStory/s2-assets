# Quickstart: Application Foundation

**Status: T044 development migration and test identity lifecycle verified.** T041 API bootstrap, T042 Web SPA bootstrap, T043 container-only toolchain, and T044 explicit migration and disposable test identity lifecycle (`scripts/dev.sh test-identity setup|cleanup` and `apps/api/tests/fixtures/identity.ts`) are implemented and verified. Subsequent steps—HTTP smoke verification (T045) and browser execution (T033/T046)—remain separately gated and require their authorized implementations before execution.

This guide covers an isolated Rootless Podman development/test stack. Git, Spec Kit and agents remain on the Fedora host. Node, pnpm, PostgreSQL and browser execution remain in containers. [Plan](./plan.md) defines the command/lifecycle contract; [research](./research.md) records decisions. The unchanged [data model](./data-model.md) and [API error contract](./contracts/api-error.md) remain authoritative.

## 1. Preconditions and private configuration

Use Bash from repository root on a Fedora host with Rootless Podman, exactly `podman-compose 1.6.0` and host `curl`. Reserve loopback ports 3000 and 5173, or explicitly choose free `API_HOST_PORT`/`WEB_HOST_PORT` values. Do not stop unrelated workloads or silently select other ports.

Supply `FOUNDATION_ENV_FILE` as an absolute path to a trusted, private shell/environment file in a mode-700 runtime directory outside the checkout; keep the file mode 600. Use shell assignments with values supplied for this run, without printing them. Required keys:

| Key | Value/constraint |
|---|---|
| `COMPOSE_PROJECT_NAME` | Unique lowercase project name for this run; do not reuse a shared project |
| `POSTGRES_DB` | Unique database name beginning `s2_foundation_` |
| `POSTGRES_USER` | Dedicated local database user |
| `POSTGRES_PASSWORD` | Fresh random hexadecimal secret (at least 16 hex characters; safe for URL construction without delimiters or whitespace); no repository default |
| `COOKIE_SECRET` | Fresh random hexadecimal signing secret of at least 32 bytes (64 hex characters without whitespace); no default |
| `FOUNDATION_TEST_RUN_ID` | Unique marker recorded in private fixture ownership state |
| `FOUNDATION_TEST_USERNAME` | Unique base name for this run's disposable identities |
| `FOUNDATION_TEST_PASSWORD` | Fresh random test password (at least 8 non-whitespace characters); no production credential |

The planned helper validates permissions, required values and isolated target, and rejects missing/default credentials, non-hexadecimal secrets, or whitespace padding. Container configuration must explicitly consume these values. Do not enable shell tracing, commit this file, bake secrets into images or print expanded Compose configuration. Runtime-only fixture state/cookie material uses the same private directory.

```bash
set -euo pipefail
test -f apps/api/src/server.ts
test -f apps/web/index.html
test -f apps/web/src/main.tsx
: "${FOUNDATION_ENV_FILE:?Set the private configuration file path}"
set -a
source "$FOUNDATION_ENV_FILE"
set +a
export API_HOST_PORT="${API_HOST_PORT:-3000}"
export WEB_HOST_PORT="${WEB_HOST_PORT:-5173}"
export FOUNDATION_TEST_DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}"
export PODMAN_COMPOSE_PROVIDER=podman-compose

compose() {
  podman compose --env-file "$FOUNDATION_ENV_FILE" \
    -p "$COMPOSE_PROJECT_NAME" -f deploy/podman/compose.yaml "$@"
}

# Existing exact provider preflight; every helper uses the same project/file.
bash scripts/dev.sh
# Verified action under T043: prepare pinned container tooling and a frozen workspace install.
bash scripts/dev.sh prepare
```

Preparation must prove Node `24.21.0`, pnpm `12.9.1` and `pnpm install --frozen-lockfile` in the development container. It fails if versions/dependencies do not match; it must not rewrite the lockfile. No app is started and no database is mutated by preparation.

## 2. Start PostgreSQL, wait, then explicitly migrate

```bash
compose up -d postgres
for attempt in {1..30}; do
  if compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"; then
    break
  fi
  if (( attempt == 30 )); then
    echo 'PostgreSQL readiness timed out' >&2
    exit 1
  fi
  sleep 1
done
compose run --rm --no-deps api pnpm run db:migrate
```

Require a zero migration exit and the installed foundation schema before proceeding. The existing migration runner supports explicit repeated runs; a second run must report no pending work. API startup never migrates automatically. `/ready` proves PostgreSQL connectivity only, so it cannot replace this step.

For smoke/browser testing, explicitly prepare disposable identities before startup:

```bash
bash scripts/dev.sh test-identity setup
```

This action runs the API fixture command in a short-lived container with `NODE_ENV=test`, the explicit test database URL and run identity. It creates only a maintainer identity and an identity without the capability, using existing Argon2id/role semantics. It refuses production/unmarked/mismatched targets and records exact owned rows privately. No production provisioning or automatic seed occurs.

If setup partially fails, attempt `bash scripts/dev.sh test-identity cleanup` before teardown; retain the original failure and report any cleanup failure. Cleanup must be safe after partial setup and must never delete preexisting identities or role data.

## 3. Start actual API/Web processes and check HTTP

```bash
compose up -d api web
curl --fail --silent --show-error --retry 30 --retry-connrefused \
  --retry-delay 1 --max-time 5 "http://127.0.0.1:${API_HOST_PORT}/health"
curl --fail --silent --show-error --retry 30 --retry-connrefused \
  --retry-delay 1 --max-time 5 "http://127.0.0.1:${API_HOST_PORT}/ready"
curl --fail --silent --show-error --retry 30 --retry-connrefused \
  --retry-delay 1 --max-time 5 --output /dev/null \
  "http://127.0.0.1:${WEB_HOST_PORT}/login"
bash scripts/dev.sh http-smoke
```

Both API probes return HTTP 200 with `{"status":"ok"}`. The planned smoke action executes `pnpm --filter api test:http` inside a container against `http://api:3000` and `http://web:5173`. It verifies actual entrypoint/configuration failure, route registration, unauthenticated/capability denial and immediate revocation, valid login/session, CSRF rejection and valid logout followed by session rejection, safe errors, and database interruption/recovery in this dedicated stack. It restores an interrupted test-owned dependency even after failure. It keeps credentials/cookies/CSRF material out of stdout and records non-secret results and exact commands.

Open `http://127.0.0.1:<WEB_HOST_PORT>/login` on the host for manual inspection. Existing relative `/auth/*` requests travel through the development-only Vite proxy to `http://api:3000`; `/system/*` is proxied unchanged too. Direct `/dashboard` navigation/reload loads the SPA and performs the accepted session check. No browser receives server-only database configuration.

HTTP smoke must pass before T033 can be considered ready; test discovery, mocked requests and `inject` alone do not satisfy this gate.

## 4. Existing T033 browser verification — separately authorized

Only after the preceding gates pass and T033 receives authorization:

```bash
export E2E_BASE_URL=http://web:5173
bash scripts/dev.sh e2e
```

The planned action prepares the exact Node/pnpm toolchain and frozen project dependencies in a disposable runner-owned application workspace, uses the accepted `mcr.microsoft.com/playwright:v1.63.0-noble` boundary, joins this project's application network, then executes `pnpm --filter web test:e2e`. It does not assume pnpm/project dependencies exist in the browser image or reinstall over running app mounts. Package/image Playwright versions match `1.63.0`; the existing config selects Chromium and one worker. Vite explicitly allows service hostname `web`. The runner's `localhost` is not the Web container.

Require an actual passing login/dashboard/logout/session-rejection browser flow, including direct navigation, and retain the existing failure diagnostics without secret material. This documentation pass neither implements nor executes T033.

## 5. Cleanup and later full-workspace acceptance

Run cleanup on success and after failures. Keep the failed check's exit status; a successful cleanup must not mask a failure. If cleanup fails, report it and retain private ownership state for bounded recovery.

```bash
bash scripts/dev.sh test-identity cleanup
compose down
```

The helper removes only this run's owned sessions/grants/users and eligible role rows, disposes its test runners, and clears secret/cookie state only after successful cleanup. `compose down` uses the same explicit project/file and preserves the PostgreSQL volume. Volume deletion is an explicit destructive action outside this normal guide; do not run global prune/reset or delete unrelated resources.

T039 must later rerun the implemented guide from a clean isolated environment and record exact image/tool versions, commands, responses and failure cleanup. API/Web `typecheck` and `build` run inside containers after those planned scripts exist. Existing real-PostgreSQL integration/transaction tests, lint, CI/security scans, static web build, backup/restore and production-artifact checks retain their accepted task scope and separate authorization; they are not replaced by HTTP smoke or marked complete here. In particular, integration tests that control disposable PostgreSQL require the accepted test runner's rootless socket/CLI setup, not the ordinary application containers. No unimplemented workspace-wide script is presented as an already working command.
