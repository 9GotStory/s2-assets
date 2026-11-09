# The Playwright runner: Microsoft's pinned image, which holds the browsers, plus the repository's
# Node and pnpm. scripts/ci/e2e.sh builds and runs it.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

RUN curl -fsSL https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.gz | tar -xz --strip-components=1 -C /usr/local && \
    corepack enable && corepack prepare pnpm@12.9.1 --activate
