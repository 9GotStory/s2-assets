import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { repositoryProxyConfig } from '../../../web/vite.config.ts';
import { buildApp } from '../../src/app.ts';

// Probes that the runtime and its health checks call on the API directly, never through the Web.
const NOT_PROXIED = ['/health', '/ready'];

/**
 * The Web dev server forwards to the API only the paths `repositoryProxyConfig` names, in the development
 * runtime and in the Seam B journeys alike; any other path answers the SPA's page. F005-T1's journey failed
 * so on POST /repairs before `/repairs` had its entry, and F007-T5's on POST /retirements. Listing the routes
 * needs no database, so this runs with the unit tests (#159 retro).
 */
describe('the Web dev proxy', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Registering the routes queries nothing; a stand-in client is enough to list them.
    app = await buildApp({ db: { query: async () => ({ rows: [] }), end: async () => {} }, logger: false });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('forwards every first path segment the API serves', async () => {
    await app.ready();
    // Fastify 5.12.5 prints each route registered at the top as a line of its own at the tree's first level.
    const firstSegments = new Set(
      app
        .printRoutes({ commonPrefix: false })
        .split('\n')
        .flatMap((line) => line.match(/^[├└]── (\/[^/ ]+)/)?.[1] ?? [])
    );
    expect(firstSegments.has('/repairs')).toBe(true);

    const served = [...firstSegments].filter((segment) => !NOT_PROXIED.includes(segment)).sort();
    expect(served.filter((segment) => !(segment in repositoryProxyConfig))).toEqual([]);
  });
});
