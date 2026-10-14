import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import pg from 'pg';
import {
  CapabilityService,
  type DatabaseClient,
} from '../services/capability.service.ts';
import { requireCapability } from '../middleware/authorization.ts';

export interface SystemRoutesOptions {
  databaseUrl?: string;
  db?: DatabaseClient | any;
  capabilityService?: CapabilityService;
}

/**
 * System Routes Plugin (T026 - User Story 2)
 *
 * Defines capability-protected system endpoints.
 * Mounts GET /info (external path: GET /system/info) protected by 'system:maintain' capability.
 */
export const systemRoutes: FastifyPluginAsync<SystemRoutesOptions> = async (
  fastify: FastifyInstance,
  options: SystemRoutesOptions = {}
): Promise<void> => {
  // 1. Resolve CapabilityService Dependency
  let capabilityService: CapabilityService | undefined = options.capabilityService;

  if (!capabilityService && fastify.capabilityService) {
    capabilityService = fastify.capabilityService;
  }

  // 2. Resolve database client & connection pool ownership
  // Prefer explicitly injected shared database client when supplied
  let internalPool: pg.Pool | null = null;
  if (!capabilityService) {
    let dbClient = options.db ?? (fastify as any).pg?.pool ?? (fastify as any).pg;

    if (!dbClient) {
      if (options.databaseUrl) {
        internalPool = new pg.Pool({ connectionString: options.databaseUrl });
        dbClient = internalPool;
      } else if (process.env.DATABASE_URL) {
        internalPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
        dbClient = internalPool;
      }
    }

    if (dbClient) {
      capabilityService = new CapabilityService({ db: dbClient });
    }
  }

  // Register proper onClose cleanup for any pool created by the route plugin.
  // Never close an externally owned database client.
  if (internalPool) {
    fastify.addHook('onClose', async () => {
      await internalPool?.end();
    });
  }

  // Decorate fastify instance if not already present
  if (capabilityService && !fastify.hasDecorator('capabilityService')) {
    fastify.decorate('capabilityService', capabilityService);
  }

  // 3. Register Protected System Route
  // Route defined locally as GET /info (external path: GET /system/info)
  // Protected by Fastify preHandler requiring 'system:maintain' capability
  fastify.get(
    '/info',
    {
      preHandler: [requireCapability('system:maintain', { capabilityService })],
    },
    async (_request: FastifyRequest, _reply: FastifyReply) => {
      return { status: 'ok' };
    }
  );
};

export default systemRoutes;
