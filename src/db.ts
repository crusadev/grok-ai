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
import type { GrokResult, JobRecord, JobStatus, ScrapeRequest } from './types';

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
}

/** Mark a job successful and store its result. Never throws to the caller. */
export async function completeJob(
  publicId: string,
  result: GrokResult,
): Promise<void> {
  try {
    await getPool().query(
      `UPDATE scrape_results
       SET status = 'success', text = $2, sources = $3::jsonb,
           html = $4, markdown = $5, error = NULL, updated_at = now()
       WHERE public_id = $1`,
      [
        publicId,
        result.text,
        JSON.stringify(result.sources),
        result.html ?? null,
        result.markdown ?? null,
      ],
    );
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), publicId },
      'failed to mark job successful',
    );
  }
}

/** Mark a job failed with an error message. Never throws to the caller. */
export async function failJob(publicId: string, error: string): Promise<void> {
  try {
    await getPool().query(
      `UPDATE scrape_results
       SET status = 'failed', error = $2, updated_at = now()
       WHERE public_id = $1`,
      [publicId, error],
    );
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), publicId },
      'failed to mark job failed',
    );
  }
}

/** Read a job back by public id; null if it does not exist. Throws on DB error. */
export async function getJob(publicId: string): Promise<JobRecord | null> {
  const { rows } = await getPool().query(
    `SELECT public_id, status, text, sources, html, markdown, error
     FROM scrape_results WHERE public_id = $1`,
    [publicId],
  );
  if (rows.length === 0) return null;

  const row = rows[0] as {
    public_id: string;
    status: JobStatus;
    text: string | null;
    sources: string[] | null;
    html: string | null;
    markdown: string | null;
    error: string | null;
  };

  const record: JobRecord = { publicId: row.public_id, status: row.status };
  if (row.status === 'success') {
    const result: GrokResult = { text: row.text ?? '', sources: row.sources ?? [] };
    if (row.html !== null) result.html = row.html;
    if (row.markdown !== null) result.markdown = row.markdown;
    record.result = result;
  }
  if (row.error !== null) record.error = row.error;
  return record;
}

/** Close the connection pool during shutdown. */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end().catch(() => undefined);
    pool = undefined;
  }
}
