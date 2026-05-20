/**
 * Proxy provider abstraction. Hides per-provider differences (gateway endpoint,
 * username template, static-IP pools, etc.) behind a single interface that the
 * scrape pipeline calls — one place to add a new provider.
 */
import { BadRequestError } from '../errors';

/** Playwright per-context proxy settings. */
export interface ProxyConfig {
  server: string;
  username: string;
  password: string;
}

export interface ProxyProvider {
  /** Stable name for logging / metrics. */
  readonly name: string;
  /** Build per-context proxy settings for the requested country. */
  buildProxy(country: string): ProxyConfig;
  /** Optional preflight (e.g., fetch an IP pool from a REST API). */
  warmUp?(): Promise<void>;
}

/** Validate and normalize a 2-letter ISO country code. */
export function normalizeCountry(input: string): string {
  const cc = input.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(cc)) {
    throw new BadRequestError(
      `Invalid country "${input}": expected a 2-letter ISO code (e.g. "us", "gb").`,
    );
  }
  return cc;
}
