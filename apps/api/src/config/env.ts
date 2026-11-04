import { z } from 'zod';

export function validatePublicAppOrigin(
  origin: unknown,
  nodeEnv: string = 'development'
): string | undefined {
  if (origin === undefined || origin === null || origin === '') {
    return undefined;
  }
  if (typeof origin !== 'string') {
    throw new Error('PUBLIC_APP_ORIGIN must be a string');
  }
  if (Buffer.byteLength(origin, 'utf8') > 512) {
    throw new Error('PUBLIC_APP_ORIGIN must not exceed 512 UTF-8 bytes');
  }
  for (let i = 0; i < origin.length; i++) {
    const code = origin.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      throw new Error('PUBLIC_APP_ORIGIN must not contain whitespace or control characters');
    }
  }
  if (/\s/.test(origin)) {
    throw new Error('PUBLIC_APP_ORIGIN must not contain whitespace or control characters');
  }
  if (origin.includes('\\')) {
    throw new Error('PUBLIC_APP_ORIGIN must not contain backslashes');
  }

  // Raw syntax boundary validation prior to WHATWG URL parser normalization
  if (origin.includes('?')) {
    throw new Error('PUBLIC_APP_ORIGIN must not contain query parameters');
  }
  if (origin.includes('#')) {
    throw new Error('PUBLIC_APP_ORIGIN must not contain fragments');
  }
  if (origin.includes('@')) {
    throw new Error('PUBLIC_APP_ORIGIN must not contain userinfo');
  }
  if (!origin.startsWith('http://') && !origin.startsWith('https://')) {
    throw new Error('PUBLIC_APP_ORIGIN must begin with http:// or https://');
  }

  const rest = origin.startsWith('https://') ? origin.slice(8) : origin.slice(7);
  if (rest.length === 0 || rest.startsWith('/')) {
    throw new Error('PUBLIC_APP_ORIGIN must have a valid authority');
  }
  const slashIndex = rest.indexOf('/');
  if (slashIndex !== -1 && slashIndex !== rest.length - 1) {
    throw new Error('PUBLIC_APP_ORIGIN must not contain a path');
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('PUBLIC_APP_ORIGIN must be a valid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('PUBLIC_APP_ORIGIN protocol must be http: or https:');
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    throw new Error('PUBLIC_APP_ORIGIN must have a valid hostname');
  }

  if (
    hostname === '0.0.0.0' ||
    hostname === '::' ||
    hostname === '[::]' ||
    hostname.includes('*')
  ) {
    throw new Error('PUBLIC_APP_ORIGIN must not use wildcard hosts');
  }

  if (parsed.protocol === 'http:') {
    if (nodeEnv === 'production') {
      throw new Error('PUBLIC_APP_ORIGIN must use https: in production');
    }
    const isLoopback =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      /^127\.\d+\.\d+\.\d+$/.test(hostname);

    if (!isLoopback) {
      throw new Error('PUBLIC_APP_ORIGIN with http: must be a loopback address');
    }
  }

  if (parsed.port !== '') {
    const portNum = Number(parsed.port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      throw new Error('PUBLIC_APP_ORIGIN port must be between 1 and 65535');
    }
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('PUBLIC_APP_ORIGIN must not contain userinfo');
  }

  if (parsed.search !== '') {
    throw new Error('PUBLIC_APP_ORIGIN must not contain query parameters');
  }

  if (parsed.hash !== '') {
    throw new Error('PUBLIC_APP_ORIGIN must not contain fragments');
  }

  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('PUBLIC_APP_ORIGIN must not contain a path');
  }

  return parsed.origin;
}

export const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .url('DATABASE_URL must be a valid URL')
      .refine((val) => val.startsWith('postgresql://'), {
        message: 'DATABASE_URL must start with postgresql://',
      }),
    PUBLIC_APP_ORIGIN: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.PUBLIC_APP_ORIGIN !== undefined && data.PUBLIC_APP_ORIGIN !== '') {
      try {
        validatePublicAppOrigin(data.PUBLIC_APP_ORIGIN, data.NODE_ENV);
      } catch (err: any) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['PUBLIC_APP_ORIGIN'],
          message: err?.message || 'Invalid PUBLIC_APP_ORIGIN',
        });
      }
    }
  })
  .transform((data) => {
    return {
      ...data,
      PUBLIC_APP_ORIGIN:
        data.PUBLIC_APP_ORIGIN !== undefined && data.PUBLIC_APP_ORIGIN !== ''
          ? validatePublicAppOrigin(data.PUBLIC_APP_ORIGIN, data.NODE_ENV)
          : undefined,
    };
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
