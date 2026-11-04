FROM docker.io/library/node:24.21.0-alpine

# Install build dependencies for native Node.js addons (e.g. node-gyp for argon2)
RUN apk add --no-cache python3 make g++ postgresql-client

# Configure corepack and pre-activate exact pnpm 12.9.1
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable && \
    corepack prepare pnpm@12.9.1 --activate && \
    pnpm --version && \
    chmod -R 777 /usr/local/share/corepack

# Configure writable home and cache directories for Rootless keep-id container users
ENV HOME=/tmp
ENV PNPM_HOME=/tmp/.pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /work
