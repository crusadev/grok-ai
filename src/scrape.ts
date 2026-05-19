/**
 * Scrape orchestration: runs Grok attempts and retries from a fresh proxy IP
 * when an attempt fails for a retryable reason (sign-up wall, Cloudflare,
 * timeout, navigation error).
 */
import config from './config';
import { logger } from './logger';
import { buildProxyUrl, maskProxyUrl } from './proxy';
import { runGrokAttempt } from './grok';
import { AppError, NavigationError } from './errors';
import type { GrokResult, ScrapeRequest } from './types';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with jitter, capped; `attempt` is 1-based. */
function backoffDelay(attempt: number): number {
  const base = config.retryBaseDelayMs * 2 ** (attempt - 1);
  return Math.min(base, config.retryMaxDelayMs) + Math.floor(Math.random() * 250);
}

/**
 * Scrape Grok for the given request, retrying on retryable failures.
 *
 * Each attempt calls `buildProxyUrl`, which targets the Decodo rotating
 * endpoint — so every attempt connects through a brand-new IP automatically.
 */
export async function scrape(req: ScrapeRequest): Promise<GrokResult> {
  const maxAttempts = config.maxRetries + 1;
  let lastError: AppError = new NavigationError('scrape produced no result');

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const proxyUrl = buildProxyUrl(req.country);
    const startedAt = Date.now();
    try {
      const result = await runGrokAttempt({
        prompt: req.prompt,
        proxyUrl,
        include: req.include,
      });
      logger.info(
        {
          attempt,
          maxAttempts,
          country: req.country,
          ms: Date.now() - startedAt,
          sources: result.sources.length,
        },
        'grok attempt succeeded',
      );
      return result;
    } catch (err) {
      const appErr =
        err instanceof AppError ? err : new NavigationError(String(err));
      lastError = appErr;
      logger.warn(
        {
          attempt,
          maxAttempts,
          country: req.country,
          code: appErr.code,
          reason: appErr.message,
          ms: Date.now() - startedAt,
          proxy: maskProxyUrl(proxyUrl),
        },
        'grok attempt failed',
      );
      if (!appErr.retryable || attempt === maxAttempts) {
        throw appErr;
      }
      await sleep(backoffDelay(attempt));
    }
  }

  // Unreachable: the loop either returns or throws.
  throw lastError;
}
