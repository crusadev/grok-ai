/** BullMQ scrape queue and Redis connection helpers. */
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import config from './config';
import type { ScrapeJobData } from './types';

export const QUEUE_NAME = 'scrape';

/** A Redis connection configured for BullMQ (`maxRetriesPerRequest` must be null). */
export function createRedisConnection(): IORedis {
  return new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
}

let connection: IORedis | undefined;
let queue: Queue<ScrapeJobData> | undefined;

function getQueue(): Queue<ScrapeJobData> {
  if (!queue) {
    connection = createRedisConnection();
    queue = new Queue<ScrapeJobData>(QUEUE_NAME, { connection });
  }
  return queue;
}

/** Enqueue a scrape job for the worker to process. */
export async function enqueueScrape(data: ScrapeJobData): Promise<void> {
  // attempts > 1 so a job whose worker is hard-killed mid-scrape (e.g. an
  // autoscaler scale-down) is re-queued by BullMQ's stalled-job detection and
  // finished by another worker — otherwise its DB row stays 'processing'.
  // The processor itself never throws, so a healthy job only ever runs once.
  await getQueue().add('scrape', data, {
    attempts: 3,
    removeOnComplete: 200,
    removeOnFail: 200,
  });
}

/** Close the queue and its Redis connection during shutdown. */
export async function closeQueue(): Promise<void> {
  if (queue) {
    await queue.close().catch(() => undefined);
    queue = undefined;
  }
  if (connection) {
    connection.disconnect();
    connection = undefined;
  }
}
