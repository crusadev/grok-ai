/** Builds Decodo/Smartproxy residential proxy URLs from a country code. */
import config from './config';
import { BadRequestError } from './errors';

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
 * Build a Decodo residential proxy URL targeting the given country.
 *
 * Country targeting is embedded in the username: `user-{ACCOUNT}-country-{cc}`.
 *
 * The configured endpoint (default `gate.decodo.com:7000`) is the ROTATING
 * endpoint — every connection, and therefore every browser launch, gets a
 * fresh IP. This is exactly what the retry-from-a-new-address strategy needs,
 * so do NOT add a `-session-` token: that would pin a sticky IP and defeat it.
 */
export function buildProxyUrl(countryCode: string): string {
  const cc = normalizeCountry(countryCode);
  const { username, password, host, port, usernameTemplate } = config.proxy;
  // Country targeting is embedded in the auth username. The exact format
  // depends on the Decodo plan, so the template is configurable via
  // DECODO_USERNAME_TEMPLATE (placeholders: {username}, {country}).
  const user = usernameTemplate
    .replace('{username}', username)
    .replace('{country}', cc);
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}`;
}

/** Replace proxy credentials with placeholders so URLs are safe to log. */
export function maskProxyUrl(url: string): string {
  return url.replace(/\/\/[^@/]+@/, '//***:***@');
}
