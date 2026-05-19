/**
 * Scrape orchestration.
 *
 * A worker reuses one long-lived browser across jobs. For each job, `raceTabs`
 * opens up to `raceTabs` contexts ("tabs") in parallel, each through its own
 * fresh rotating proxy IP. The first tab to answer wins — and the losing tabs
 * are aborted immediately by closing their contexts. A walled tab is replaced
 * by a fresh one until an answer arrives, the attempt budget is spent, or the
 * per-job wall-clock deadline is hit.
 */
import config from './config';
import { logger } from './logger';
import { buildProxy } from './proxy';
import { getBrowser, runGrokAttempt } from './grok';
import { AppError, NavigationError, TimeoutError } from './errors';
import type { Browser, BrowserContext } from 'playwright-core';
import type { GrokResult, JobStats, ScrapeRequest } from './types';

/** Outcome of a scrape() call — never throws; carries attempt stats either way. */
export interface ScrapeOutcome {
  result?: GrokResult;
  error?: AppError;
  stats: JobStats;
}

/** Pick the most informative error from the failed attempts. */
function pickError(errors: AppError[]): AppError {
  return (
    errors.find((e) => !e.retryable) ??
    errors[errors.length - 1] ??
    new NavigationError('scrape produced no result')
  );
}

/** Run the replenishing tab race inside the shared browser, recording stats. */
function raceTabs(
  browser: Browser,
  req: ScrapeRequest,
  stats: JobStats,
): Promise<GrokResult> {
  return new Promise<GrokResult>((resolve, reject) => {
    const { raceTabs: tabs, maxAttempts, jobDeadlineMs } = config;
    const errors: AppError[] = [];
    const startedAt = Date.now();
    const liveContexts = new Set<BrowserContext>();
    let started = 0;
    let liveSlots = tabs;
    let settled = false;

    /** Abort every still-open tab (used on win, failure, or deadline). */
    const closeAll = (): void => {
      for (const ctx of liveContexts) void ctx.close().catch(() => undefined);
      liveContexts.clear();
    };
    // Only attempts that completed organically (errored on their own, or won)
    // count. Concurrent losers that we abort at the moment of victory are NOT
    // attempts — they were racing siblings, cancelled because they were no
    // longer needed.
    const recordStats = (won: boolean): void => {
      stats.attempts = errors.length + (won ? 1 : 0);
      stats.wallHits = errors.filter((e) => e.code === 'SIGNUP_WALL').length;
    };
    const win = (result: GrokResult, meta: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      recordStats(true);
      logger.info({ ...meta, attempts: stats.attempts, wallHits: stats.wallHits }, 'scrape succeeded');
      closeAll();
      resolve(result);
    };
    const fail = (err: AppError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      recordStats(false);
      closeAll();
      reject(err);
    };
    const timer = setTimeout(
      () => fail(new TimeoutError('scrape job deadline exceeded')),
      jobDeadlineMs,
    );

    // A slot opens fresh tabs until one wins, an unrecoverable error occurs,
    // or the shared attempt budget is exhausted.
    async function runSlot(slot: number): Promise<void> {
      while (!settled && started < maxAttempts) {
        const attempt = (started += 1);
        let context: BrowserContext | undefined;
        try {
          context = await browser.newContext({ proxy: buildProxy(req.country) });
          liveContexts.add(context);
          const result = await runGrokAttempt(context, {
            prompt: req.prompt,
            include: req.include,
          });
          win(result, {
            attempt,
            slot,
            country: req.country,
            ms: Date.now() - startedAt,
            sources: result.sources.length,
          });
          return;
        } catch (err) {
          const appErr =
            err instanceof AppError ? err : new NavigationError(String(err));
          errors.push(appErr);
          logger.warn(
            { attempt, slot, country: req.country, code: appErr.code },
            'tab attempt failed',
          );
          if (!appErr.retryable) {
            fail(appErr);
            return;
          }
          // Retryable — loop and open a fresh tab in this slot.
        } finally {
          if (context) {
            liveContexts.delete(context);
            await context.close().catch(() => undefined);
          }
        }
      }
      liveSlots -= 1;
      if (liveSlots === 0) fail(pickError(errors));
    }

    for (let i = 0; i < tabs; i += 1) void runSlot(i + 1);
  });
}

/**
 * Scrape Grok for the given request. Never throws — returns a `ScrapeOutcome`
 * carrying either the answer or the error, plus per-job attempt stats.
 */
export async function scrape(req: ScrapeRequest): Promise<ScrapeOutcome> {
  const stats: JobStats = { attempts: 0, wallHits: 0 };
  try {
    const browser = await getBrowser();
    const result = await raceTabs(browser, req, stats);
    return { result, stats };
  } catch (err) {
    const error = err instanceof AppError ? err : new NavigationError(String(err));
    return { error, stats };
  }
}
