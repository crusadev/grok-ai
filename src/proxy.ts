/** Builds Decodo/Smartproxy residential proxy settings from a country code. */
import config from './config';
import { BadRequestError } from './errors';

/** Playwright per-context proxy settings. */
export interface ProxyConfig {
  server: string;
  username: string;
  password: string;
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

/**
 * Build a Decodo proxy config targeting the given country, for use as a
 * per-context proxy (`browser.newContext({ proxy })`).
 *
 * Country targeting is embedded in the auth username. The configured endpoint
 * (default `gate.decodo.com:7000`) is the ROTATING endpoint — every connection,
 * and so every context, gets a fresh IP. Do NOT add a `-session-` token: that
 * would pin a sticky IP and defeat the per-tab fresh-IP strategy.
 */
export function buildProxy(countryCode: string): ProxyConfig {
  const cc = normalizeCountry(countryCode);
  const { username, password, host, port, usernameTemplate } = config.proxy;
  const user = usernameTemplate
    .replace('{username}', username)
    .replace('{country}', cc);
  return { server: `http://${host}:${port}`, username: user, password };
}
