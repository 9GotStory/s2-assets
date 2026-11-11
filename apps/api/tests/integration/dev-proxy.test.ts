import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repositoryProxyConfig } from '../../../web/vite.config.ts';
import { startApiHarness, type ApiHarness } from './support/api-harness.ts';

// Probes that the runtime and its health checks call on the API directly, never through the Web.
const NOT_PROXIED = ['/health', '/ready'];

/**
 * The Web dev server forwards to the API only the paths `repositoryProxyConfig` names, in the development
 * runtime and in the Seam B journeys alike; any other path answers the SPA's page. F005-T1's journey failed
 * so on POST /repairs before `/repairs` had its entry.
 */
describe('the Web dev proxy', () => {
  let api: ApiHarness;

  beforeAll(async () => {
    api = await startApiHarness();
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  it('forwards every first path segment the API serves', async () => {
    await api.app.ready();
    // Fastify 5.12.5 prints each route registered at the top as a line of its own at the tree's first level.
    const firstSegments = new Set(
      api.app
        .printRoutes({ commonPrefix: false })
        .split('\n')
        .flatMap((line) => line.match(/^[├└]── (\/[^/ ]+)/)?.[1] ?? [])
    );
    expect(firstSegments.has('/repairs')).toBe(true);

    const served = [...firstSegments].filter((segment) => !NOT_PROXIED.includes(segment)).sort();
    expect(served.filter((segment) => !(segment in repositoryProxyConfig))).toEqual([]);
  });
});
