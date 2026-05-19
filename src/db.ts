/**
 * PostgreSQL storage for scrape jobs.
 *
 * A job row is created with status `processing` when a request arrives, then
 * updated to `success` (with the result) or `failed` (with an error) by the
 * worker. The async API reads job state back by `public_id`.
 */
import { Pool } from 'pg';
import config from './config';
import { logger } from './logger';
import { publishEvent } from './events';
import type {
  Analytics,
  GrokResult,
  JobRecord,
  JobStatus,
  JobSummary,
  ScrapeRequest,
} from './types';

/** Timing + attempt stats recorded when a job finishes. */
interface JobUpdateMeta {
  startedAtMs: number;
  attempts: number;
  wallHits: number;
}

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: config.databaseUrl, max: config.pgPoolMax });
    pool.on('error', (err) => logger.warn({ err: err.message }, 'postgres pool error'));
  }
  return pool;
}

/**
 * Idempotent schema migration — safe on both fresh and existing databases.
 * Wrapped in a transaction-scoped advisory lock so the api and the (possibly
 * many) worker processes can all call `initDb()` concurrently without racing
 * on the DDL.
 */
const MIGRATION = `
BEGIN;
SELECT pg_advisory_xact_lock(4242424242);
CREATE TABLE IF NOT EXISTS scrape_results (
  id         BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  prompt     TEXT NOT NULL,
  country    TEXT NOT NULL,
  text       TEXT,
  sources    JSONB,
  html       TEXT,
  markdown   TEXT
);
ALTER TABLE scrape_results ADD COLUMN IF NOT EXISTS public_id  TEXT;
ALTER TABLE scrape_results ADD COLUMN IF NOT EXISTS status     TEXT NOT NULL DEFAULT 'processing';
ALTER TABLE scrape_results ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE scrape_results ADD COLUMN IF NOT EXISTS error      TEXT;
ALTER TABLE scrape_results ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE scrape_results ADD COLUMN IF NOT EXISTS attempts   INT;
ALTER TABLE scrape_results ADD COLUMN IF NOT EXISTS wall_hits  INT;
ALTER TABLE scrape_results ALTER COLUMN public_id TYPE TEXT;
ALTER TABLE scrape_results ALTER COLUMN text DROP NOT NULL;
ALTER TABLE scrape_results ALTER COLUMN sources DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS scrape_results_public_id_key ON scrape_results (public_id);
COMMIT;`;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Run the migration, retrying briefly so the server can start with the DB. */
export async function initDb(): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await getPool().query(MIGRATION);
      logger.info('database ready');
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === 5) {
        throw new Error(`database unavailable: ${message}`);
      }
      logger.info({ attempt }, 'waiting for database...');
      await sleep(2000);
    }
  }
}

/** Insert a new job row in the `processing` state. Throws on failure. */
export async function createJob(
  publicId: string,
  request: ScrapeRequest,
): Promise<void> {
  await getPool().query(
    `INSERT INTO scrape_results (public_id, status, prompt, country)
     VALUES ($1, 'processing', $2, $3)`,
    [publicId, request.prompt, request.country],
  );
  publishEvent({
    type: 'job',
    summary: {
      publicId,
      prompt: request.prompt,
      country: request.country,
      status: 'processing',
      createdAt: new Date().toISOString(),
      scrapeMs: null,
      totalMs: null,
      attempts: null,
      wallHits: null,
    },
  });
}

/** Mark a job successful and store its result + stats. Never throws. */
export async function completeJob(
  publicId: string,
  result: GrokResult,
  meta: JobUpdateMeta,
): Promise<void> {
  try {
    const { rows } = await getPool().query(
      `UPDATE scrape_results
       SET status = 'success', text = $2, sources = $3::jsonb,
           html = $4, markdown = $5, error = NULL,
           started_at = to_timestamp($6 / 1000.0), attempts = $7,
           wall_hits = $8, updated_at = now()
       WHERE public_id = $1
       RETURNING ${SUMMARY_COLUMNS}`,
      [
        publicId,
        result.text,
        JSON.stringify(result.sources),
        result.html ?? null,
        result.markdown ?? null,
        meta.startedAtMs,
        meta.attempts,
        meta.wallHits,
      ],
    );
    if (rows.length > 0) publishEvent({ type: 'job', summary: toSummary(rows[0] as SummaryRow) });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), publicId },
      'failed to mark job successful',
    );
  }
}

/** Mark a job failed with an error message + stats. Never throws. */
export async function failJob(
  publicId: string,
  error: string,
  meta: JobUpdateMeta,
): Promise<void> {
  try {
    const { rows } = await getPool().query(
      `UPDATE scrape_results
       SET status = 'failed', error = $2,
           started_at = to_timestamp($3 / 1000.0), attempts = $4,
           wall_hits = $5, updated_at = now()
       WHERE public_id = $1
       RETURNING ${SUMMARY_COLUMNS}`,
      [publicId, error, meta.startedAtMs, meta.attempts, meta.wallHits],
    );
    if (rows.length > 0) publishEvent({ type: 'job', summary: toSummary(rows[0] as SummaryRow) });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), publicId },
      'failed to mark job failed',
    );
  }
}

/** Columns for a job summary, including derived scrape/total durations (ms). */
const SUMMARY_COLUMNS = `
  public_id, prompt, country, status, created_at, error, attempts, wall_hits,
  (EXTRACT(EPOCH FROM (updated_at - started_at)) * 1000)::int AS scrape_ms,
  (EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000)::int AS total_ms`;

interface SummaryRow {
  public_id: string;
  prompt: string;
  country: string;
  status: JobStatus;
  created_at: Date;
  error: string | null;
  attempts: number | null;
  wall_hits: number | null;
  scrape_ms: number | null;
  total_ms: number | null;
}

function toSummary(row: SummaryRow): JobSummary {
  const summary: JobSummary = {
    publicId: row.public_id,
    prompt: row.prompt,
    country: row.country,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    scrapeMs: row.scrape_ms,
    totalMs: row.total_ms,
    attempts: row.attempts,
    wallHits: row.wall_hits,
  };
  if (row.error !== null) summary.error = row.error;
  return summary;
}

/** Read a full job (summary + answer) by public id; null if unknown. */
export async function getJob(publicId: string): Promise<JobRecord | null> {
  const { rows } = await getPool().query(
    `SELECT ${SUMMARY_COLUMNS}, text, sources, html, markdown
     FROM scrape_results WHERE public_id = $1`,
    [publicId],
  );
  if (rows.length === 0) return null;

  const row = rows[0] as SummaryRow & {
    text: string | null;
    sources: string[] | null;
    html: string | null;
    markdown: string | null;
  };
  const record: JobRecord = toSummary(row);
  if (row.status === 'success') {
    const result: GrokResult = { text: row.text ?? '', sources: row.sources ?? [] };
    if (row.html !== null) result.html = row.html;
    if (row.markdown !== null) result.markdown = row.markdown;
    record.result = result;
  }
  return record;
}

/**
 * List recent jobs (newest first), without the answer bodies. Offset pagination
 * is good enough at PoC scale; under a steady stream of inserts, page 2+ rows
 * drift down by one every time a new job is created — acceptable for a history
 * view of a benchmark run, would want cursor pagination for production.
 */
export async function listJobs(limit: number, offset = 0): Promise<JobSummary[]> {
  const { rows } = await getPool().query(
    `SELECT ${SUMMARY_COLUMNS} FROM scrape_results
     ORDER BY created_at DESC, id DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return (rows as SummaryRow[]).map(toSummary);
}

/** Aggregate metrics across all jobs. */
export async function getAnalytics(): Promise<Analytics> {
  const { rows } = await getPool().query(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE status = 'success')::int AS success,
       count(*) FILTER (WHERE status = 'failed')::int AS failed,
       count(*) FILTER (WHERE status = 'processing')::int AS processing,
       avg(EXTRACT(EPOCH FROM (updated_at - started_at)) * 1000)
         FILTER (WHERE status = 'success' AND started_at IS NOT NULL) AS avg_scrape_ms,
       avg(EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000)
         FILTER (WHERE status IN ('success', 'failed') AND started_at IS NOT NULL)
         AS avg_total_ms
     FROM scrape_results`,
  );
  const r = rows[0] as {
    total: number;
    success: number;
    failed: number;
    processing: number;
    avg_scrape_ms: string | null;
    avg_total_ms: string | null;
  };
  const finished = r.success + r.failed;
  return {
    total: r.total,
    success: r.success,
    failed: r.failed,
    processing: r.processing,
    successRate: finished > 0 ? Math.round((r.success / finished) * 1000) / 10 : 0,
    avgScrapeMs: r.avg_scrape_ms === null ? null : Math.round(Number(r.avg_scrape_ms)),
    avgTotalMs: r.avg_total_ms === null ? null : Math.round(Number(r.avg_total_ms)),
  };
}

/** Close the connection pool during shutdown. */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end().catch(() => undefined);
    pool = undefined;
  }
}
