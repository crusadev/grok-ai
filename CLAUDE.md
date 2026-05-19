## TechStack
- SmartProxy for proxy generation
- CloakBrowser for scraping/browser automation

## Rules
- While meaningful comments are appreciated, we want to avoid redundant or useless comments, add comments only for really complex logic
- We dont log in or use registered accounts in any way

## Architecture
TypeScript service. Entry `src/index.ts` (HTTP server + BullMQ worker). Async flow:
`server.ts` POST creates a job (`db.ts`, status `processing`) and enqueues it (`queue.ts`);
`worker.ts` runs `scrape.ts` (races `BROWSERS_PER_REQUEST` browsers per round, first success
wins) → `grok.ts` (one attempt); the outcome is written back to PostgreSQL; the caller polls
`GET /scrape/:public_id`. Redis + PostgreSQL run via `docker compose`.
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
