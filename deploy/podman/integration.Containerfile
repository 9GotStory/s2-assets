# The PostgreSQL integration test runner: the development tooling image (dev.Containerfile, built
# as s2-assets-dev:ci) plus a remote Podman CLI. Through that CLI, tests/integration/health.test.ts
# stops and starts its database container on the Podman socket that CONTAINER_HOST names.
# scripts/ci/integration.sh builds and runs it.
FROM s2-assets-dev:ci

USER root
RUN apk add --no-cache podman curl bash
RUN printf '#!/bin/sh\nexec /usr/bin/podman --remote --url "${CONTAINER_HOST:?CONTAINER_HOST must name the Podman socket}" "$@"\n' \
      > /usr/local/bin/podman \
    && chmod +x /usr/local/bin/podman
