import { defineConfig } from 'vitest/config';
import fs from 'node:fs';

const uid = typeof process.getuid === 'function' ? process.getuid() : 1001;
const podmanSocket = `/run/user/${uid}/podman/podman.sock`;
const hasPodmanSocket = fs.existsSync(podmanSocket);

if (!process.env.TESTCONTAINERS_RYUK_DISABLED) {
  process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
}
if (!process.env.DOCKER_HOST && hasPodmanSocket) {
  process.env.DOCKER_HOST = `unix://${podmanSocket}`;
}

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      TESTCONTAINERS_RYUK_DISABLED: 'true',
      ...(hasPodmanSocket && !process.env.DOCKER_HOST ? { DOCKER_HOST: `unix://${podmanSocket}` } : {}),
    },
  },
});
