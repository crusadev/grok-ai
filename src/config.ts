/**
 * Environment configuration — the single source of truth.
 * No other module reads `process.env` directly.
 *
 * On any missing/invalid variable, prints an aggregated error and exits the
 * process: a misconfigured server should fail fast at startup, not mid-request.
 */
import { config as loadDotenv } from 'dotenv';

loadDotenv();

const errors: string[] = [];

function rawStr(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed === '' ? undefined : trimmed;
}

function requiredStr(name: string): string {
  const v = rawStr(name);
  if (v === undefined) {
    errors.push(`Missing required env var: ${name}`);
    return '';
  }
  return v;
}

function str(name: string, def: string): string {
  return rawStr(name) ?? def;
}

function int(name: string, def: number, min: number): number {
  const v = rawStr(name);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) {
    errors.push(`Invalid env var ${name}="${v}": expected integer >= ${min}`);
    return def;
  }
  return n;
}

function bool(name: string, def: boolean): boolean {
  const v = rawStr(name)?.toLowerCase();
  if (v === undefined) return def;
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  errors.push(`Invalid env var ${name}="${v}": expected boolean`);
  return def;
}

/** Parse a comma-separated env var into a trimmed, non-empty string list. */
function list(name: string): string[] {
  const v = rawStr(name);
  if (v === undefined) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function country(name: string, def: string): string {
  const v = (rawStr(name) ?? def).toLowerCase();
  if (!/^[a-z]{2}$/.test(v)) {
    errors.push(`Invalid env var ${name}="${v}": expected 2-letter country code`);
    return def;
  }
  return v;
}

/** Logical grok.com elements whose selectors can be overridden via env. */
export type SelectorKey =
  | 'promptInput'
  | 'sendButton'
  | 'answerMessage'
  | 'answerContent'
  | 'stopButton'
  | 'completionMarker'
  | 'sourceLinks'
  | 'sourcesPanel';

const SELECTOR_ENV: Record<SelectorKey, string> = {
  promptInput: 'SELECTOR_PROMPT_INPUT',
  sendButton: 'SELECTOR_SEND_BUTTON',
  answerMessage: 'SELECTOR_ANSWER_MESSAGE',
  answerContent: 'SELECTOR_ANSWER_CONTENT',
  stopButton: 'SELECTOR_STOP_BUTTON',
  completionMarker: 'SELECTOR_COMPLETION_MARKER',
  sourceLinks: 'SELECTOR_SOURCE_LINKS',
  sourcesPanel: 'SELECTOR_SOURCES_PANEL',
};

export interface AppConfig {
  port: number;
  proxy: {
    username: string;
    password: string;
    host: string;
    port: number;
    /** Auth-username template; `{username}` and `{country}` are substituted. */
    usernameTemplate: string;
  };
  maxConcurrency: number;
  maxQueue: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  navTimeoutMs: number;
  streamTimeoutMs: number;
  headless: boolean;
  humanize: boolean;
  /** Debug: leave the browser open after an attempt so the DOM can be inspected. */
  debugKeepBrowser: boolean;
  defaultCountry: string;
  logLevel: string;
  /** Per-element selector overrides; empty list means "use built-in defaults". */
  selectorOverrides: Record<SelectorKey, string[]>;
}

const selectorOverrides = Object.fromEntries(
  (Object.keys(SELECTOR_ENV) as SelectorKey[]).map((key) => [key, list(SELECTOR_ENV[key])]),
) as Record<SelectorKey, string[]>;

const config: AppConfig = {
  port: int('PORT', 3000, 1),
  proxy: {
    username: requiredStr('DECODO_USERNAME'),
    password: requiredStr('DECODO_PASSWORD'),
    host: str('DECODO_HOST', 'gate.decodo.com'),
    port: int('DECODO_PORT', 7000, 1),
    usernameTemplate: str('DECODO_USERNAME_TEMPLATE', 'user-{username}-country-{country}'),
  },
  maxConcurrency: int('MAX_CONCURRENCY', 3, 1),
  maxQueue: int('MAX_QUEUE', 50, 0),
  maxRetries: int('MAX_RETRIES', 3, 0),
  retryBaseDelayMs: int('RETRY_BASE_DELAY_MS', 1000, 0),
  retryMaxDelayMs: int('RETRY_MAX_DELAY_MS', 8000, 0),
  navTimeoutMs: int('NAV_TIMEOUT_MS', 45000, 1000),
  streamTimeoutMs: int('STREAM_TIMEOUT_MS', 120000, 1000),
  headless: bool('HEADLESS', true),
  humanize: bool('HUMANIZE', true),
  debugKeepBrowser: bool('DEBUG_KEEP_BROWSER', false),
  defaultCountry: country('DEFAULT_COUNTRY', 'us'),
  logLevel: str('LOG_LEVEL', 'info'),
  selectorOverrides,
};

if (errors.length > 0) {
  console.error('Configuration error(s):');
  for (const e of errors) console.error(`  - ${e}`);
  console.error('See .env.example for the expected variables.');
  process.exit(1);
}

export default Object.freeze(config);
