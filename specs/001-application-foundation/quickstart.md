# Quickstart: Application Foundation

**Status: T046 direct Playwright readiness accepted.** T041 API bootstrap, T042 Web SPA bootstrap, T043 container-only toolchain, T044 explicit migration and disposable test identity lifecycle, and T045 real HTTP smoke and database outage/recovery verification (`scripts/dev.sh http-smoke` and `apps/api/tests/http/foundation.test.ts`) are implemented and verified. The Product Owner accepted T046 execution at `8ff1c54f2f06cd1e111847aa5093056bb462b3ff` using shared `s2-assets-dev`; audit receipts are retained on issue `9GOTSTORY-233`. T033 real-browser implementation/execution remains separately gated.

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

## 4. T046 direct Playwright readiness; T033 remains separately gated

**Approval required before execution.** These are operator commands, run from Fedora against the existing persistent `s2-assets-dev` Development Runtime. For T046 follow this section only: do not run the stack startup, preparation, migration, fixture, outage or teardown procedures in sections 1–3/5 against shared Development. Node/pnpm/browser tools stay inside Rootless Podman. PR #10's controller remains historical evidence and is excluded from this guide. The [Product Owner direction](https://github.com/9GotStory/s2-assets/pull/10#issuecomment-6247686905) supersedes the earlier planned helper for T046 only.

Reuse the existing PostgreSQL/API/Web services and verified `s2-assets-dev-app` application network. Confirm application, project, service and UID-1001 ownership labels and running state; keep PostgreSQL on its existing database network. Retain the accepted T044/T045 evidence without rerunning their mutating checks. T046 needs no database credentials or test identities and performs no business-data writes; only its dependency workspace, caches and runner containers are disposable. The approved runner must already exist: immutable ID `2a4778c23106d33f9c9c4d98d49adccd6d6fe968d4554e5ec20b9225e16a0175`, derived from `mcr.microsoft.com/playwright:v1.63.0-noble`. Missing tools/image/cache stop at Human Gate; do not download or build anything.

Use the verified Linux/x64/glibc offline inputs: pnpm store parent containing `v11/files` and `v11/index.db`, and metadata parent containing `v11/metadata` and `v11/metadata-full`. The investigated runtime paths were `/home/multica-agent/.local/share/pnpm/store` and `/home/multica-agent/.cache/pnpm`. Select integrity-verified, quiescent copies of these inputs under operator control; a live mutable cache with unknown provenance is insufficient. No cache writer may run during copying; a nonempty SQLite WAL requires a consistent snapshot before proceeding. Both content and metadata are necessary. Never mount or relabel the shared originals writable. The commands copy only those cache components and five canonical regular files; no working-tree secrets, Git/agent directories, source traversal or symlink targets are copied.

Use a dedicated Bash session with `set -euo pipefail` for preparation and the two readiness blocks. Execute blocks separately. On any nonzero result, timeout or interruption, stop readiness checks and use the cleanup instructions below; do not interpret later success as repairing the earlier failure. Keep a concise command/exit record, not raw install output, environment dumps or HTTP bodies. Do not enable shell tracing. Standard host `timeout`, `jq`, Git and coreutils are required in addition to Podman; the pre-provisioned runner must contain `timeout` and `curl`.

```bash
set +x
set -euo pipefail
umask 077
BASE=9b126bd9cceeb4ef4cd6fa690fd868f380049383
IMAGE=2a4778c23106d33f9c9c4d98d49adccd6d6fe968d4554e5ec20b9225e16a0175
DEV_PROJECT=s2-assets-dev
: "${T046_STORE_SEED:?Set the verified quiescent pnpm store parent}"
: "${T046_METADATA_SEED:?Set the verified quiescent pnpm metadata parent}"
test "$(id -u)" = 1001
test "$(timeout -k 2s 10s podman --events-backend=none info --format '{{.Host.Security.Rootless}}')" = true
test "$(timeout -k 2s 10s podman --events-backend=none image inspect "$IMAGE" --format '{{.Id}}')" = "$IMAGE"
for service in postgres api web; do
  timeout -k 2s 10s podman --events-backend=none inspect "$DEV_PROJECT-$service" | \
    jq -e --arg p "$DEV_PROJECT" --arg s "$service" \
    'length == 1 and .[0].Name == ($p + "-" + $s) and .[0].State.Running == true
      and .[0].Config.Labels["io.podman.compose.project"] == $p
      and .[0].Config.Labels["io.podman.compose.service"] == $s
      and .[0].Config.Labels["io.9gotstory.dev-runtime.application"] == "s2-assets"
      and .[0].Config.Labels["io.9gotstory.dev-runtime.kind"] == "persistent-development"
      and .[0].Config.Labels["io.9gotstory.dev-runtime.owner-uid"] == "1001"' >/dev/null
done
WEB_CID=$(timeout -k 2s 10s podman --events-backend=none inspect "$DEV_PROJECT-web" --format '{{.Id}}')
API_CID=$(timeout -k 2s 10s podman --events-backend=none inspect "$DEV_PROJECT-api" --format '{{.Id}}')
[[ "$WEB_CID" =~ ^[0-9a-f]{64}$ && "$API_CID" =~ ^[0-9a-f]{64}$ ]]
APP_NET=s2-assets-dev-app
timeout -k 2s 10s podman --events-backend=none network inspect "$APP_NET" | \
  jq -e --arg p "$DEV_PROJECT" --arg web "$WEB_CID" --arg api "$API_CID" \
  'length == 1 and .[0].name == "s2-assets-dev-app"
    and .[0].labels["io.podman.compose.project"] == $p
    and .[0].labels["io.9gotstory.dev-runtime.application"] == "s2-assets"
    and .[0].labels["io.9gotstory.dev-runtime.owner-uid"] == "1001"
    and (.[0].containers | has($web) and has($api))' >/dev/null
APP_NET_ID=$(timeout -k 2s 10s podman --events-backend=none network inspect "$APP_NET" --format '{{.ID}}')
[[ "$APP_NET_ID" =~ ^[0-9a-f]{64}$ ]]
timeout -k 2s 10s podman --events-backend=none inspect "$WEB_CID" | \
  jq -e --arg n "$APP_NET" --arg id "$APP_NET_ID" \
  '.[0].NetworkSettings.Networks[$n].NetworkID == $id and (.[0].NetworkSettings.Networks[$n].Aliases | index("web") != null)' >/dev/null
install -d -m 700 "${XDG_STATE_HOME:-$HOME/.local/state}/s2-assets-t046"
RUN=$(mktemp -d "${XDG_STATE_HOME:-$HOME/.local/state}/s2-assets-t046/run.XXXXXXXX")
RUN_ID="s2-t046-$(cat /proc/sys/kernel/random/uuid)"
printf '%s\n' "$RUN_ID" > "$RUN/owner"
printf 'Retain this recovery directory: %s\n' "$RUN"
timeout -k 2s 10s podman --events-backend=none inspect \
  s2-assets-dev-postgres s2-assets-dev-api s2-assets-dev-web \
  --format '{{.Name}} {{.Id}} {{.State.StartedAt}} {{.RestartCount}}' > "$RUN/dev.before"
mkdir -p "$RUN/work/apps/web" "$RUN/store/v11" "$RUN/meta/v11"
git archive "$BASE" package.json pnpm-lock.yaml pnpm-workspace.yaml \
  apps/web/package.json apps/web/playwright.config.ts | tar -x -C "$RUN/work"
test ! -s "$T046_STORE_SEED/v11/index.db-wal"
cp -a --reflink=auto --no-preserve=ownership "$T046_STORE_SEED/v11/files" "$T046_STORE_SEED/v11/index.db" "$RUN/store/v11/"
cp -a --reflink=auto --no-preserve=ownership "$T046_METADATA_SEED/v11/metadata" "$T046_METADATA_SEED/v11/metadata-full" "$RUN/meta/v11/"
(cd "$RUN/work" && sha256sum package.json pnpm-lock.yaml pnpm-workspace.yaml apps/web/package.json apps/web/playwright.config.ts) > "$RUN/inputs.sha256"
sha256sum pnpm-lock.yaml > "$RUN/checkout-lock.sha256"
printf "%s  pnpm-lock.yaml\n" a2aeacebb1b8b098b4c96218731cc137812b887c5966f6e20f8361060a80c467 | sha256sum -c -
git show "$BASE:apps/web/playwright.config.ts"
git show "$BASE:apps/web/package.json"
```

Require successful ownership/running-state checks for all three existing services and exact Web/API CIDs, with the verified Development network ID and `web` alias. Fail closed on missing, foreign or ambiguous identities; do not provision replacements. Review canonical configuration as data: `test:e2e` is `playwright test`; Chromium, one worker, 30000/5000 ms timeouts, no retries, `./test-results`, trace retained on failure, failure-only screenshots and video off. Config uses `E2E_BASE_URL`; never import/evaluate it for this readiness check. The current checkout and staged lock must both have SHA-256 `a2aeacebb1b8b098b4c96218731cc137812b887c5966f6e20f8361060a80c467`. The five archived paths at this exact baseline were independently checked as mode-100644 Git blobs; the archive avoids working-tree check/copy races. Reject any different baseline or file identity.

Install in a named runner retained until its identity/status and removal are checked with no network. Podman supplies the actual command exit; timeouts and Podman infrastructure failures are failures, not successful installation. Private working cache copies absorb pnpm writes.

```bash
printf 'pending\n' > "$RUN/install.status"
if timeout -k 5s 150s podman --events-backend=none run \
  --name "$RUN_ID-install" --cidfile "$RUN/install.cid" --label "io.s2.t046=$RUN_ID" \
  --pull=never --network=none --log-driver=none --http-proxy=false \
  --read-only --read-only-tmpfs=false --timeout=140 --unsetenv-all \
  --tmpfs /runner-tmp:rw,size=16m,noexec,nosuid,nodev \
  -v "$RUN/work:/workspace:rw,Z" -v "$RUN/store:/offline-store:rw,Z" \
  -v "$RUN/meta:/runner-tmp/.cache/pnpm:rw,Z" -w /workspace \
  -e HOME=/runner-tmp -e TMPDIR=/runner-tmp -e PNPM_HOME=/runner-tmp/pnpm \
  -e XDG_RUNTIME_DIR=/runner-tmp/runtime -e COREPACK_HOME=/usr/local/share/corepack \
  -e COREPACK_ENABLE_NETWORK=0 -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  -e PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin \
  "$IMAGE" sh -ec 'mkdir -m 700 -p "$XDG_RUNTIME_DIR"; timeout -k 5s 120s pnpm install --offline --frozen-lockfile --store-dir=/offline-store' \
  >/dev/null 2>&1; then INSTALL_STATUS=0; else INSTALL_STATUS=$?; fi
printf "Offline frozen install exit: %s\n" "$INSTALL_STATUS"
printf "%s\n" "$INSTALL_STATUS" > "$RUN/install.status"
test "$INSTALL_STATUS" -eq 0
cid=$(cat "$RUN/install.cid")
[[ "$cid" =~ ^[0-9a-f]{64}$ ]]
proof=$(timeout -k 2s 10s podman --events-backend=none inspect "$cid" \
  --format '{{.Id}} {{.Name}} {{index .Config.Labels "io.s2.t046"}} {{.State.Status}} {{.State.ExitCode}} {{.State.Running}} {{.HostConfig.LogConfig.Type}} {{.HostConfig.ReadonlyRootfs}}')
test "$proof" = "$cid $RUN_ID-install $RUN_ID exited 0 false none true"
printf '%s\n' "$proof" > "$RUN/install.receipt"
```

Require both command exit **0** and the checked, saved container receipt before continuing. A missing/malformed CID, failed inspection, absent container or unexpected terminal/logging/read-only setting fails this phase. Then run the read-only readiness container on the verified application network only. It prints fixed tool versions and Chromium's version, while HTTP bodies/errors are discarded. `--version` starts no browser session. No Playwright test/config evaluation occurs.

```bash
printf 'pending\n' > "$RUN/check.status"
if timeout -k 5s 60s podman --events-backend=none run \
  --name "$RUN_ID-check" --cidfile "$RUN/check.cid" --label "io.s2.t046=$RUN_ID" \
  --pull=never --network "$APP_NET_ID" --log-driver=none --http-proxy=false \
  --read-only --read-only-tmpfs=false --timeout=50 --unsetenv-all \
  --tmpfs /runner-tmp:rw,size=16m,noexec,nosuid,nodev \
  -v "$RUN/work:/workspace:ro,Z" -v "$RUN/store:/offline-store:ro,Z" \
  -w /workspace/apps/web -e HOME=/runner-tmp -e TMPDIR=/runner-tmp \
  -e PNPM_HOME=/runner-tmp/pnpm -e XDG_RUNTIME_DIR=/runner-tmp/runtime \
  -e COREPACK_HOME=/usr/local/share/corepack -e COREPACK_ENABLE_NETWORK=0 \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -e E2E_BASE_URL=http://web:5173 \
  -e PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin \
  "$IMAGE" sh -ec '
    mkdir -m 700 -p "$XDG_RUNTIME_DIR"
    test "$(node --version)" = v24.21.0
    test "$(pnpm --version)" = 12.9.1
    test "$(pnpm exec playwright --version)" = "Version 1.63.0"
    printf "%s\n" "Node 24.21.0; pnpm 12.9.1; Playwright 1.63.0"
    chrome=$(node -p '\''require("@playwright/test").chromium.executablePath()'\'')
    test -x "$chrome"
    "$chrome" --version
    test "$E2E_BASE_URL" = http://web:5173
    for url in http://web:5173/ http://web:5173/login; do
      result=$(curl -q --noproxy "*" --fail --silent --max-time 10 --max-filesize 1048576 \
        --output /dev/null --write-out "%{http_code} %{content_type}" "$url")
      case "$result" in "200 text/html"|"200 text/html;"*) ;; *) exit 1;; esac
    done
    printf "%s\n" "Web / and /login: HTTP 200 HTML"
  '; then CHECK_STATUS=0; else CHECK_STATUS=$?; fi
printf "Readiness exit: %s\n" "$CHECK_STATUS"
printf "%s\n" "$CHECK_STATUS" > "$RUN/check.status"
test "$CHECK_STATUS" -eq 0
cid=$(cat "$RUN/check.cid")
[[ "$cid" =~ ^[0-9a-f]{64}$ ]]
proof=$(timeout -k 2s 10s podman --events-backend=none inspect "$cid" \
  --format '{{.Id}} {{.Name}} {{index .Config.Labels "io.s2.t046"}} {{.State.Status}} {{.State.ExitCode}} {{.State.Running}} {{.HostConfig.LogConfig.Type}} {{.HostConfig.ReadonlyRootfs}}')
test "$proof" = "$cid $RUN_ID-check $RUN_ID exited 0 false none true"
printf '%s\n' "$proof" > "$RUN/check.receipt"
```

Require **0**, matching Chromium from the pinned image/package, and both actual HTTP assertions. This is readiness evidence only; image presence, a package listing or test discovery alone cannot pass T046. Do not run `playwright install`, `pnpm dlx`, `playwright test`, or any browser launch here.

**Successful-run cleanup and evidence:** the two stopped containers remain inspectable after `podman run`, with invocation-specific names, ownership labels and CID files. Both checked receipts are mandatory. The block below rechecks each CID, receipt and effective terminal/logging/read-only state before removal. Unexpected absence or any mismatch fails readiness; never replace it with success. Exit **0 means PRESENT**, **1 means ABSENT** and any other existence result/timeout is uncertain. Remove only the exact verified CID, then independently require absence. Use the separate recovery procedure below after failure/interruption. There is no prefix-based deletion or global prune.

```bash
set -euo pipefail
for phase in install check; do
  name="$RUN_ID-$phase"
  test "$(cat "$RUN/$phase.status")" = 0
  cid=$(cat "$RUN/$phase.cid")
  [[ "$cid" =~ ^[0-9a-f]{64}$ ]]
  expected="$cid $name $RUN_ID exited 0 false none true"
  test "$(cat "$RUN/$phase.receipt")" = "$expected"
  if timeout -k 2s 10s podman --events-backend=none container exists "$name"; then
    proof=$(timeout -k 2s 10s podman --events-backend=none inspect "$cid" \
      --format '{{.Id}} {{.Name}} {{index .Config.Labels "io.s2.t046"}} {{.State.Status}} {{.State.ExitCode}} {{.State.Running}} {{.HostConfig.LogConfig.Type}} {{.HostConfig.ReadonlyRootfs}}')
    test "$proof" = "$expected"
    printf '%s\n' "$proof" >> "$RUN/removed-cids.txt"
    timeout -k 2s 15s podman --events-backend=none rm -f -t 1 "$cid"
    if timeout -k 2s 10s podman --events-backend=none container exists "$cid"; then exit 1; else test "$?" -eq 1; fi
  else
    printf 'Expected phase container is absent or uncertain; readiness failed.\n' >&2
    exit 1
  fi
done
timeout -k 2s 10s podman --events-backend=none inspect \
  s2-assets-dev-postgres s2-assets-dev-api s2-assets-dev-web \
  --format '{{.Name}} {{.Id}} {{.State.StartedAt}} {{.RestartCount}}' > "$RUN/dev.after"
cmp "$RUN/dev.before" "$RUN/dev.after"
sha256sum -c "$RUN/checkout-lock.sha256"
(cd "$RUN/work" && sha256sum -c "$RUN/inputs.sha256")
```

Record exact CID/image, the two command exits, version/HTTP results, absence results, input hashes and persistent comparison. Keep the first failed command's status; record cleanup failure separately. If either runner remains/has uncertain ownership, retain its name/CID and private directory for recovery and report FAIL/HOLD. Only after both runners are independently ABSENT, hashes/invariance pass and the concise non-secret evidence is retained, delete this exact private directory with `rm -rf -- "$RUN"`. No source/cache original or application/database resource is removed by these T046 commands. Do not run Compose teardown, fixture cleanup, migrations or HTTP outage tests against shared Development; T046 owns only its temporary runner resources.

**Failure, timeout or interruption recovery:** the private recovery directory is under the user's state directory, not temporary shell/runtime storage. Record its printed path before either container command. Its `owner` file restores the invocation ID after the shell exits; exact names remain derivable even if creation did not write a CID. The status files start as `pending`, so missing/interrupted completion cannot imply success. Keep the first observed nonzero status and all available files; never replace them with a cleanup result or rerun a phase in the same directory.

In a fresh Bash session, set `RUN` to that recorded directory. If the path was not recorded, list directories under `${XDG_STATE_HOME:-$HOME/.local/state}/s2-assets-t046` and explicitly identify this invocation; do not select or delete by prefix. Run this recovery block separately for `phase=install` and `phase=check`, including after partial successful cleanup. It requires exact ownership before removal but does not require a successful producer state. Failure or uncertain inspection retains the directory and requires Human Gate. If creation could still be in flight, retain everything and report HOLD; immediate absence alone does not establish safe final cleanup.

```bash
set +x
set -euo pipefail
: "${RUN:?Set the recorded private recovery directory}"
RUN_ID=$(cat "$RUN/owner")
[[ "$RUN_ID" =~ ^s2-t046-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
phase=install # Repeat with phase=check.
name="$RUN_ID-$phase"
if timeout -k 2s 10s podman --events-backend=none container exists "$name"; then
  cid=$(timeout -k 2s 10s podman --events-backend=none inspect "$name" --format '{{.Id}}')
  [[ "$cid" =~ ^[0-9a-f]{64}$ ]]
  test "$(timeout -k 2s 10s podman --events-backend=none inspect "$cid" --format '{{.Name}} {{index .Config.Labels "io.s2.t046"}}')" = "$name $RUN_ID"
  test ! -e "$RUN/$phase.cid" || test "$(cat "$RUN/$phase.cid")" = "$cid"
  printf '%s %s\n' "$phase" "$cid" >> "$RUN/recovery-cids.txt"
  timeout -k 2s 15s podman --events-backend=none rm -f -t 1 "$cid"
  if timeout -k 2s 10s podman --events-backend=none container exists "$cid"; then exit 1; else test "$?" -eq 1; fi
else
  test "$?" -eq 1
fi
```

Record both absence results and recheck persistent resources/input hashes using the final commands above. Retain recovery evidence outside any directory selected for deletion; remove the exact private directory only after both containers are confirmed absent and no creation is in flight. Recovery establishes cleanup only, **never readiness PASS**; failed, pending or missing phase evidence remains FAIL/HOLD.

**T033 gate:** T046 does not implement `auth.spec.ts`, run `pnpm --filter web test:e2e`, or complete browser acceptance. After separate T033 authorization, use the unchanged Chromium/single-worker configuration for actual login/dashboard/logout/session-rejection and direct-navigation browser flows, preserving existing failure diagnostics without secrets. A passing readiness report cannot replace that real-browser evidence. Shared Development browser tests additionally require separately approved dedicated identities, run-owned records and exact ownership-based cleanup that preserves unrelated data. The current fixture tooling rejects the Development database target; do not bypass those guards or change persistent service configuration. Resolve this compatibility boundary under T033 authorization before any fixture/browser writes.

## 5. Cleanup and later full-workspace acceptance

`http-smoke` automatically executes fixture cleanup on completion. Standalone cleanup is also available if fixtures were provisioned without `http-smoke` or after partial setup:

```bash
bash scripts/dev.sh test-identity cleanup
compose down
```

The helper removes only this run's proven owned sessions/grants/users, disposes its test runners, and clears secret/cookie state only after successful cleanup. Per Product Owner decision, the shared `SYSTEM_MAINTAINER` role is intentionally preserved and never deleted by fixture cleanup even when unused. Cleanup applies bounded PostgreSQL lock and statement timeouts (supported override range: 1–60,000 milliseconds inclusive via options or FOUNDATION_LOCK_TIMEOUT_MS and FOUNDATION_STATEMENT_TIMEOUT_MS; defaults: 5-second lock timeout, 10-second statement timeout) within the transaction, rolling back and preserving private ownership state if contention occurs. `compose down` uses the same explicit project/file and preserves the PostgreSQL volume. Volume deletion is an explicit destructive action outside this normal guide; do not run global prune/reset or delete unrelated resources.

T039 must later rerun the implemented guide from a clean isolated environment and record exact image/tool versions, commands, responses and failure cleanup. API/Web `typecheck` and `build` run inside containers after those planned scripts exist. Existing real-PostgreSQL integration/transaction tests, lint, CI/security scans, static web build, backup/restore and production-artifact checks retain their accepted task scope and separate authorization; they are not replaced by HTTP smoke or marked complete here. In particular, integration tests that control disposable PostgreSQL require the accepted test runner's rootless socket/CLI setup, not the ordinary application containers. No unimplemented workspace-wide script is presented as an already working command.
