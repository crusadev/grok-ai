/**
 * Queue-depth autoscaler (runs on the HOST, not in a container).
 *
 * Every tick it reads the BullMQ scrape-queue depth and scales the Docker
 * Compose `worker` service up or down via `docker compose --scale`, bounded by
 * `MAX_WORKER_REPLICAS` so total concurrent jobs can never exceed the RAM
 * budget. This is the single-box analogue of a k8s KEDA ScaledObject.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Queue } from 'bullmq';
import config from './config';
import { logger } from './logger';
import { QUEUE_NAME, createRedisConnection } from './queue';

const execFileAsync = promisify(execFile);
const TICK_MS = 15000;

const connection = createRedisConnection();
const queue = new Queue(QUEUE_NAME, { connection });

let currentReplicas = 1;
let applying = false;

/** Worker replicas wanted for the current backlog, clamped to the RAM-safe cap. */
function desiredReplicas(backlog: number): number {
  if (backlog === 0) return 1;
  const want = Math.ceil(backlog / config.workerConcurrency);
  return Math.min(Math.max(want, 1), config.maxWorkerReplicas);
}

async function scaleTo(replicas: number): Promise<void> {
  await execFileAsync('docker', [
    'compose',
    'up',
    '-d',
    '--no-recreate',
    '--scale',
    `worker=${replicas}`,
  ]);
  currentReplicas = replicas;
}

async function tick(): Promise<void> {
  if (applying) return;
  try {
    const [waiting, active] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
    ]);
    const want = desiredReplicas(waiting + active);
    if (want !== currentReplicas) {
      applying = true;
      logger.info(
        { waiting, active, from: currentReplicas, to: want },
        'autoscaling worker replicas',
      );
      await scaleTo(want);
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'autoscaler tick failed',
    );
  } finally {
    applying = false;
  }
}

logger.info(
  { maxReplicas: config.maxWorkerReplicas, workerConcurrency: config.workerConcurrency },
  'autoscaler started',
);
const timer = setInterval(() => void tick(), TICK_MS);
void tick();

function shutdown(signal: string): void {
  logger.info({ signal }, 'autoscaler shutting down');
  clearInterval(timer);
  void queue.close().finally(() => {
    connection.disconnect();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
