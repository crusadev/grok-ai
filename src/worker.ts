/**
 * BullMQ worker — pulls scrape jobs off the queue, runs the scrape, and writes
 * the outcome (`success` + result, or `failed` + error) back to the database.
 */
import { Worker } from 'bullmq';
import config from './config';
import { logger } from './logger';
import { QUEUE_NAME, createRedisConnection } from './queue';
import { scrape } from './scrape';
import { completeJob, failJob } from './db';
import type { ScrapeJobData } from './types';

let worker: Worker<ScrapeJobData> | undefined;
let connection: ReturnType<typeof createRedisConnection> | undefined;

export function startWorker(): void {
  if (worker) return;
  connection = createRedisConnection();
  worker = new Worker<ScrapeJobData>(
    QUEUE_NAME,
    async (job) => {
      const { publicId, request } = job.data;
      const startedAtMs = Date.now();
      // scrape() never throws — it returns the answer or the error plus stats.
      const outcome = await scrape(request);
      const meta = {
        startedAtMs,
        attempts: outcome.stats.attempts,
        wallHits: outcome.stats.wallHits,
      };
      if (outcome.result) {
        await completeJob(publicId, outcome.result, meta);
        logger.info(
          { publicId, country: request.country, ms: Date.now() - startedAtMs, ...outcome.stats },
          'scrape job completed',
        );
      } else {
        const message = outcome.error?.message ?? 'scrape failed';
        await failJob(publicId, message, meta);
        logger.warn(
          {
            publicId,
            country: request.country,
            ms: Date.now() - startedAtMs,
            err: message,
            wallHits: outcome.stats.wallHits,
          },
          'scrape job failed',
        );
      }
    },
    { connection, concurrency: config.workerConcurrency },
  );
  worker.on('error', (err) => logger.warn({ err: err.message }, 'worker error'));
  logger.info({ concurrency: config.workerConcurrency }, 'scrape worker started');
}

/** Stop the worker and close its Redis connection during shutdown. */
export async function stopWorker(): Promise<void> {
  if (worker) {
    await worker.close().catch(() => undefined);
    worker = undefined;
  }
  if (connection) {
    connection.disconnect();
    connection = undefined;
  }
}
