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
import { AppError } from './errors';
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
      const startedAt = Date.now();
      try {
        const result = await scrape(request);
        await completeJob(publicId, result);
        logger.info(
          { publicId, country: request.country, ms: Date.now() - startedAt },
          'scrape job completed',
        );
      } catch (err) {
        const message =
          err instanceof AppError || err instanceof Error
            ? err.message
            : String(err);
        await failJob(publicId, message);
        logger.warn(
          { publicId, country: request.country, ms: Date.now() - startedAt, err: message },
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
