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

Requests are **asynchronous**: `POST /scrape` returns a `public_id` immediately and the
scrape runs on a background worker; the caller polls `GET /scrape/:public_id` until it is
`success` or `failed`.

## How it works

```
POST /scrape  ──►  create job (status: processing)  ──►  enqueue (BullMQ / Redis)
                                                         └─►  202 { public_id }

worker  ──►  launch ONE browser, race a pool of TABS_PER_REQUEST tabs (contexts),
             each through its own fresh country-matched proxy IP
        ──►  first tab to answer wins; the rest are closed with the browser
        ──►  open grok.com as guest, prompt, extract text/sources/html/markdown
        ──►  store result in PostgreSQL (status: success | failed)

GET /scrape/:public_id  ──►  { status, result? }   (poll until done)
```

A tab fails when it hits the sign-up wall, a bot/authenticity check, a Cloudflare
challenge, or a timeout — it is replaced by a fresh tab (new proxy IP), keeping the
pool full until an answer arrives or the `MAX_ATTEMPTS` budget is spent.

## Setup

Requires Node.js ≥ 24 and Docker.

```bash
npm install
cp .env.example .env       # then fill in real Decodo credentials
npm run build
docker compose up -d --build   # builds the image; starts db, redis, api, worker
```

`api` is on `localhost:3000`. For local single-process debugging without Docker:
`npm run dev`.

## Scaling

The stack runs as containers: **`api`** (HTTP), **`worker`** (BullMQ consumer — the
scalable one), **`db`**, **`redis`**. Workers are stateless; scaling = running more
`worker` containers.

```bash
# manual scale
docker compose up -d --no-recreate --scale worker=4

# dynamic — autoscale worker replicas on queue depth (runs on the host)
npm run start:autoscaler
```

The autoscaler watches the BullMQ queue and scales `worker` between 1 and
`MAX_WORKER_REPLICAS`. RAM is bounded by `MAX_WORKER_REPLICAS × WORKER_CONCURRENCY`
(default 8 × 1 = 8 concurrent jobs, ~20 GB peak measured). Each worker container runs
**one** job (one browser + 5 tabs) under a 3 GB `mem_limit` — sized so the cgroup
OOM-killer never kills Chromium mid-job. On a single 32 GB PC ~8 concurrent jobs is the
stable ceiling; CPU saturates before RAM does.

The first launch downloads the stealth Chromium binary (~200 MB) to `~/.cloakbrowser`.
The server pre-downloads it on boot so the first request is not delayed.

## API

### `POST /scrape` — enqueue a job

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

Response (`202`):
```json
{ "success": true, "public_id": "cloro_a7Kp2mXq9Lz3RtB", "status": "processing" }
```
Bad input → `400`; the queue being unavailable → `503`.

### `GET /scrape/:public_id` — poll a job

While running (`200`):
```json
{ "success": true, "public_id": "…", "status": "processing" }
```
Done (`200`):
```json
{
  "success": true,
  "public_id": "…",
  "status": "success",
  "result": {
    "text": "Paris is the capital of France.",
    "sources": ["https://example.com/..."],
    "html": "<div>…</div>",
    "markdown": "Paris is the capital…"
  }
}
```
Failed (`200`): `{ "success": false, "status": "failed", "error": "<reason>" }`.
Unknown id → `404`; malformed id → `400`.

`html` / `markdown` are scoped to Grok's answer element and present only when requested.

### `GET /health`

```json
{ "status": "ok", "uptime": 12 }
```

## Configuration (`.env`)

See [`.env.example`](./.env.example) for the full list. Key variables:

| Var | Default | Purpose |
|---|---|---|
| `DECODO_USERNAME` / `DECODO_PASSWORD` | — (required) | Decodo proxy credentials |
| `DECODO_USERNAME_TEMPLATE` | `user-{username}-country-{country}` | Auth-username format (plan-dependent) |
| `DATABASE_URL` / `REDIS_URL` | local Docker defaults | PostgreSQL + Redis connections |
| `WORKER_CONCURRENCY` | 1 | Scrape jobs processed in parallel |
| `TABS_PER_REQUEST` | 5 | Tabs (contexts) raced per request, each its own proxy |
| `MAX_ATTEMPTS` | 40 | Total attempt budget per request across all tabs |
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

Every job is a row in PostgreSQL (started via `docker compose up -d`), created as
`processing` and updated to `success` (with the result) or `failed` (with an error).

Table `scrape_results`: `id`, `public_id`, `status`, `created_at`, `updated_at`,
`prompt`, `country`, `text`, `sources` (jsonb), `html`, `markdown`, `error`. Inspect:

```bash
docker compose exec db psql -U grok -d grok \
  -c 'SELECT public_id, status, country, prompt FROM scrape_results ORDER BY id DESC LIMIT 10;'
```

## Verification

```bash
# health
curl localhost:3000/health

# enqueue a job -> { public_id, status: processing }
curl -X POST localhost:3000/scrape -H 'Content-Type: application/json' \
  -d '{"prompt":"What is the capital of France?","country":"ca","include":{"markdown":true}}'

# poll until success | failed
curl localhost:3000/scrape/<public_id>

# input validation -> 400
curl -X POST localhost:3000/scrape -H 'Content-Type: application/json' -d '{"country":"usa"}'
```

## Project layout

```
src/
  server-main.ts  api entrypoint — HTTP server only
  worker-main.ts  worker entrypoint — BullMQ consumer only (scaled)
  autoscaler.ts   host process — scales the worker service on queue depth
  index.ts        single-process entrypoint (npm run dev)
  config.ts     env parsing/validation (single source of truth)
  server.ts     Express API (async POST + poll endpoints)
  queue.ts      BullMQ queue + Redis connection
  worker.ts     BullMQ worker — runs scrapes, writes outcomes to the DB
  scrape.ts     one browser, races TABS_PER_REQUEST proxied tabs, first wins
  grok.ts       one Grok automation attempt (per context/tab)
  selectors.ts  grok.com selectors (verified against the live site)
  assetCache.ts local cache for grok.com CDN assets (proxy-bandwidth saving)
  db.ts         PostgreSQL job storage (create / complete / fail / get)
  proxy.ts      Decodo proxy URL builder
  markdown.ts   HTML → Markdown (turndown)
  errors.ts     typed error hierarchy
  logger.ts     structured logger (pino)
  types.ts      shared types
```
