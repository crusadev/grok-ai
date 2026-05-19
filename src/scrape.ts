/**
 * Scrape orchestration. Each round launches several browser attempts in
 * parallel — every one through a fresh rotating proxy IP — and takes the first
 * that succeeds (`Promise.any`). If a whole round fails, it backs off and
 * retries until the answer is obtained or the retry budget is spent.
 */
import config from './config';
import { logger } from './logger';
import { buildProxyUrl } from './proxy';
import { runGrokAttempt } from './grok';
import { AppError, NavigationError } from './errors';
import type { GrokResult, ScrapeRequest } from './types';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with jitter, capped; `round` is 1-based. */
function backoffDelay(round: number): number {
  const base = config.retryBaseDelayMs * 2 ** (round - 1);
  return Math.min(base, config.retryMaxDelayMs) + Math.floor(Math.random() * 250);
}

/** Pick the most informative error from a failed round's rejections. */
function pickError(errors: unknown[]): AppError {
  const appErrors = errors.map((e) =>
    e instanceof AppError ? e : new NavigationError(String(e)),
  );
  // A non-retryable error means stop immediately; otherwise report the last.
  return (
    appErrors.find((e) => !e.retryable) ??
    appErrors[appErrors.length - 1] ??
    new NavigationError('scrape failed')
  );
}

/**
 * Scrape Grok for the given request. Returns the first successful answer from
 * a race of `config.raceBrowsers` parallel attempts; throws an AppError if
 * every round fails.
 */
export async function scrape(req: ScrapeRequest): Promise<GrokResult> {
  const rounds = config.maxRetries + 1;
  let lastError: AppError = new NavigationError('scrape produced no result');

  for (let round = 1; round <= rounds; round += 1) {
    const startedAt = Date.now();
    const attempts = Array.from({ length: config.raceBrowsers }, () =>
      runGrokAttempt({
        prompt: req.prompt,
        proxyUrl: buildProxyUrl(req.country),
        include: req.include,
      }),
    );

    try {
      // First attempt to succeed wins; the losers run on and close themselves.
      const result = await Promise.any(attempts);
      logger.info(
        {
          round,
          country: req.country,
          browsers: attempts.length,
          ms: Date.now() - startedAt,
          sources: result.sources.length,
        },
        'scrape round succeeded',
      );
      return result;
    } catch (err) {
      const errors = err instanceof AggregateError ? err.errors : [err];
      lastError = pickError(errors);
      logger.warn(
        {
          round,
          rounds,
          country: req.country,
          code: lastError.code,
          ms: Date.now() - startedAt,
        },
        'scrape round failed',
      );
      if (!lastError.retryable || round === rounds) throw lastError;
      await sleep(backoffDelay(round));
    }
  }

  throw lastError;
}
