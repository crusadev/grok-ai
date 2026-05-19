/** API entrypoint: HTTP server only — enqueues jobs, serves job status. */
import config from './config';
import { logger } from './logger';
import { createApp } from './server';
import { initDb, closeDb } from './db';
import { closeQueue } from './queue';

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'grok-scraper api listening');
});

// The database is load-bearing for the async job model — fail fast if absent.
initDb().catch((err) => {
  logger.error(
    { err: err instanceof Error ? err.message : String(err) },
    'database init failed — exiting',
  );
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'api shutting down');
  server.close(async (err) => {
    await closeQueue();
    await closeDb();
    if (err) {
      logger.error({ err: err.message }, 'error during shutdown');
      process.exit(1);
    }
    logger.info('shutdown complete');
    process.exit(0);
  });
  setTimeout(() => {
    logger.warn('forced shutdown after timeout');
    process.exit(1);
  }, 15000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
