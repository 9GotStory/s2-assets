import { loadConfig } from './config/env.ts';
import { buildApp } from './app.ts';
import { isValidSigningSecret, MIN_COOKIE_SECRET_BYTES } from './plugins/csrf.ts';

function redactSecrets(message: string): string {
  return message.replace(/(postgresql:\/\/[^:]+:)([^@]+)(@)/gi, '$1***$3');
}

let isShuttingDown = false;

export async function startServer(): Promise<void> {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  try {
    // 1. Validate environment configuration before any operational startup
    const config = loadConfig(process.env);

    // 2. Enforce strict cookie signing secret requirement in production before listening
    if (config.NODE_ENV === 'production') {
      const cookieSecret = process.env.COOKIE_SECRET ?? process.env.CSRF_SECRET;
      if (!cookieSecret || !isValidSigningSecret(cookieSecret)) {
        throw new Error(
          `CSRF cookie signing is required in production: Provide a secret of at least ${MIN_COOKIE_SECRET_BYTES} bytes via COOKIE_SECRET or CSRF_SECRET.`
        );
      }
    }

    // 3. Compose application without listening
    app = await buildApp({ config });

    // 4. Attach graceful shutdown handlers
    const handleShutdown = async (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;

      app?.log?.info?.({ signal }, 'Received termination signal, starting graceful shutdown');

      try {
        await app?.close();
        app?.log?.info?.('Graceful shutdown completed');
        process.exit(0);
      } catch (closeErr) {
        app?.log?.error?.(closeErr, 'Error during graceful shutdown');
        process.exit(1);
      }
    };

    process.on('SIGINT', () => {
      void handleShutdown('SIGINT');
    });

    process.on('SIGTERM', () => {
      void handleShutdown('SIGTERM');
    });

    // 5. Open operational listener
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    app.log.info({ port: config.PORT, host: '0.0.0.0' }, 'Server listening');
  } catch (err: unknown) {
    // Release any acquired app resources if available
    if (app) {
      await app.close().catch(() => {});
    }

    const rawMessage = err instanceof Error ? err.message : String(err);
    const safeMessage = redactSecrets(rawMessage);
    console.error(`Fatal startup error: ${safeMessage}`);
    process.exit(1);
  }
}

// Auto-start when executed as the process entrypoint
const isMain = Boolean(
  process.argv[1] &&
    (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'))
);

if (isMain) {
  void startServer();
}
