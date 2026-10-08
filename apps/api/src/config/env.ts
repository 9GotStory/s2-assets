import { z } from 'zod';

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .url('DATABASE_URL must be a valid URL')
    .refine((val) => val.startsWith('postgresql://'), {
      message: 'DATABASE_URL must start with postgresql://',
    }),
});

export type Config = z.infer<typeof configSchema>;

function redactSecrets(message: string): string {
  return message.replace(/(postgresql:\/\/[^:]+:)([^@]+)(@)/gi, '$1***$3');
}

export function loadConfig(env: Record<string, unknown> = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const errorMessages = result.error.issues.map((issue) => {
      const path = issue.path.join('.') || 'config';
      return `${path}: ${issue.message}`;
    });
    const safeMessage = redactSecrets(errorMessages.join('; '));
    throw new Error(`Configuration validation failed: ${safeMessage}`);
  }
  return result.data;
}
