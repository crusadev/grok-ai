/**
 * Grok (grok.com) browser automation — a single guest-prompt attempt.
 *
 * `runGrokAttempt` runs exactly ONE attempt with ONE browser and ONE proxy:
 * launch -> navigate -> prompt as guest -> wait for the streamed answer ->
 * extract. It throws typed errors; the retry policy lives in scrape.ts.
 */
import type { Browser, BrowserContext, Page, Route } from 'playwright-core';
import config from './config';
import { logger } from './logger';
import { getAsset, putAsset } from './assetCache';
import {
  AppError,
  BotCheckError,
  CloudflareError,
  ExtractionError,
  NavigationError,
  SignupWallError,
  TimeoutError,
} from './errors';
import {
  combined,
  BOT_CHECK_PHRASES,
  CLOUDFLARE_PHRASES,
  SIGNUP_WALL_PHRASES,
} from './selectors';
import { htmlToMarkdown } from './markdown';
import type { GrokResult, IncludeOptions } from './types';

const GROK_URL = 'https://grok.com';

/**
 * `cloakbrowser` is an ESM-only package. This module compiles to CommonJS,
 * where TypeScript would rewrite a normal `import()` into `require()` — which
 * cannot load ESM. Building the importer via `new Function` keeps a genuine
 * runtime dynamic `import()` that loads the ESM module correctly.
 */
const dynamicImport = new Function('s', 'return import(s)') as (
  s: string,
) => Promise<unknown>;

interface CloakLaunchOptions {
  headless?: boolean;
  proxy?:
    | string
    | { server: string; username?: string; password?: string; bypass?: string };
  humanize?: boolean;
  args?: string[];
}
interface CloakModule {
  launch: (opts?: CloakLaunchOptions) => Promise<Browser>;
  ensureBinary?: () => Promise<unknown>;
}

let cloakModule: CloakModule | undefined;
async function loadCloak(): Promise<CloakModule> {
  if (!cloakModule) {
    cloakModule = (await dynamicImport('cloakbrowser')) as CloakModule;
  }
  return cloakModule;
}

/**
 * Pre-download the stealth Chromium binary (~200MB) so the first real request
 * is not slowed by the download. Best-effort — failures are non-fatal.
 */
export async function warmUp(): Promise<void> {
  const mod = await loadCloak();
  if (typeof mod.ensureBinary === 'function') {
    await mod.ensureBinary();
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Map an arbitrary thrown value to a typed AppError. */
function wrapError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const msg = errMsg(err);
  if (/timeout|timed out/i.test(msg)) return new TimeoutError(msg);
  if (/net::|ERR_|ECONN|socket hang up|tunnel|proxy|dns/i.test(msg)) {
    return new NavigationError(msg);
  }
  // Unknown browser failures are usually transient — treat as retryable.
  return new NavigationError(`Unexpected browser error: ${msg}`);
}

/**
 * Launch one stealth browser. It is launched with a placeholder proxy so each
 * context (tab) can override it with its own proxy — Playwright requires a
 * launch-level proxy for per-context proxy to take effect.
 */
export async function launchBrowser(): Promise<Browser> {
  const cloak = await loadCloak();
  return cloak.launch({
    headless: config.headless,
    humanize: config.humanize,
    proxy: { server: 'per-context' },
  });
}

let sharedBrowser: Browser | undefined;
let jobsOnSharedBrowser = 0;
/**
 * Serialize the launch/recycle path. Atomic-counter Node semantics make the
 * happy path lock-free (every concurrent caller sees an integer that only
 * grows), but the launch/close branch must be exclusive — otherwise two
 * callers would race on `sharedBrowser.close()` and double-launch Chromium.
 */
let browserGate: Promise<void> = Promise.resolve();

/**
 * Return a long-lived browser shared across jobs in this worker process — far
 * cheaper than launching/closing Chromium per job. Re-launches if the browser
 * died or after `browserRecycleAfter` jobs (caps Chromium memory creep). Safe
 * to call concurrently from multiple jobs (locked launch/recycle).
 */
export async function getBrowser(): Promise<Browser> {
  const next = browserGate.then(async () => {
    const healthy =
      !!sharedBrowser &&
      sharedBrowser.isConnected() &&
      jobsOnSharedBrowser < config.browserRecycleAfter;
    if (!healthy) {
      if (sharedBrowser) await sharedBrowser.close().catch(() => undefined);
      sharedBrowser = await launchBrowser();
      jobsOnSharedBrowser = 0;
    }
    jobsOnSharedBrowser += 1;
  });
  // Swallow rejection on the chain so one failed launch does not poison the
  // gate for every subsequent caller — they will retry the launch themselves.
  browserGate = next.catch(() => undefined);
  await next;
  return sharedBrowser as Browser;
}

/** Close the shared browser — called on worker shutdown. */
export async function closeBrowser(): Promise<void> {
  if (sharedBrowser) {
    await sharedBrowser.close().catch(() => undefined);
    sharedBrowser = undefined;
    jobsOnSharedBrowser = 0;
  }
}

export interface GrokAttempt {
  prompt: string;
  include: IncludeOptions;
}

/**
 * Run one attempt inside a pre-created context (tab). The caller owns the
 * context's lifecycle — scrape.ts closes it after each attempt and aborts the
 * losing tabs of a race by closing their contexts. Returns the extracted
 * answer or throws a typed AppError.
 */
export async function runGrokAttempt(
  context: BrowserContext,
  opts: GrokAttempt,
): Promise<GrokResult> {
  const { prompt, include } = opts;
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(config.navTimeoutMs);

    await installNetworkInterception(page);
    await navigate(page);
    await assertNoBlockers(page, 'after navigation');

    const composerSel = await locateComposer(page);
    const answersBefore = await countAnswers(page);
    await submitPrompt(page, composerSel, prompt);

    await waitForAnswer(page, answersBefore, prompt);
    await assertNoBlockers(page, 'after streaming');

    return await extractAnswer(page, include);
  } catch (err) {
    throw wrapError(err);
  }
}

/** Response headers that must not be replayed when fulfilling from cache. */
const STRIP_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'set-cookie',
]);

function safeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!STRIP_HEADERS.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

/**
 * Network interception:
 *  - grok.com CDN assets are cached locally — served from the cache when
 *    present, otherwise fetched once through the proxy and cached. They are
 *    never blocked, so the browser's request pattern stays consistent for
 *    anti-bot detection.
 *  - URLs matching `cdnCachePathPatterns` (e.g. grok.com's own /_next/static
 *    bundles) are routed through the same cache, so the heavy JS/CSS payload
 *    only crosses the proxy once per worker host.
 *  - Non-CDN images & media are aborted to conserve proxy bandwidth.
 */
async function installNetworkInterception(page: Page): Promise<void> {
  const blockedTypes = new Set(['image', 'media']);
  const blockedExt =
    /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|mp4|m4v|webm|mov|mp3|wav|ogg)(\?|#|$)/i;
  const matchesCachedPath = (url: string): boolean => {
    for (const re of config.cdnCachePathPatterns) {
      if (re.test(url)) return true;
    }
    return false;
  };

  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      // malformed URL — leave host empty
    }

    if (
      config.cdnCacheEnabled &&
      req.method() === 'GET' &&
      (config.cdnCacheHosts.includes(host) || matchesCachedPath(url))
    ) {
      await serveCdnAsset(route, url);
      return;
    }

    if (blockedTypes.has(req.resourceType()) || blockedExt.test(url)) {
      await route.abort().catch(() => undefined);
      return;
    }
    await route.continue().catch(() => undefined);
  });
}

/** Serve a CDN asset from the local cache, or fetch-and-cache it on a miss. */
async function serveCdnAsset(route: Route, url: string): Promise<void> {
  const cached = await getAsset(url);
  if (cached) {
    await route
      .fulfill({
        status: cached.status,
        headers: safeHeaders(cached.headers),
        body: cached.body,
      })
      .catch(() => undefined);
    return;
  }
  try {
    const response = await route.fetch();
    const status = response.status();
    const headers = response.headers();
    const body = await response.body();
    if (status === 200) {
      await putAsset(url, { status, headers, body });
    }
    await route
      .fulfill({ status, headers: safeHeaders(headers), body })
      .catch(() => undefined);
  } catch {
    await route.continue().catch(() => undefined);
  }
}

async function navigate(page: Page): Promise<void> {
  try {
    await page.goto(GROK_URL, {
      waitUntil: 'domcontentloaded',
      timeout: config.navTimeoutMs,
    });
  } catch (err) {
    throw new NavigationError(`Failed to load ${GROK_URL}: ${errMsg(err)}`);
  }
}

/** Best-effort dismissal of the OneTrust cookie-consent banner. */
async function dismissCookieBanner(page: Page): Promise<void> {
  for (const sel of ['#onetrust-accept-btn-handler', '#onetrust-reject-all-handler']) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) {
      await btn.click({ timeout: 3000 }).catch(() => undefined);
      return;
    }
  }
}

/** Detect the sign-up wall or a Cloudflare challenge via visible page text. */
async function detectBlocker(
  page: Page,
): Promise<'signup' | 'cloudflare' | 'botcheck' | null> {
  const res = await page
    .evaluate(
      (args: { signup: string[]; cloudflare: string[]; botcheck: string[] }) => {
        const text = ((document.body && document.body.innerText) || '').toLowerCase();
        const title = (document.title || '').toLowerCase();
        return {
          signup: args.signup.some((p) => text.includes(p)),
          cloudflare: args.cloudflare.some(
            (p) => text.includes(p) || title.includes(p),
          ),
          botcheck: args.botcheck.some((p) => text.includes(p)),
        };
      },
      {
        signup: SIGNUP_WALL_PHRASES,
        cloudflare: CLOUDFLARE_PHRASES,
        botcheck: BOT_CHECK_PHRASES,
      },
    )
    .catch(() => null);
  if (!res) return null;
  if (res.signup) return 'signup';
  if (res.cloudflare) return 'cloudflare';
  if (res.botcheck) return 'botcheck';
  return null;
}

async function assertNoBlockers(page: Page, stage: string): Promise<void> {
  const blocker = await detectBlocker(page);
  if (blocker === 'signup') {
    throw new SignupWallError(`Grok sign-up wall ${stage}`);
  }
  if (blocker === 'cloudflare') {
    throw new CloudflareError(`Cloudflare challenge ${stage}`);
  }
  if (blocker === 'botcheck') {
    throw new BotCheckError(`Grok authenticity check ${stage}`);
  }
}

async function countAnswers(page: Page): Promise<number> {
  return page
    .evaluate((sel: string) => document.querySelectorAll(sel).length, combined('answerMessage'))
    .catch(() => 0);
}

/** Wait for the guest composer to become visible (retry-aware). */
async function locateComposer(page: Page): Promise<string> {
  const sel = combined('promptInput');
  const startedAt = Date.now();
  const deadline = startedAt + config.navTimeoutMs;
  let triedCookieBanner = false;
  while (Date.now() < deadline) {
    await assertNoBlockers(page, 'while locating composer');
    const el = await page.$(sel);
    if (el && (await el.isVisible().catch(() => false))) {
      return sel;
    }
    // The cookie banner is normally a non-blocking strip and is left alone.
    // Only if the composer stays unreachable might a modal variant be covering
    // it — in that case dismiss the banner once as a fallback.
    if (!triedCookieBanner && Date.now() - startedAt > 3000) {
      triedCookieBanner = true;
      await dismissCookieBanner(page);
    }
    await sleep(400);
  }
  await logDiagnostics(page, 'composer not found');
  throw new ExtractionError(
    'Could not locate the Grok prompt composer (page layout changed or guest mode unavailable)',
  );
}

async function submitPrompt(
  page: Page,
  composerSel: string,
  prompt: string,
): Promise<void> {
  await page.fill(composerSel, prompt);
  const sendSel = combined('sendButton');
  const sendEl = await page.$(sendSel);
  const clickable =
    sendEl &&
    (await sendEl.isVisible().catch(() => false)) &&
    (await sendEl.isEnabled().catch(() => false));
  if (clickable && sendEl) {
    await sendEl.click();
  } else {
    // No usable send button — submit with Enter from the focused composer.
    await page.focus(composerSel);
    await page.keyboard.press('Enter');
  }
}

interface PollState {
  answerCount: number;
  text: string;
  hasCompletion: boolean;
  signupWall: boolean;
  cloudflare: boolean;
  botCheck: boolean;
}

async function pollState(page: Page): Promise<PollState> {
  return page.evaluate(
    (args: {
      answerSel: string;
      contentSel: string;
      completionSel: string;
      signup: string[];
      cloudflare: string[];
      botcheck: string[];
    }) => {
      const messages = Array.from(
        document.querySelectorAll(args.answerSel),
      ) as HTMLElement[];
      const last = messages[messages.length - 1];
      let text = '';
      if (last) {
        const content = last.querySelector(args.contentSel) as HTMLElement | null;
        text = ((content || last).innerText || '').trim();
      }
      const bodyText = ((document.body && document.body.innerText) || '').toLowerCase();
      const title = (document.title || '').toLowerCase();
      return {
        answerCount: messages.length,
        text,
        hasCompletion: !!document.querySelector(args.completionSel),
        signupWall: args.signup.some((p) => bodyText.includes(p)),
        cloudflare: args.cloudflare.some(
          (p) => bodyText.includes(p) || title.includes(p),
        ),
        botCheck: args.botcheck.some((p) => bodyText.includes(p)),
      };
    },
    {
      answerSel: combined('answerMessage'),
      contentSel: combined('answerContent'),
      completionSel: combined('completionMarker'),
      signup: SIGNUP_WALL_PHRASES,
      cloudflare: CLOUDFLARE_PHRASES,
      botcheck: BOT_CHECK_PHRASES,
    },
  );
}

/**
 * Wait until Grok's streamed answer has finished. Completion is detected with
 * layered signals: (1) the streaming "Stop" control disappears, (2) post-answer
 * action buttons appear, (3) the answer text stops changing. The user's own
 * prompt echo is ignored via the `text !== prompt` guard.
 */
async function waitForAnswer(
  page: Page,
  answersBefore: number,
  prompt: string,
): Promise<void> {
  const promptTrim = prompt.trim();
  const deadline = Date.now() + config.streamTimeoutMs;
  const pollMs = 600;
  const stableWithMarker = 2; // ~1.2s stable + a completion button present
  const stableOnly = 6; // ~3.6s stable (fallback)

  let lastText = '';
  let stable = 0;
  let sawAnswer = false;

  while (Date.now() < deadline) {
    const s = await pollState(page);
    if (s.signupWall) throw new SignupWallError('Sign-up wall while awaiting answer');
    if (s.cloudflare) throw new CloudflareError('Cloudflare challenge while awaiting answer');
    if (s.botCheck) throw new BotCheckError('Authenticity check while awaiting answer');

    const hasAnswer =
      s.answerCount > answersBefore && s.text.length > 0 && s.text !== promptTrim;

    if (hasAnswer) {
      sawAnswer = true;
      if (s.text === lastText) {
        stable += 1;
      } else {
        stable = 0;
        lastText = s.text;
      }
      // Done when the answer text has settled — confirmed faster when a
      // post-answer control (Regenerate/Copy) is also present.
      if (s.hasCompletion && stable >= stableWithMarker) return;
      if (stable >= stableOnly) return;
    }

    await sleep(pollMs);
  }

  throw new TimeoutError(
    sawAnswer
      ? 'Grok answer did not finish streaming within the timeout'
      : 'Timed out waiting for Grok to start answering',
  );
}

/** Extract the newest assistant answer (text, sources, optional html/markdown). */
async function extractAnswer(
  page: Page,
  include: IncludeOptions,
): Promise<GrokResult> {
  const data = await page.evaluate(
    (args: {
      answerSel: string;
      contentSel: string;
      sourceLinksSel: string;
      sourcesPanelSel: string;
    }) => {
      const messages = Array.from(
        document.querySelectorAll(args.answerSel),
      ) as HTMLElement[];
      const message = messages[messages.length - 1];
      if (!message) return null;
      // Scope to the rendered markdown content; fall back to the whole bubble.
      const content =
        (message.querySelector(args.contentSel) as HTMLElement | null) || message;

      const collectHrefs = (root: ParentNode): string[] =>
        (Array.from(root.querySelectorAll(args.sourceLinksSel)) as HTMLAnchorElement[])
          .map((a) => a.href)
          .filter(Boolean);

      let hrefs = collectHrefs(content);
      if (hrefs.length === 0) {
        const panel = document.querySelector(args.sourcesPanelSel);
        if (panel) hrefs = collectHrefs(panel);
      }
      return {
        text: (content.innerText || '').trim(),
        html: content.outerHTML,
        hrefs,
      };
    },
    {
      answerSel: combined('answerMessage'),
      contentSel: combined('answerContent'),
      sourceLinksSel: combined('sourceLinks'),
      sourcesPanelSel: combined('sourcesPanel'),
    },
  );

  if (!data || !data.text) {
    await logDiagnostics(page, 'answer element not found');
    throw new ExtractionError('Grok answer element not found or empty');
  }

  const result: GrokResult = {
    text: data.text,
    sources: dedupeSources(data.hrefs),
  };
  if (include.html) result.html = data.html;
  if (include.markdown) result.markdown = htmlToMarkdown(data.html);
  return result;
}

/** Normalize, filter and de-duplicate source URLs. */
function dedupeSources(hrefs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const href of hrefs) {
    try {
      const url = new URL(href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      // Drop grok.com-internal navigation links.
      if (url.hostname === 'grok.com' || url.hostname.endsWith('.grok.com')) continue;
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      out.push(url.href);
    } catch {
      // Skip malformed hrefs.
    }
  }
  return out;
}

/** Log page diagnostics so selector drift can be diagnosed quickly. */
async function logDiagnostics(page: Page, reason: string): Promise<void> {
  try {
    const info = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      bodySnippet: ((document.body && document.body.innerText) || '').slice(0, 500),
    }));
    logger.warn({ reason, ...info }, 'grok page diagnostics');
  } catch {
    logger.warn({ reason }, 'grok page diagnostics unavailable');
  }
}
