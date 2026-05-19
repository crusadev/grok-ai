/**
 * PostgreSQL storage for successful scrape results.
 *
 * All operations are non-fatal: if the database is unavailable, failures are
 * logged and the scrape request still succeeds — storage is best-effort.
 */
import { Pool } from 'pg';
import config from './config';
import { logger } from './logger';
import type { GrokResult, ScrapeRequest } from './types';

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: config.databaseUrl, max: 4 });
    pool.on('error', (err) => logger.warn({ err: err.message }, 'postgres pool error'));
  }
  return pool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scrape_results (
  id         BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  prompt     TEXT NOT NULL,
  country    TEXT NOT NULL,
  text       TEXT NOT NULL,
  sources    JSONB NOT NULL DEFAULT '[]'::jsonb,
  html       TEXT,
  markdown   TEXT
);`;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create the results table if missing. Retries briefly so the server can be
 * started alongside `docker compose up`. Non-fatal — logs and continues.
 */
export async function initDb(): Promise<void> {
  if (!config.dbEnabled) {
    logger.info('database storage disabled (DB_ENABLED=false)');
    return;
  }
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await getPool().query(SCHEMA);
      logger.info('database ready');
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === 5) {
        logger.warn({ err: message }, 'database init failed — results will not be stored');
        return;
      }
      logger.info({ attempt }, 'waiting for database...');
      await sleep(2000);
    }
  }
}

/** Persist a successful scrape. Never throws to the caller. */
export async function storeResult(
  request: ScrapeRequest,
  result: GrokResult,
): Promise<void> {
  if (!config.dbEnabled) return;
  try {
    await getPool().query(
      `INSERT INTO scrape_results (prompt, country, text, sources, html, markdown)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [
        request.prompt,
        request.country,
        result.text,
        JSON.stringify(result.sources),
        result.html ?? null,
        result.markdown ?? null,
      ],
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to store scrape result',
    );
  }
}

/** Close the connection pool during shutdown. */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end().catch(() => undefined);
    pool = undefined;
  }
}
