#!/usr/bin/env bash
# Sourced by the job scripts in this directory, each running from the repository root.
#
# One job runs at a time on a host, because jobs started together starve each other: in F003-T2 an
# integration run beside Playwright and the builds timed out a 60-second beforeAll, and finished no
# sooner. A job started during another waits here. Descriptor 9 holds the lock until the job exits.
lock_dir=${XDG_RUNTIME_DIR:-/tmp}
[[ -w $lock_dir ]] || lock_dir=/tmp
exec 9>"$lock_dir/s2-assets-ci.lock"
if ! flock --nonblock 9; then
  echo "${0##*/}: waiting for another job in scripts/ci to finish" >&2
  flock 9
fi

note() { echo "${0##*/}: $*"; }

# Sets `socket` to the rootless Podman socket that DOCKER_HOST names. When it names no unix socket,
# starts a private Podman service for this job and stops it when the job exits.
podman_service_pid=
stop_podman_service() {
  [[ -n $podman_service_pid ]] || return 0
  kill "$podman_service_pid" 2>/dev/null || true
  wait "$podman_service_pid" 2>/dev/null || true
  rm -f "$socket"
  rmdir "${socket%/*}" 2>/dev/null || true
}
use_podman_socket() {
  if [[ ${DOCKER_HOST:-} == unix://* ]]; then
    socket=${DOCKER_HOST#unix://}
  else
    socket=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/s2-assets-ci/podman.sock
    mkdir -p "${socket%/*}"
    podman system service --time=0 "unix://$socket" 9>&- &
    podman_service_pid=$!
    for _ in {1..40}; do
      [[ -S $socket ]] && break
      sleep 0.25
    done
  fi
  trap stop_podman_service EXIT
  [[ -S $socket ]] || { note "no Podman socket at $socket" >&2; exit 1; }
}

# Testcontainers asks for the short name; tag it where the host does not resolve it to docker.io.
ensure_postgres_image() {
  local image=postgres:18.6-alpine
  if ! podman image exists "$image"; then
    podman pull --quiet "docker.io/library/$image" >/dev/null
    podman image exists "$image" || podman tag "docker.io/library/$image" "$image"
  fi
}

test_containers() { podman ps -aq --no-trunc --filter label=org.testcontainers=true | sort; }

# Removes the test containers that are not in the listing $1, and counts in `failures` any that stay.
remove_new_test_containers() {
  local before=$1 id leaked
  for id in $(comm -13 <(printf '%s\n' "$before") <(test_containers)); do
    note "removing test container $id"
    podman rm -f "$id" >/dev/null || failures=$((failures + 1))
  done
  leaked=$(comm -13 <(printf '%s\n' "$before") <(test_containers))
  if [[ -n $leaked ]]; then
    note "test containers still present: $leaked" >&2
    failures=$((failures + 1))
  fi
}
