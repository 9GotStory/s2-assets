import type { FastifyInstance } from 'fastify';

/**
 * Runs `work` with `capability` answered by `answer` instead of the role map, which grants
 * capabilities together and so can hide a gate that fails open. `answer` may throw, to show that a
 * failed lookup fails closed.
 */
export async function withCapabilityAnswer<T>(
  app: FastifyInstance,
  capability: string,
  answer: () => Promise<boolean>,
  work: () => Promise<T>
): Promise<T> {
  const capabilities = app.capabilityService!;
  const original = capabilities.hasCapability;
  capabilities.hasCapability = async (userId: string, asked: string) =>
    asked === capability ? answer() : original.call(capabilities, userId, asked);
  try {
    return await work();
  } finally {
    capabilities.hasCapability = original;
  }
}

/** Runs `work` with `capability` alone denied. */
export const withCapabilityDenied = <T>(app: FastifyInstance, capability: string, work: () => Promise<T>): Promise<T> =>
  withCapabilityAnswer(app, capability, async () => false, work);
