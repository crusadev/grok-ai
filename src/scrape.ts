/**
 * Scrape orchestration.
 *
 * One browser is launched per request. Inside it, `raceTabs` contexts ("tabs")
 * run in parallel, each routed through its own fresh rotating proxy IP. The
 * first tab to return an answer wins; the rest are torn down with the browser.
 * When a tab fails fast (e.g. the sign-up wall) it is replaced by a new tab,
 * keeping the pool full until a result arrives or the attempt budget is spent.
 */
import config from './config';
import { logger } from './logger';
import { buildProxy } from './proxy';
import { launchBrowser, runGrokAttempt } from './grok';
import { AppError, NavigationError } from './errors';
import type { Browser } from 'playwright-core';
import type { GrokResult, ScrapeRequest } from './types';

/** Pick the most informative error from the failed attempts. */
function pickError(errors: AppError[]): AppError {
  return (
    errors.find((e) => !e.retryable) ??
    errors[errors.length - 1] ??
    new NavigationError('scrape produced no result')
  );
}

/** Run the replenishing tab race inside an already-launched browser. */
function raceTabs(browser: Browser, req: ScrapeRequest): Promise<GrokResult> {
  return new Promise<GrokResult>((resolve, reject) => {
    const { raceTabs: tabs, maxAttempts } = config;
    const errors: AppError[] = [];
    const startedAt = Date.now();
    let started = 0;
    let liveSlots = tabs;
    let settled = false;

    // A slot keeps opening fresh tabs until one wins, an unrecoverable error
    // occurs, or the shared attempt budget is exhausted.
    async function runSlot(slot: number): Promise<void> {
      while (!settled && started < maxAttempts) {
        const attempt = (started += 1);
        try {
          const result = await runGrokAttempt(browser, {
            prompt: req.prompt,
            proxy: buildProxy(req.country),
            include: req.include,
          });
          if (!settled) {
            settled = true;
            logger.info(
              {
                attempt,
                slot,
                country: req.country,
                ms: Date.now() - startedAt,
                sources: result.sources.length,
              },
              'scrape succeeded',
            );
            resolve(result);
          }
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
            if (!settled) {
              settled = true;
              reject(appErr);
            }
            return;
          }
          // Retryable — loop and open a fresh tab in this slot.
        }
      }
      liveSlots -= 1;
      if (liveSlots === 0 && !settled) {
        settled = true;
        reject(pickError(errors));
      }
    }

    for (let i = 0; i < tabs; i += 1) void runSlot(i + 1);
  });
}

/**
 * Scrape Grok for the given request. Returns the first successful answer from
 * the tab race; throws an AppError if every attempt fails.
 */
export async function scrape(req: ScrapeRequest): Promise<GrokResult> {
  const browser = await launchBrowser();
  try {
    return await raceTabs(browser, req);
  } finally {
    if (config.debugKeepBrowser) {
      logger.warn('DEBUG_KEEP_BROWSER is set — leaving the browser open');
    } else {
      await browser
        .close()
        .catch((e) => logger.warn({ err: String(e) }, 'browser close failed'));
    }
  }
}
