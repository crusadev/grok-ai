/**
 * HTTP API for async scrape jobs.
 *  - POST /scrape            → create a job, return its public_id (202)
 *  - GET  /scrape/:public_id → poll job status / result
 *  - GET  /scrapes           → recent job list (history)
 *  - GET  /analytics         → aggregate metrics
 *  - GET  /stats             → live worker / queue stats
 *  - GET  /health            → liveness probe
 */
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response,
} from 'express';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import config from './config';
import { logger } from './logger';
import { createJob, getJob, listJobs, getAnalytics } from './db';
import { enqueueScrape, getQueueStats } from './queue';
import {
  type AppEvent,
  type StatsEvent,
  publishEvent,
  subscribeEvents,
} from './events';
import type { ScrapeRequest } from './types';

const ScrapeSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(1, 'prompt is required')
    .max(8000, 'prompt too long (max 8000 chars)'),
  country: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]{2}$/, 'country must be a 2-letter ISO code')
    .optional(),
  include: z
    .object({
      html: z.boolean().optional(),
      markdown: z.boolean().optional(),
    })
    .optional(),
});

/** Public job id: `cloro_` followed by 15 random alphanumeric characters. */
const ID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PUBLIC_ID_RE = /^cloro_[A-Za-z0-9]{15}$/;

function generatePublicId(): string {
  let id = '';
  for (let i = 0; i < 15; i += 1) {
    id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  }
  return `cloro_${id}`;
}

async function handleCreateScrape(req: Request, res: Response): Promise<void> {
  const parsed = ScrapeSchema.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => i.message).join('; ');
    res.status(400).json({ success: false, error: message });
    return;
  }

  const data = parsed.data;
  const request: ScrapeRequest = {
    prompt: data.prompt,
    country: data.country ?? config.defaultCountry,
    include: {
      html: data.include?.html ?? false,
      markdown: data.include?.markdown ?? false,
    },
  };

  const publicId = generatePublicId();
  try {
    await createJob(publicId, request);
    await enqueueScrape({ publicId, request });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to queue scrape job',
    );
    res.status(503).json({ success: false, error: 'Could not queue the request' });
    return;
  }

  logger.info({ publicId, country: request.country }, 'scrape job queued');
  res.status(202).json({ success: true, public_id: publicId, status: 'processing' });
}

async function handleGetScrape(req: Request, res: Response): Promise<void> {
  const publicId = req.params.public_id;
  if (!PUBLIC_ID_RE.test(publicId)) {
    res.status(400).json({ success: false, error: 'invalid public_id' });
    return;
  }

  let record;
  try {
    record = await getJob(publicId);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), publicId },
      'failed to read job',
    );
    res.status(500).json({ success: false, error: 'Internal server error' });
    return;
  }

  if (!record) {
    res.status(404).json({ success: false, error: 'unknown public_id' });
    return;
  }

  const base = {
    public_id: publicId,
    status: record.status,
    createdAt: record.createdAt,
    scrapeMs: record.scrapeMs,
    totalMs: record.totalMs,
    attempts: record.attempts,
    wallHits: record.wallHits,
  };
  if (record.status === 'success') {
    res.status(200).json({ success: true, ...base, result: record.result });
  } else if (record.status === 'failed') {
    res.status(200).json({
      success: false,
      ...base,
      error: record.error ?? 'scrape failed',
    });
  } else {
    res.status(200).json({ success: true, ...base });
  }
}

async function handleListScrapes(req: Request, res: Response): Promise<void> {
  const rawLimit = Number(req.query.limit);
  const limit =
    Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 500 ? rawLimit : 100;
  const rawOffset = Number(req.query.offset);
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  try {
    res.json({ success: true, jobs: await listJobs(limit, offset) });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to list jobs',
    );
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

async function handleAnalytics(_req: Request, res: Response): Promise<void> {
  try {
    res.json(await getAnalytics());
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to compute analytics',
    );
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

async function handleStats(_req: Request, res: Response): Promise<void> {
  try {
    const { workers, waiting, active } = await getQueueStats();
    // One reused browser per worker process — workers and browsers track 1:1.
    res.json({
      workers,
      browsers: workers,
      tabsPerRequest: config.raceTabs,
      queue: { waiting, active },
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to read stats',
    );
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

function handleHealth(_req: Request, res: Response): void {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
}

/**
 * SSE stream of cross-cluster events. One TCP connection per browser tab; each
 * client gets every job + stats event published on the Redis bus.
 *
 * A heartbeat comment every 15s keeps intermediaries (nginx, load balancers)
 * from closing the connection as idle. We close the response on req `close`.
 */
function handleEvents(req: Request, res: Response): void {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Defensive: also disables nginx buffering even without the location-level flag.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  const send = (event: AppEvent): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const unsubscribe = subscribeEvents(send);
  const heartbeat = setInterval(() => res.write(':\n\n'), 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
}

/**
 * Stats ticker: every second, publish a stats event to the bus IF any field
 * changed since the last tick. One shared ticker per api process, started on
 * the first /events subscribe and stopped on shutdown — no point billing
 * Redis when nobody is watching.
 */
let statsTimer: NodeJS.Timeout | undefined;
let lastStatsKey = '';

async function pollStats(): Promise<void> {
  try {
    const { workers, waiting, active } = await getQueueStats();
    const event: StatsEvent = {
      type: 'stats',
      workers,
      tabsPerRequest: config.raceTabs,
      queue: { waiting, active },
    };
    const key = `${workers}|${waiting}|${active}`;
    if (key === lastStatsKey) return;
    lastStatsKey = key;
    publishEvent(event);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'stats ticker failed',
    );
  }
}

export function startStatsTicker(): void {
  if (statsTimer) return;
  statsTimer = setInterval(() => void pollStats(), 1000);
  void pollStats();
}

export function stopStatsTicker(): void {
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = undefined;
  }
}

/** Handles malformed JSON bodies and any other middleware errors. */
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  logger.warn(
    { err: err instanceof Error ? err.message : String(err) },
    'request error',
  );
  (res as Response)
    .status(400)
    .json({ success: false, error: 'Invalid request body' });
};

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.post('/scrape', handleCreateScrape);
  app.get('/scrapes', handleListScrapes);
  app.get('/scrape/:public_id', handleGetScrape);
  app.get('/analytics', handleAnalytics);
  app.get('/stats', handleStats);
  app.get('/events', handleEvents);
  app.get('/health', handleHealth);
  app.use(errorHandler);
  return app;
}
