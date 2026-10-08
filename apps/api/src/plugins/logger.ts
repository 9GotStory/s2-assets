import pino, { type Logger, type LoggerOptions, type DestinationStream } from 'pino';

export const REDACTED_PATHS: readonly string[] = [
  'password',
  '*.password',
  '*.*.password',
  '*.*.*.password',
  'token',
  '*.token',
  '*.*.token',
  '*.*.*.token',
  'secret',
  '*.secret',
  '*.*.secret',
  '*.*.*.secret',
  'password_hash',
  '*.password_hash',
  '*.*.password_hash',
  '*.*.*.password_hash',
  'DATABASE_URL',
  '*.DATABASE_URL',
  '*.*.DATABASE_URL',
  '*.*.*.DATABASE_URL',
  'authorization',
  '*.authorization',
  '*.*.authorization',
  '*.*.*.authorization',
  'cookie',
  '*.cookie',
  '*.*.cookie',
  '*.*.*.cookie',
  'headers.authorization',
  '*.headers.authorization',
  '*.*.headers.authorization',
  'headers.cookie',
  '*.headers.cookie',
  '*.*.headers.cookie',
  'req.headers.authorization',
  '*.req.headers.authorization',
  'req.headers.cookie',
  '*.req.headers.cookie',
  'body.password',
  '*.body.password',
  'body.token',
  '*.body.token',
  'body.secret',
  '*.body.secret',
  'req.body.password',
  '*.req.body.password',
  'req.body.token',
  '*.req.body.token',
  'req.body.secret',
  '*.req.body.secret',
];

export const CENSOR_VALUE = '[REDACTED]';

export type AppLoggerOptions = LoggerOptions & {
  stream?: DestinationStream;
};

export type ConfiguredLoggerOptions = Omit<AppLoggerOptions, 'redact'> & {
  redact: {
    paths: string[];
    censor: string | ((value: unknown, path: string[]) => unknown);
    remove?: boolean;
  };
};

export function getLoggerOptions(options?: AppLoggerOptions): ConfiguredLoggerOptions {
  const customRedact = options?.redact;
  let paths = [...REDACTED_PATHS];

  if (customRedact) {
    if (Array.isArray(customRedact)) {
      paths = Array.from(new Set([...paths, ...customRedact]));
    } else if (Array.isArray(customRedact.paths)) {
      paths = Array.from(new Set([...paths, ...customRedact.paths]));
    }
  }

  const censor =
    customRedact && typeof customRedact === 'object' && !Array.isArray(customRedact) && customRedact.censor !== undefined
      ? customRedact.censor
      : CENSOR_VALUE;

  return {
    ...options,
    redact: {
      paths,
      censor,
    },
  };
}

export function createLogger(
  options?: AppLoggerOptions,
  destination?: DestinationStream
): Logger {
  const loggerOptions = getLoggerOptions(options);
  const targetStream = destination ?? options?.stream;

  if (targetStream) {
    return pino(loggerOptions, targetStream);
  }

  return pino(loggerOptions);
}
