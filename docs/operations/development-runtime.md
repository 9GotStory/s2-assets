# Development runtime — UID-1000 rootless Podman + systemd Quadlet

The persistent development runtime for s2-assets (Product Owner decision 2026-11-03): one
PostgreSQL database, one API and one Web dev server, owned end to end by the workspace user
(`thanakorn`, UID 1000) and managed by the user's systemd manager through Quadlet. It follows
the same pattern as the Songhealth development runtime on this host, but shares no resource
with it or with any other project: every unit, container, network, volume, secret and port
below belongs to s2-assets alone.

It replaces the UID-1001 (`multica-agent`) Compose runtime `s2-assets-dev` (Web at
`127.0.0.1:5173`), which was coordinated by Multica and retired on 2026-11-03. This runtime
started from a fresh database: no data, credentials or caches were taken from UID 1001.

Authority: `TECHNOLOGY.md` v1.2.0 §9 (Development environment, Development orchestration).

## Topology

| Resource | Value |
| --- | --- |
| Web | `http://127.0.0.1:5180/` — Vite dev server (`pnpm --filter web run dev`), loopback only; its dev proxy forwards the API's paths that `repositoryProxyConfig` in `apps/web/vite.config.ts` names to `http://api:3000`; `apps/api/tests/integration/dev-proxy.test.ts` fails when an API path has no entry |
| API | `http://127.0.0.1:3010/` — Fastify dev server (`pnpm --filter api run dev`), loopback only (`/health`, `/ready`); `PUBLIC_APP_ORIGIN=http://127.0.0.1:5180`, so QR label links open the Web |
| Units (`~/.config/containers/systemd/`) | `s2-assets-dev.network`, `s2-assets-dev-db-data.volume`, `s2-assets-dev-db.container`, `s2-assets-dev-api.container`, `s2-assets-dev-web.container` (sources in `deploy/dev-quadlet/`) |
| Services | `s2-assets-dev-db.service`, `s2-assets-dev-api.service`, `s2-assets-dev-web.service` (user manager; started with the user session) |
| Containers | `s2-assets-qdev-db`, `s2-assets-qdev-api` (alias `api`), `s2-assets-qdev-web` (alias `web`) |
| Database | `postgres:18.6-alpine@sha256:10a5c69a…` (the Feature 001 Compose image, pinned by digest); database and owner role `s2_assets_qdev`; no host port |
| Tooling image | `localhost/s2-assets-qdev-tooling:latest`, built by the installer from `deploy/podman/dev.Containerfile` (Node 24.21.0, pnpm 12.9.1); rebuilt when that Containerfile changes |
| Network | `s2-assets-qdev` (private) |
| Volume | `s2-assets-qdev-db-data` (PostgreSQL 18 parent path `/var/lib/postgresql`, label `io.s2-assets.runtime=qdev`) |
| Secrets | podman secrets `s2-assets-qdev-db-password`, `s2-assets-qdev-database-url` (`DATABASE_URL`), `s2-assets-qdev-cookie-secret` (`COOKIE_SECRET`) |
| Source | `~/dev/s2-assets-quadlet` — a full clone of the workspace repository at a **detached, promoted commit**, bind-mounted at `/work` as the host user (`UserNS=keep-id`); the commit is recorded in `.s2-assets-qdev-source-identity` |
| Local state | `~/.local/state/s2-assets-qdev/` (0700): `backups/`, and the transient first-initialization flag |

## Install

```bash
cd ~/dev/s2-assets                     # any checkout that contains this runtime
scripts/dev-runtime-install.sh --sha <40-hex commit>
```

After the first install, run every runtime script from the runtime's own checkout,
`~/dev/s2-assets-quadlet/scripts/`: those scripts always belong to the promoted commit.

The installer converges the host to this runtime and is **safe to re-run**; each step checks
the real state first and only adds what is missing:

1. **Preflight.** UID 1000; the required tools; the user manager is running; ports 3010 and
   5180 are free unless this runtime already holds them.
2. **Source.** Clones the workspace repository into `~/dev/s2-assets-quadlet` at the commit,
   then continues with **that commit's** installer.
3. **Images.** Pulls the pinned database image; builds the tooling image when it is missing
   or was built from another `dev.Containerfile`.
4. **Dependencies.** `pnpm install --frozen-lockfile` in a temporary tooling container, only
   when `pnpm-lock.yaml` or the tooling image changed; fails if the lockfile changes.
5. **Secrets.** Generates the three secrets once, all or none; values pass only through stdin
   pipes, never argv, the environment or output.
6. **Volume.** Creates the labeled data volume; never adopts an unlabeled one.
7. **Units.** Copies the units, checks the Quadlet generation, runs `daemon-reload`, and
   restarts a running service whose unit changed.
8. **Database.** On the first start the image initializes the cluster. The database unit
   refuses an empty volume unless the installer authorized exactly that first initialization,
   so a lost or recreated volume never comes back silently as a fresh database.
9. **Migrations.** The Feature 001 explicit migration (`pnpm --filter db migrate:latest`) in a
   one-off container on the private network; then checks that none is pending.
10. **API and Web.** Starts both services (each waits until its container is healthy).
11. **Verify.** Runs `scripts/dev-runtime-verify.sh`.

## Daily use

- **Open.** Web `http://127.0.0.1:5180/`; API probes `http://127.0.0.1:3010/health` and
  `/ready`.
- **Logs.** `journalctl --user -u s2-assets-dev-api.service -f` (and `-web`, `-db`).
- **Start/stop.** `systemctl --user start|stop|restart s2-assets-dev-api.service` (and `-web`,
  `-db`). Stopping the database stops the API, and stopping the API stops the Web. The services
  start with the user session. Linger is **not** enabled, so the runtime stops when the last
  session ends; enabling it (`loginctl enable-linger`) is a separate decision.
- **Hot reload.** The API (`node --watch`) and Web (Vite) reload from the runtime checkout, so
  they serve the promoted commit. Develop in a workspace worktree and promote commits; do not
  edit `~/dev/s2-assets-quadlet` (the scripts refuse a modified checkout).
- **Check.** `~/dev/s2-assets-quadlet/scripts/dev-runtime-verify.sh` is read-only and prints one
  PASS/FAIL line per check.
- **Accounts.** The fresh database has the migrated schema and no user accounts. Creating a
  development login is not part of this runtime: the Feature 001 test-identity fixture refuses
  the development database by design, and a development identity needs its own Product Owner
  decision.
- **Disposable test stacks.** The Feature 001 Compose tooling (`scripts/dev.sh`,
  `deploy/podman/compose.yaml`) still runs separate, disposable stacks under any explicit
  project name. Its default ports 3000 and 5173 differ from this runtime's.

## Promote a commit

```bash
~/dev/s2-assets-quadlet/scripts/dev-runtime-update.sh --sha <commit> [--no-backup]
```

The commit must be on a branch or a remote-tracking branch of the workspace repository; fetch
a commit made on GitHub (such as a pull request's merge) there first with `git fetch origin`.
The update:

1. backs up the database with `scripts/backup.sh` (custom format, mode 0600) to
   `~/.local/state/s2-assets-qdev/backups/s2_assets_qdev-<UTC>-<previous short SHA>.dump`.
   `--no-backup` skips this, and only the rollback and the restore below use it, right after
   loading a backup;
2. stops the Web and API, moves the checkout to the commit and records it;
3. hands over to that commit's installer, which rebuilds and reinstalls only what changed,
   applies pending migrations, starts the API and Web and verifies.

Migrations only move forward, and the migrator refuses a database that has applied a
migration its commit does not have. To roll back after a new migration ran, recreate the
database from the backup taken before it, then promote the backup's commit. This replaces
the development database, so it needs a Product Owner decision:

```bash
systemctl --user stop s2-assets-dev-web.service s2-assets-dev-api.service
podman exec s2-assets-qdev-db psql -X -q -U s2_assets_qdev -d postgres \
  -c 'DROP DATABASE s2_assets_qdev WITH (FORCE)' -c 'CREATE DATABASE s2_assets_qdev'
podman exec -i s2-assets-qdev-db pg_restore -U s2_assets_qdev -d s2_assets_qdev \
  < ~/.local/state/s2-assets-qdev/backups/<file>.dump
~/dev/s2-assets-quadlet/scripts/dev-runtime-update.sh --sha <the backup's commit> --no-backup
```

## Restore a lost database

When the data volume is lost or recreated, the database unit refuses to start and the
installer refuses to initialize the volume again, so the database never comes back empty
without notice. Restoring needs a Product Owner decision:

1. `~/dev/s2-assets-quadlet/scripts/dev-runtime-install.sh --sha <promoted commit> --init-empty-database`
   initializes an empty cluster with the existing secrets and applies the migrations;
2. load the backup as in the rollback above (stop the Web and API, recreate the database,
   `pg_restore`), then promote the backup's commit with `--no-backup`.

## Uninstall

```bash
~/dev/s2-assets-quadlet/scripts/dev-runtime-uninstall.sh          # stop, remove the units; keep data
~/dev/s2-assets-quadlet/scripts/dev-runtime-uninstall.sh --purge  # also delete the database volume,
                                                                   # secrets, network and tooling image
```

`--purge` asks for the typed confirmation `purge s2-assets-qdev`, refuses a database volume
without the runtime's label, and needs a Product Owner decision. Neither form deletes the
source checkout or the backups.

## Separation from other runtimes

- The runtime touches only the `s2-assets-dev*` units and `s2-assets-qdev*` resources above.
  It never reads, stops or removes Songhealth's (`songhealth-dev*`, `songhealth-qdev*`) or any
  other project's units and resources.
- The production Quadlet units in `deploy/podman/quadlet/` are a different, unchanged
  deployment target with their own names (`s2-assets-*`, `s2-assets.network`).
- UID 1000's Podman storage is shared with those projects: it holds their images and volumes,
  among them Songhealth's accepted production image `localhost/songhealth-app:0.0.1`, which no
  rebuild reproduces. Keep every `podman … prune` command off this host user;
  `podman volume prune` and `podman system prune --volumes` would also delete this runtime's
  database volume whenever its container is stopped.
