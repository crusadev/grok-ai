If you re reading this, please dont :D its the first commit and im still writing the ideas so you could be finding nonsense or unfinished ideas.

## What is the biggest challenge for this project?
Before being able to actually start the project i had a good amount of days to think ( and i love thinking ), the main question that repeated in my head all the time was "What does a good anti-bot system check for in a browser?", it ranges from all sort of things, from hardware to mouse movements to browser profiles and many more. I was planning on how to 'humanize' the browser when i stumbled upon CloakBrowser that just came in clutch.

**CloakBrowser is a chromium instance with fingerprints modified at the c++ source level, and the best part, its open source**

After some tests i confirmed that this browser is pretty undetectable by grok, its really easy to use with playwright/puppeteer, it has a self hosted browser profile manager interface etc etc, its a really complete solution.

## The network solution
To manage the per country request, avoid rate limiting, retrying on paywall and more reasons, i decided to use proxies, obviously residential proxies to look like a legitimate user, for this i picked decodo since i found it the best suited for our scenario and did not have much time to search more in depth
The approach is simple, for each request we rotate the proxy within the same country, from what ive seen if you try again enough times within the same country you will get the answer at some point ( normally between 2-6 times )

## The scalability approach
To make this scalable is not really hard, we will use K8 clusters, where each pod will be able to run 4-5 browser instances at the same time. We can use redis/bullmq for the queue, we put some custom limits on how kubernetes scales horizontally so it downgrades/upgrades based on number of requests.

## The retry functionality
Through the selector we observe when the paywall appears and we instantly close the browser and try again.
Currently im using the humanize parameter, from what ive seen it takes too long to write the prompt

## CDN assets Caching
I saw that for every grok.com request the cdn was receiving 10 requests, this was burning the proxies bandwidth fast, these assets were used for telemetry ( mouse, user behavior ) if we simply ignored them we would have been flagged as suspicious, the solution is to accept the assets on the first page load, store ( cache ) them and then on the next loads we would simply intercept the requests so they dont pass through our proxy and serve them from our cache instead effectively reducing the cdn traffic drastically ( more than 90% ).
This approach also made the page load faster

## Side notes
- The paywall is pretty random and really present, from 11 tries we got an 85% paywall scenarios


---

# grok-ai

An HTTP service that scrapes [Grok](https://grok.com) **as a guest** (no login) using a
stealth browser ([cloakbrowser](https://www.npmjs.com/package/cloakbrowser)) routed through
[Decodo / Smartproxy](https://decodo.com) residential proxies.

When Grok blocks a guest with the *"Sign up to keep chatting"* wall, the request is retried
from a fresh proxy IP.

## How it works

```
POST /scrape  ──►  pick a country-matched proxy  ──►  launch stealth browser
                   ──►  open grok.com as guest    ──►  type prompt, submit
                   ──►  wait for the streamed answer
                   ──►  extract text / sources / html / markdown
   sign-up wall or Cloudflare or timeout  ──►  retry from a new IP
```

## Setup

Requires Node.js ≥ 24.

```bash
npm install
cp .env.example .env       # then fill in real Decodo credentials
docker compose up -d       # starts PostgreSQL (stores successful results)
npm run build
npm start                  # or: npm run dev
```

The first launch downloads the stealth Chromium binary (~200 MB) to `~/.cloakbrowser`.
The server pre-downloads it on boot so the first request is not delayed.

## API

### `POST /scrape`

Request:
```json
{
  "prompt": "What is the capital of France?",
  "country": "us",
  "include": { "html": true, "markdown": true }
}
```
- `prompt` — required, 1–8000 chars.
- `country` — optional 2-letter ISO code (defaults to `DEFAULT_COUNTRY`). Drives the proxy country.
- `include` — optional; `html` / `markdown` default to `false`.

Success (`200`):
```json
{
  "success": true,
  "result": {
    "text": "Paris is the capital of France.",
    "sources": ["https://example.com/..."],
    "html": "<div>…</div>",
    "markdown": "Paris is the capital…"
  }
}
```
`html` / `markdown` are scoped to Grok's answer message element and present only when requested.

Failure: `{ "success": false, "error": "<reason>" }` with status `400` (bad input),
`502` (retries exhausted), or `503` (server at capacity).

### `GET /health`

```json
{ "status": "ok", "uptime": 12, "activeJobs": 1, "queuedJobs": 0 }
```

## Configuration (`.env`)

See [`.env.example`](./.env.example) for the full list. Key variables:

| Var | Default | Purpose |
|---|---|---|
| `DECODO_USERNAME` / `DECODO_PASSWORD` | — (required) | Decodo proxy credentials |
| `DECODO_USERNAME_TEMPLATE` | `user-{username}-country-{country}` | Auth-username format (plan-dependent) |
| `MAX_CONCURRENCY` | 3 | Max simultaneous browsers |
| `MAX_RETRIES` | 3 | Retry attempts after the first failure |
| `NAV_TIMEOUT_MS` / `STREAM_TIMEOUT_MS` | 45000 / 120000 | Navigation / answer-streaming timeouts |
| `HEADLESS` | true | Set `false` to watch the browser (selector discovery) |
| `SELECTOR_*` | — | Override grok.com selectors without a redeploy |

## ⚠️ Live selector discovery — required before trusting `/scrape`

grok.com is an undocumented single-page app. The selectors in [`src/selectors.ts`](./src/selectors.ts)
are **best guesses** and must be verified against the live site:

1. Run with `HEADLESS=false` and a working proxy.
2. Open grok.com and use DevTools to identify the guest composer, send button,
   answer message container, the streaming Stop control, and source links.
3. Update `src/selectors.ts`, or override at runtime via the `SELECTOR_*` env vars
   (comma-separated candidate lists — overrides are tried before the defaults).

Each selector is a prioritized candidate list, and the sign-up-wall / Cloudflare
checks match on visible text, so the scraper tolerates minor DOM drift.

## Storage

Successful scrapes are stored in PostgreSQL, started via `docker compose up -d`.
Storage is best-effort — a database outage never fails a scrape request. Disable
it with `DB_ENABLED=false`.

Table `scrape_results`: `id`, `created_at`, `prompt`, `country`, `text`,
`sources` (jsonb), `html`, `markdown`. Inspect it with:

```bash
docker compose exec db psql -U grok -d grok \
  -c 'SELECT id, created_at, country, prompt FROM scrape_results ORDER BY id DESC LIMIT 10;'
```

## Verification

```bash
# health
curl localhost:3000/health

# end-to-end
curl -X POST localhost:3000/scrape -H 'Content-Type: application/json' \
  -d '{"prompt":"What is the capital of France?","country":"us","include":{"markdown":true}}'

# input validation -> 400
curl -X POST localhost:3000/scrape -H 'Content-Type: application/json' -d '{"country":"usa"}'
```

## Project layout

```
src/
  index.ts      entrypoint — server start, browser warm-up, graceful shutdown
  config.ts     env parsing/validation (single source of truth)
  server.ts     Express API + p-limit concurrency pool
  scrape.ts     retry loop (fresh proxy IP per attempt)
  grok.ts       one Grok automation attempt
  selectors.ts  grok.com selectors (verified against the live site)
  assetCache.ts local cache for grok.com CDN assets (proxy-bandwidth saving)
  db.ts         PostgreSQL storage for successful results
  proxy.ts      Decodo proxy URL builder
  markdown.ts   HTML → Markdown (turndown)
  errors.ts     typed error hierarchy
  logger.ts     structured logger (pino)
  types.ts      shared types
```
