/** Entrypoint: start the HTTP server, warm up the browser, handle shutdown. */
import config from './config';
import { logger } from './logger';
import { createApp } from './server';
import { warmUp } from './grok';
import { initDb, closeDb } from './db';

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info(
    { port: config.port, maxConcurrency: config.maxConcurrency },
    'grok-scraper listening',
  );
});

// Prepare the results table (non-fatal — storage is best-effort).
void initDb();

// Best-effort: pre-download the stealth Chromium binary so the first request
// is not delayed by the ~200MB download. Failure here is non-fatal.
warmUp()
  .then(() => logger.info('stealth browser binary ready'))
  .catch((err) =>
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'browser warm-up failed (will download on first request)',
    ),
  );

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down — waiting for in-flight requests');
  server.close(async (err) => {
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
