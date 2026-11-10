// The API's packages that the web journeys (apps/web/tests/e2e) drive, resolved from apps/api so that
// they keep their types: the web workspace does not depend on them.
export { default as pg } from 'pg';
export type { FastifyInstance } from 'fastify';
export { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
