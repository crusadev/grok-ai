/** Entrypoint: HTTP server + BullMQ worker, with startup and graceful shutdown. */
import config from './config';
import { logger } from './logger';
import { createApp } from './server';
import { warmUp } from './grok';
import { initDb, closeDb } from './db';
import { closeQueue } from './queue';
import { startWorker, stopWorker } from './worker';

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'grok-scraper listening');
});

async function boot(): Promise<void> {
  // The database is load-bearing for the async job model — fail fast if absent.
  try {
    await initDb();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'database init failed — exiting',
    );
    process.exit(1);
  }
  startWorker();
}
void boot();

// Best-effort: pre-download the stealth Chromium binary so the first job is
// not slowed by the ~200MB download.
warmUp()
  .then(() => logger.info('stealth browser binary ready'))
  .catch((err) =>
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'browser warm-up failed (will download on first job)',
    ),
  );

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down — waiting for in-flight work');
  server.close(async (err) => {
    await stopWorker();
    await closeQueue();
    await closeDb();
    if (err) {
      logger.error({ err: err.message }, 'error during shutdown');
      process.exit(1);
    }
    logger.info('shutdown complete');
    process.exit(0);
  });
  // Force-exit if in-flight work does not drain in time.
  setTimeout(() => {
    logger.warn('forced shutdown after timeout');
    process.exit(1);
  }, 30000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
