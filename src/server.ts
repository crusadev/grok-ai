/** HTTP API: POST /scrape and GET /health, with a concurrency-limited pool. */
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response,
} from 'express';
import pLimit from 'p-limit';
import { z } from 'zod';
import config from './config';
import { logger } from './logger';
import { scrape } from './scrape';
import { AppError } from './errors';
import type { ScrapeRequest, ScrapeResponse } from './types';

/** Module-scope concurrency pool — caps simultaneous browser sessions. */
const limit = pLimit(config.maxConcurrency);

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

function sendJson(res: Response, status: number, body: ScrapeResponse): void {
  res.status(status).json(body);
}

async function handleScrape(req: Request, res: Response): Promise<void> {
  const parsed = ScrapeSchema.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => i.message).join('; ');
    sendJson(res, 400, { success: false, error: message });
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

  // Reject when the queue is saturated rather than letting clients hang.
  if (config.maxQueue > 0 && limit.pendingCount >= config.maxQueue) {
    sendJson(res, 503, {
      success: false,
      error: 'Server is at capacity, try again later',
    });
    return;
  }

  try {
    const result = await limit(() => scrape(request));
    sendJson(res, 200, { success: true, result });
  } catch (err) {
    const status = err instanceof AppError ? err.httpStatus : 500;
    const message =
      err instanceof AppError ? err.message : 'Internal server error';
    logger.error(
      {
        country: request.country,
        code: err instanceof AppError ? err.code : 'UNKNOWN',
        err: err instanceof Error ? err.message : String(err),
      },
      'scrape request failed',
    );
    sendJson(res, status, { success: false, error: message });
  }
}

function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    activeJobs: limit.activeCount,
    queuedJobs: limit.pendingCount,
  });
}

/** Handles malformed JSON bodies and any other middleware errors. */
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'request error');
  sendJson(res as Response, 400, { success: false, error: 'Invalid request body' });
};

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.post('/scrape', handleScrape);
  app.get('/health', handleHealth);
  app.use(errorHandler);
  return app;
}
