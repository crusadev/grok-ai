/**
 * Environment configuration — the single source of truth.
 * No other module reads `process.env` directly.
 *
 * On any missing/invalid variable, prints an aggregated error and exits the
 * process: a misconfigured server should fail fast at startup, not mid-request.
 */
import path from 'node:path';
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

export type ProxyProviderName = 'decodo' | 'privateproxy';

export interface ProxyGatewayBlock {
  username: string;
  password: string;
  host: string;
  port: number;
  /** Auth-username template; `{username}` and `{country}` are substituted. */
  usernameTemplate: string;
}

export interface AppConfig {
  port: number;
  proxy: {
    /** Active provider — picks which sub-block the factory instantiates. */
    provider: ProxyProviderName;
    decodo: ProxyGatewayBlock;
    privateproxy: ProxyGatewayBlock;
  };
  /** Scrape jobs processed in parallel per worker process. */
  workerConcurrency: number;
  /** Autoscaler ceiling on worker container replicas. */
  maxWorkerReplicas: number;
  /** Hard cap on total concurrent jobs (RAM budget guard). */
  globalMaxConcurrentJobs: number;
  /** PostgreSQL pool size for this process. */
  pgPoolMax: number;
  /** Tabs (contexts) raced in parallel per request, each with its own proxy. */
  raceTabs: number;
  /** Total attempt budget per request across all tabs. */
  maxAttempts: number;
  /** Wall-clock cap per scrape job — a doomed job is abandoned after this. */
  jobDeadlineMs: number;
  /** Re-launch the shared per-worker browser after this many jobs. */
  browserRecycleAfter: number;
  navTimeoutMs: number;
  streamTimeoutMs: number;
  headless: boolean;
  humanize: boolean;
  /** Debug: leave the browser open after an attempt so the DOM can be inspected. */
  debugKeepBrowser: boolean;
  /** Cache grok.com CDN assets locally to avoid re-fetching them via the proxy. */
  cdnCacheEnabled: boolean;
  cdnCacheDir: string;
  cdnCacheHosts: string[];
  /**
   * Extra URL patterns to cache (compiled regex). Applied to ANY host, so
   * grok.com's own static bundles (e.g. /_next/static/*) can be cached without
   * also caching the dynamic HTML / streaming-chat endpoint. Each pattern is
   * a JavaScript regex tested against the full URL.
   */
  cdnCachePathPatterns: RegExp[];
  /** PostgreSQL connection string (job storage). */
  databaseUrl: string;
  /** Redis connection string (BullMQ queue). */
  redisUrl: string;
  defaultCountry: string;
  logLevel: string;
  /** Per-element selector overrides; empty list means "use built-in defaults". */
  selectorOverrides: Record<SelectorKey, string[]>;
}

const selectorOverrides = Object.fromEntries(
  (Object.keys(SELECTOR_ENV) as SelectorKey[]).map((key) => [key, list(SELECTOR_ENV[key])]),
) as Record<SelectorKey, string[]>;

// Only the credentials for the *active* provider are required — picking
// 'privateproxy' must not force a Decodo username to be set, and vice versa.
const providerRaw = str('PROXY_PROVIDER', 'decodo').toLowerCase();
if (providerRaw !== 'decodo' && providerRaw !== 'privateproxy') {
  errors.push(`Invalid PROXY_PROVIDER="${providerRaw}": expected 'decodo' or 'privateproxy'`);
}
const provider: ProxyProviderName = providerRaw === 'privateproxy' ? 'privateproxy' : 'decodo';

function gatewayBlock(opts: {
  active: boolean;
  userVar: string;
  passVar: string;
  hostVar: string;
  hostDefault: string;
  portVar: string;
  portDefault: number;
  templateVar: string;
  templateDefault: string;
}): ProxyGatewayBlock {
  return {
    username: opts.active ? requiredStr(opts.userVar) : str(opts.userVar, ''),
    password: opts.active ? requiredStr(opts.passVar) : str(opts.passVar, ''),
    host: str(opts.hostVar, opts.hostDefault),
    port: int(opts.portVar, opts.portDefault, 1),
    usernameTemplate: str(opts.templateVar, opts.templateDefault),
  };
}

const config: AppConfig = {
  port: int('PORT', 3000, 1),
  proxy: {
    provider,
    decodo: gatewayBlock({
      active: provider === 'decodo',
      userVar: 'DECODO_USERNAME',
      passVar: 'DECODO_PASSWORD',
      hostVar: 'DECODO_HOST',
      hostDefault: 'gate.decodo.com',
      portVar: 'DECODO_PORT',
      portDefault: 7000,
      templateVar: 'DECODO_USERNAME_TEMPLATE',
      templateDefault: 'user-{username}-country-{country}',
    }),
    privateproxy: gatewayBlock({
      active: provider === 'privateproxy',
      userVar: 'PRIVATEPROXY_USERNAME',
      passVar: 'PRIVATEPROXY_PASSWORD',
      hostVar: 'PRIVATEPROXY_HOST',
      hostDefault: 'edge1-us.privateproxy.me',
      portVar: 'PRIVATEPROXY_PORT',
      portDefault: 8888,
      templateVar: 'PRIVATEPROXY_USERNAME_TEMPLATE',
      templateDefault: '{username}-{country}',
    }),
  },
  workerConcurrency: int('WORKER_CONCURRENCY', 1, 1),
  maxWorkerReplicas: int('MAX_WORKER_REPLICAS', 16, 1),
  globalMaxConcurrentJobs: int('GLOBAL_MAX_CONCURRENT_JOBS', 16, 1),
  pgPoolMax: int('PG_POOL_MAX', 6, 1),
  raceTabs: int('TABS_PER_REQUEST', 5, 1),
  maxAttempts: int('MAX_ATTEMPTS', 15, 1),
  jobDeadlineMs: int('JOB_DEADLINE_MS', 150000, 1000),
  browserRecycleAfter: int('BROWSER_RECYCLE_AFTER', 50, 1),
  navTimeoutMs: int('NAV_TIMEOUT_MS', 45000, 1000),
  streamTimeoutMs: int('STREAM_TIMEOUT_MS', 120000, 1000),
  headless: bool('HEADLESS', true),
  humanize: bool('HUMANIZE', true),
  debugKeepBrowser: bool('DEBUG_KEEP_BROWSER', false),
  cdnCacheEnabled: bool('CDN_CACHE_ENABLED', true),
  cdnCacheDir: path.resolve(str('CDN_CACHE_DIR', '.cache/cdn')),
  cdnCacheHosts: list('CDN_CACHE_HOSTS').length > 0
    ? list('CDN_CACHE_HOSTS')
    : ['cdn.grok.com'],
  // Defaults catch Next.js content-hashed bundles on grok.com and any generic
  // static asset extension. Regex sources can't contain a literal comma —
  // commas are the env-var separator. Use Unicode escapes if you really need one.
  cdnCachePathPatterns: (() => {
    const raw = list('CDN_CACHE_PATH_PATTERNS');
    const sources = raw.length > 0
      ? raw
      : ['/_next/static/', '\\.(?:js|css|woff2?|ttf|eot|otf)(?:\\?|#|$)'];
    const out: RegExp[] = [];
    for (const s of sources) {
      try {
        out.push(new RegExp(s));
      } catch (e) {
        errors.push(`Invalid CDN_CACHE_PATH_PATTERNS entry "${s}": ${(e as Error).message}`);
      }
    }
    return out;
  })(),
  databaseUrl: str('DATABASE_URL', 'postgres://grok:grok@localhost:5433/grok'),
  redisUrl: str('REDIS_URL', 'redis://localhost:6380'),
  defaultCountry: country('DEFAULT_COUNTRY', 'us'),
  logLevel: str('LOG_LEVEL', 'info'),
  selectorOverrides,
};

// Guard the RAM budget: the autoscaler must never be able to launch enough
// worker replicas to exceed the global concurrent-job cap.
if (config.maxWorkerReplicas * config.workerConcurrency > config.globalMaxConcurrentJobs) {
  errors.push(
    `MAX_WORKER_REPLICAS (${config.maxWorkerReplicas}) x WORKER_CONCURRENCY ` +
      `(${config.workerConcurrency}) exceeds GLOBAL_MAX_CONCURRENT_JOBS ` +
      `(${config.globalMaxConcurrentJobs})`,
  );
}

if (errors.length > 0) {
  console.error('Configuration error(s):');
  for (const e of errors) console.error(`  - ${e}`);
  console.error('See .env.example for the expected variables.');
  process.exit(1);
}

export default Object.freeze(config);
