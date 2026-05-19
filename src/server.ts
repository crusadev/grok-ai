/**
 * HTTP API for async scrape jobs.
 *  - POST /scrape            → create a job, return its public_id (202)
 *  - GET  /scrape/:public_id → poll job status / result
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
import { createJob, getJob } from './db';
import { enqueueScrape } from './queue';
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

  if (record.status === 'success') {
    res.status(200).json({
      success: true,
      public_id: publicId,
      status: 'success',
      result: record.result,
    });
  } else if (record.status === 'failed') {
    res.status(200).json({
      success: false,
      public_id: publicId,
      status: 'failed',
      error: record.error ?? 'scrape failed',
    });
  } else {
    res.status(200).json({ success: true, public_id: publicId, status: 'processing' });
  }
}

function handleHealth(_req: Request, res: Response): void {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
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
  app.get('/scrape/:public_id', handleGetScrape);
  app.get('/health', handleHealth);
  app.use(errorHandler);
  return app;
}
