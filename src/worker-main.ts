/** Worker entrypoint: BullMQ worker only — no HTTP server. Scaled horizontally. */
import { logger } from './logger';
import { warmUp, closeBrowser } from './grok';
import { initDb, closeDb } from './db';
import { closeQueue } from './queue';
import { startWorker, stopWorker } from './worker';
import { closeEvents } from './events';

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

// Best-effort: ensure the stealth Chromium binary is present (it is baked into
// the image, so this is a fast no-op in containers).
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
  logger.info({ signal }, 'worker shutting down — draining in-flight jobs');
  void (async () => {
    // stopWorker() waits for in-flight scrape jobs (each up to STREAM_TIMEOUT_MS)
    // to finish so their browsers close cleanly — no orphan Chromium processes.
    await stopWorker();
    await closeBrowser();
    await closeEvents();
    await closeQueue();
    await closeDb();
    logger.info('shutdown complete');
    process.exit(0);
  })();
  // Force-exit only if a job genuinely hangs past the streaming timeout.
  // Stays comfortably under docker-compose stop_grace_period (240s) so we are
  // always the one who terminates the process, never Docker's SIGKILL.
  setTimeout(() => {
    logger.warn('forced shutdown after drain timeout');
    process.exit(1);
  }, 225000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
