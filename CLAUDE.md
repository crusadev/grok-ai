## TechStack
- SmartProxy for proxy generation
- CloakBrowser for scraping/browser automation

## Rules
- While meaningful comments are appreciated, we want to avoid redundant or useless comments, add comments only for really complex logic
- We dont log in or use registered accounts in any way

## Architecture
TypeScript service, runs as Docker Compose services: `api`, `worker` (scalable), `db`,
`redis`, `web` (React dashboard in `web/`, nginx, proxies `/api` to `api`). Async flow: `server.ts` POST creates a job (`db.ts`, status `processing`) and
enqueues it (`queue.ts`); a `worker.ts` consumer runs `scrape.ts`, which reuses one
long-lived browser (`getBrowser` in `grok.ts`) and races a pool of `TABS_PER_REQUEST`
contexts — each its own proxy IP, first success wins, losers aborted, a walled tab
replaced; the outcome is written back to PostgreSQL; the caller polls
`GET /scrape/:public_id`.
- Entrypoints: `server-main.ts` (api), `worker-main.ts` (worker), `autoscaler.ts` (host —
  scales the `worker` service on queue depth); `index.ts` is single-process for `npm run dev`.
- RAM is bounded by `MAX_WORKER_REPLICAS × WORKER_CONCURRENCY`; `config.ts` asserts it
  against `GLOBAL_MAX_CONCURRENT_JOBS` and fails fast.
- `config.ts` is the only place that reads `process.env`; it fails fast on bad config.
- `proxy.ts` builds Decodo URLs; the rotating endpoint gives a fresh IP per launch, so a
  retry is just another attempt — do not add sticky-session tokens.
- `errors.ts` errors carry `retryable` + `httpStatus`; `scrape.ts` retries `retryable` ones.

## Commands
- `npm run dev` — watch mode (tsx)
- `npm run build` / `npm start` — compile to `dist/`, run
- `npm run typecheck` — types only

## Known risks / gotchas
- `cloakbrowser` is ESM-only; `grok.ts` loads it via a `new Function('s','return import(s)')`
  shim because the CommonJS build would otherwise rewrite `import()` to `require()`.
- Proxy credentials must be valid Decodo creds; the auth-username format is plan-dependent
  and configurable via `DECODO_USERNAME_TEMPLATE`.
