# Stage 1: Install production dependencies for database migrations
FROM docker.io/library/node:24.21.0-alpine AS builder

# Install build dependencies for native Node.js addons if needed by monorepo dependencies
RUN apk add --no-cache python3 make g++

# Configure corepack and activate exact pnpm 12.9.1
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable && \
    corepack prepare pnpm@12.9.1 --activate && \
    pnpm --version

WORKDIR /build

# Copy monorepo workspace configuration and package manifests for deterministic install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/db/package.json ./packages/db/

# Install workspace dependencies deterministically via frozen lockfile
RUN pnpm install --frozen-lockfile

# Copy packages/db configuration and source files
COPY packages/db/tsconfig.json ./packages/db/
COPY packages/db/src ./packages/db/src

# Deploy isolated production dependencies for the db package
RUN pnpm --filter db deploy --prod /deployed-db


# Stage 2: Minimal production migration runtime image
FROM docker.io/library/node:24.21.0-alpine

WORKDIR /app

# Ensure application directory ownership for non-root execution
RUN chown node:node /app

# Copy production runtime artifacts and pruned dependencies from builder stage
COPY --chown=node:node --from=builder /deployed-db/package.json ./package.json
COPY --chown=node:node --from=builder /deployed-db/src ./src
COPY --chown=node:node --from=builder /deployed-db/node_modules ./node_modules

# Run the migration job as the unprivileged node user
USER node

# Production environment configuration
ENV NODE_ENV=production

# Entrypoint executing the approved migration CLI directly
CMD ["node", "src/migrator.ts", "latest"]
