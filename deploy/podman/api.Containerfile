# Stage 1: Build TypeScript API and install production dependencies
FROM docker.io/library/node:24.21.0-alpine AS builder

# Install build dependencies for native Node.js addons (e.g. node-gyp for argon2)
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

# Copy API TypeScript configuration and source files
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json ./apps/api/
COPY apps/api/src ./apps/api/src

# Compile TypeScript into runnable JavaScript
RUN pnpm --filter api run build

# Deploy isolated production dependencies for the API
RUN pnpm --filter api deploy --prod /deployed-api


# Stage 2: Minimal production runtime image
FROM docker.io/library/node:24.21.0-alpine

WORKDIR /app

# Ensure application directory ownership for non-root execution
RUN chown node:node /app

# Copy production runtime artifacts and pruned dependencies from builder stage
COPY --chown=node:node --from=builder /deployed-api/package.json ./package.json
COPY --chown=node:node --from=builder /deployed-api/dist ./dist
COPY --chown=node:node --from=builder /deployed-api/node_modules ./node_modules

# Run the API as the unprivileged node user
USER node

# Production environment configuration
ENV NODE_ENV=production
ENV PORT=3000

# Expose API operational port
EXPOSE 3000

# Entrypoint using compiled JavaScript without running migrations or embedding dev tooling
CMD ["node", "dist/server.js"]
