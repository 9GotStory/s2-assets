# Quickstart: Application Foundation

**Status: T046 isolated Playwright runtime preflight verified.** T041 API bootstrap, T042 Web SPA bootstrap, T043 container-only toolchain, T044 explicit migration and disposable test identity lifecycle, T045 real HTTP smoke and database outage/recovery verification (`scripts/dev.sh http-smoke`), and T046 isolated Playwright runtime preflight (`scripts/dev.sh e2e --preflight`) are implemented and verified. Subsequent step—browser execution (T033)—remains separately gated and requires authorized implementation before execution.

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
| `FOUNDATION_TEST_DATABASE_URL` | Explicit connection URL matching the selected `s2_foundation_...` database |

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

Both API probes return HTTP 200 with `{"status":"ok"}`. The verified smoke action executes `pnpm --filter api test:http` inside a container against `http://api:3000` and `http://web:5173`. It verifies actual entrypoint/configuration failure, route registration, unauthenticated/capability denial and immediate revocation, valid login/session, CSRF rejection and valid logout followed by session rejection, safe error envelopes, and host-coordinated PostgreSQL stop/start outage and recovery in this dedicated stack (during outage, `/ready` returns HTTP 503 with the accepted error envelope, while `/health` remains 200). It automatically restores an interrupted test-owned dependency and invokes fixture cleanup on completion (both on success and failure paths), preserving `SYSTEM_MAINTAINER` and preserving first-failure exit codes if earlier failures occur. It keeps credentials/cookies/CSRF material out of stdout and records non-secret results and exact commands.

Open `http://127.0.0.1:<WEB_HOST_PORT>/login` on the host for manual inspection. Existing relative `/auth/*` requests travel through the development-only Vite proxy to `http://api:3000`; `/system/*` is proxied unchanged too. Direct `/dashboard` navigation/reload loads the SPA and performs the accepted session check. No browser receives server-only database configuration.

HTTP smoke must pass before T033 can be considered ready; test discovery, mocked requests and `inject` alone do not satisfy this gate.

## 4. Isolated Playwright runtime preflight (T046) and T033 browser gate

T046 provides isolated, trusted runtime preflight without executing browser tests or mutating persistent development state:

```bash
export E2E_BASE_URL=http://web:5173
bash scripts/dev.sh e2e --preflight
```

### 4.1 Prerequisites and provisioning contract
- **Pre-provisioned image requirement**: The isolated runner requires pre-provisioned `s2-assets-e2e-runner:local` with immutable image ID `2a4778c23106d33f9c9c4d98d49adccd6d6fe968d4554e5ec20b9225e16a0175` (built from `mcr.microsoft.com/playwright:v1.63.0-noble`, underlying base ID `2c1f4e0fd6450f43ddb46d60c2a6df30855a8588e165b1f2559fb0eda8d7ff35`). Automatic image build or pull (including implicit pull-on-create via `--pull=never`) is strictly prohibited and stops at Human Gate.
- **Rootless Podman 5.8.4 execution**: Enforces invocation-local `--events-backend=none`, container `--log-driver=none`, `--http-proxy=false`, `--read-only` rootfs, `--tmpfs /runner-tmp:rw,size=16m,noexec,nosuid,nodev`, `--unsetenv-all`, and explicit minimal environment (`COREPACK_HOME=/usr/local/share/corepack`, `COREPACK_ENABLE_NETWORK=0`, `HOME=/runner-tmp`, `TMPDIR=/runner-tmp`, and `E2E_BASE_URL=http://web:5173`). Podman rootless inspection is verified fail-closed (must return a non-empty inspection array with `Rootless: true`). No host credentials, environment files, or host proxy configurations leak into the container.
- **Three-zone filesystem isolation**: Filesystem mounts are partitioned into three dedicated zones: (a) `/workspace` (read-only in Phase 2 assertion container), (b) `/trusted` (read-only mount housing pinned `playwright.config.ts` and `e2e_preflight.mjs`), and (c) `/control` (empty writable mount for exclusive control JSON output).
- **Application network isolation**: Assertion runner attaches only to the explicitly verified application network of the dedicated test-owned project (strictly `<project>_default`), strictly prohibiting attachment to database networks, host network, or the Podman socket. Frozen dependency installation executes under `--network none`.
- **Minimal allowlist workspace & directory-descriptor pinning**: Created under `/tmp` with mode 0700; copies only the explicit necessary application regular files without walking the `src/` tree (root `package.json` [250 bytes], `pnpm-lock.yaml` [86609 bytes], `pnpm-workspace.yaml` [124 bytes], `apps/web/package.json` [514 bytes], and pinned `apps/web/playwright.config.ts` [979 bytes]; strictly excluding `.env*`, `.agents`, `.git`, `.multica`, caches, build output, and symlinks/external symlink targets). Staged files are verified and copied using pinned directory descriptors (`dir_fd`, `O_NOFOLLOW`) to prevent symlink traversal and path swaps. Checks `auth.spec.ts` absence in the real source before staging. Frozen lockfile SHA-256 (`a2aeacebb1b8b098b4c96218731cc137812b887c5966f6e20f8361060a80c467`) is verified before and after execution. The assertion script SHA-256 is verified prior to execution to fail closed against post-installation tampering.

### 4.2 Trusted assertions and finite control protocol
- **Pure-data config fingerprint validation**: Unchanged canonical Playwright configuration is treated as fingerprint-verified data (SHA-256 `ac4512bd908d6e4b4204624d2208a0f59076d5f3101b12225aaa8d61e7bc4930`, 979 bytes). The assertion process uses built-in data parsing without importing or executing workspace code or `playwright.config.ts`.
- **Toolchain verification**: Exact Node `24.21.0`, pnpm `12.9.1`, and `@playwright/test` `1.63.0` (read directly from package metadata without executing `createRequire()`).
- **Binary and HTTP availability**: Discovers pre-installed Chromium in `/ms-playwright/chromium-*/chrome-linux64/chrome` directly and performs non-browser HTTP probes to `http://web:5173` and `http://web:5173/login` (verifying HTML entrypoint). HTTP streams are read bounded (max 4096 bytes) using streaming readers with stream cancellation before buffering, throwing `oversized_http_response` on payloads exceeding limits.
- **Test execution boundary**: Asserts `apps/web/tests/e2e/auth.spec.ts` is absent; no browser instances or authentication flows are executed.
- **Output-silent protocol**: The container-side script (`scripts/e2e_preflight.mjs`) neutralizes stdout/stderr (`console.log/error` replaced with no-ops). Child stdout/stderr is discarded at the source boundary (`/dev/null`). Results are written exclusively (`{ flag: 'wx', mode: 0o600 }`) via a strictly validated, invocation-bound control file (`/control/preflight-<inv-id>.json`, maximum 4096 bytes) using schema `s2_e2e_preflight_v1`. Malformed, unknown, oversized, stale, duplicate-key, or forged responses fail closed, with strict JSON typing (rejecting bool-as-int and int-as-bool).

### 4.3 Supervision, timeouts, and recovery instructions
- **Monotonic nonblocking supervision**: Subprocesses are supervised via nonblocking selector loops (`_run_bounded`) enforcing strict monotonic deadlines covering child stdout consumption, process waiting, cancellation, and reaping. Quiet, stalled, or oversized children are terminated within the declared bound without unbounded capture.
- **Detached execution and supervision**: Containers start detached without `-a`, TTY, or payload attachment (`podman start`); supervision is performed via `podman wait` under timeout with independent post-wait inspection of terminal state (`Running: false` and `ExitCode`). Inspection fails closed on bare `0`, non-boolean states, or extra tokens.
- **Container ownership and reconciliation**: Container creation is tracked via dedicated cidfiles and 64-hex CIDs. Container inspection requires exit code 0 and exact invocation label matching (`com.9gotstory.s2.e2e_preflight_inv_id`); inspection failures, exit code 125, label `0`, or missing labels fail closed and never authorize container operations. Interrupted creations are reconciled from cidfiles.
- **Absence confirmation and handle retention**: After container removal (`podman rm`), independent exact-CID absence confirmation (`podman container exists <cid>`) is mandatory before clearing ledger handles. Timeout, error, or contradiction retains handles and workspace. Only confirmed absence of all owned resources authorizes workspace deletion.
- **Non-reentrant signal latching**: Signal handlers (`_handle_signal`) strictly latch cancellation state (`signal_received`) without reentrant cleanup, `sys.exit`, or ledger overwrites. The supervisor commits observed producer events before handling pending cancellation.
- **Finite deterministic exit precedence**: Exit code is resolved strictly by precedence: Natural producer failure != 0 > Signal cancellation != 0 > Controller fault != 0 > Cleanup fault != 0 > 0. A genuine producer failure (e.g. exit 44, 45, 47, 124, 125) is preserved over subsequent cancellation or cleanup faults.
- **Failure recovery state**: On failure or signal interruption, the controller performs container-first cleanup, records unremoved resource handles (container ID, workspace path, manual removal commands), and persists structured recovery metadata to `${ENV_DIR}/s2-e2e-preflight-<inv-id>.log` using atomic replace and filesystem sync (`os.fsync` on file and directory). If persistence fails or cleanup cannot confirm removal, handles are retained and honest fallback recovery instructions are emitted directly to stderr.
- **T033 browser execution gate**: Full browser test execution (`bash scripts/dev.sh e2e`) remains separately gated under T033; unsupported modes fail closed.

## 5. Cleanup and later full-workspace acceptance

`http-smoke` automatically executes fixture cleanup on completion. Standalone cleanup is also available if fixtures were provisioned without `http-smoke` or after partial setup:

```bash
bash scripts/dev.sh test-identity cleanup
compose down
```

The helper removes only this run's proven owned sessions/grants/users, disposes its test runners, and clears secret/cookie state only after successful cleanup. Per Product Owner decision, the shared `SYSTEM_MAINTAINER` role is intentionally preserved and never deleted by fixture cleanup even when unused. Cleanup applies bounded PostgreSQL lock and statement timeouts (supported override range: 1–60,000 milliseconds inclusive via options or FOUNDATION_LOCK_TIMEOUT_MS and FOUNDATION_STATEMENT_TIMEOUT_MS; defaults: 5-second lock timeout, 10-second statement timeout) within the transaction, rolling back and preserving private ownership state if contention occurs. `compose down` uses the same explicit project/file and preserves the PostgreSQL volume. Volume deletion is an explicit destructive action outside this normal guide; do not run global prune/reset or delete unrelated resources.

T039 must later rerun the implemented guide from a clean isolated environment and record exact image/tool versions, commands, responses and failure cleanup. API/Web `typecheck` and `build` run inside containers after those planned scripts exist. Existing real-PostgreSQL integration/transaction tests, lint, CI/security scans, static web build, backup/restore and production-artifact checks retain their accepted task scope and separate authorization; they are not replaced by HTTP smoke or marked complete here. In particular, integration tests that control disposable PostgreSQL require the accepted test runner's rootless socket/CLI setup, not the ordinary application containers. No unimplemented workspace-wide script is presented as an already working command.
