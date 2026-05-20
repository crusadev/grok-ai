## What was the biggest challenge for this project?
Before being able to actually start the project i had a good amount of days to think ( and i love thinking ), the main question that repeated in my head all the time was "What does a good anti-bot system check for in a browser?", it ranges from all sort of things, from hardware to mouse movements to browser profiles and many more. I was planning on how to 'humanize' the browser when i stumbled upon CloakBrowser that just came in clutch.

**CloakBrowser is a chromium instance with fingerprints modified at the c++ source level, and the best part, its open source**

After some tests i confirmed that this browser is pretty undetectable by grok, its really easy to use with playwright/puppeteer, it has a self hosted browser profile manager interface etc etc, its a really complete solution.

## The network solution
To manage the per country request, avoid rate limiting, retrying on paywall and more reasons, i obviously decided to use proxies, also obviously residential proxies to look like a legitimate user, for this i picked decodo at first since i found it the best suited for our scenario and did not have much time to search more in depth, later on i moved to PrivateProxy thanks to their cheap 10GB = 10$ 'Trial' since i did not want to spend too much time abusing free trials for the PoC.

## How does this scale
We have a simple autoscaler algorithm, based on workload and some limits we spawn ( for this PoC ) docker containers with one browser idle waiting for requests, starting a 5 tabs race per request.

## The retry functionality
Through the selector we observe when the paywall appears and we instantly close the tab and fire a new one. We will always have 5 tabs running at the same time until one of them wins the race ( gets the result ).
Currently we are using the humanize parameter, from what ive seen it takes a little bit long to write the prompt, deactivating it fired up bot detection by roughly ~40%.
This parameter can be fine tuned, for production i would study the behavior to find the sweet spot.

## CDN assets Caching
I saw that for every request we were using ~16MB of bandwidth, the majority were assets used for telemetry ( mouse, user behavior ) if we simply ignored them we would have been flagged as suspicious, the solution is to accept the assets on the first page load, store ( cache ) them and then on the next loads we would simply intercept the requests so they dont pass through our proxy and serve them from our cache instead effectively reducing the cdn traffic drastically ( more than 90% ). For production we would use a shared storage for the cached files that the workers can pick their sweets from.
This approach also made the page load faster ( 2-3s win )

## ** For more detailed information and test results see LOAD_TEST_REPORT.md**

---

## Setup & run

### Prerequisites (all platforms)

- **Docker** + **Docker Compose v2** (`docker compose ...`, not the old `docker-compose`)
- **Node.js 20+** (only needed if you want to run the autoscaler on the host or use `npm run dev`; the api + worker containers carry their own Node)
- A proxy account — either Decodo or PrivateProxy.me. Free trials work for a smoke test.

### macOS

```bash
# Docker Desktop (Apple Silicon or Intel)
brew install --cask docker
open -a Docker                       # wait until the whale icon is steady

# Node (optional — only for the host-side autoscaler and dev mode)
brew install nvm
nvm install 20 && nvm use 20

# Project
git clone <this repo> && cd grok-ai
cp .env.example .env                 # then edit .env with your proxy creds
docker compose up -d --build         # api, worker, db, redis, web all come up

# Optional: run the autoscaler on the host so the worker pool grows on load
npm ci && npm run build
node dist/autoscaler.js               # or: nohup node dist/autoscaler.js &
```

### Linux

```bash
# Docker engine + compose plugin (Ubuntu/Debian shown — adapt for your distro)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER         # log out and back in to pick up the group

# Node
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20 && nvm use 20

# Project
git clone <this repo> && cd grok-ai
cp .env.example .env                  # edit .env
docker compose up -d --build

# Optional autoscaler
npm ci && npm run build
nohup node dist/autoscaler.js > runs/autoscaler.log 2>&1 &
disown
```

### Windows

Use **Docker Desktop with the WSL2 backend** — the workers need `SYS_ADMIN` capability and a sized `/dev/shm`, both of which only work cleanly under WSL2, not the Hyper-V backend.

```powershell
# In an Administrator PowerShell, first time only:
wsl --install                          # installs WSL2 + Ubuntu
# reboot when prompted
winget install Docker.DockerDesktop
winget install OpenJS.NodeJS.LTS       # or use nvm-windows

# After Docker Desktop is running with WSL2 backend enabled, open Ubuntu:
git clone <this repo> && cd grok-ai
cp .env.example .env                   # edit .env (notepad.exe .env works from WSL)
docker compose up -d --build

# Optional autoscaler (run inside WSL, not PowerShell, so the docker socket is reachable)
npm ci && npm run build
nohup node dist/autoscaler.js > runs/autoscaler.log 2>&1 &
disown
```

### After it's up

- **Web dashboard:** http://localhost:8088
- **API:** http://localhost:3000
- **DB (host port):** `localhost:5433` (user `grok`, pass `grok`, db `grok`)
- **Redis (host port):** `localhost:6380`

Smoke test from the command line:

```bash
curl -X POST http://localhost:3000/scrape \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"What is the capital of Japan?","country":"us"}'
# → { "success": true, "public_id": "cloro_AbCdEf...", "status": "processing" }

curl http://localhost:3000/scrape/cloro_AbCdEf...
# → poll until status === "success" or "failed"
```

### Useful commands

```bash
docker compose ps                      # what's running
docker compose logs -f worker          # tail worker logs
docker compose down                    # stop everything (keeps volumes)
docker compose down -v                 # stop and wipe db/redis/cache volumes
docker compose up -d --scale worker=4  # manual worker count (autoscaler will override)
```

---

## Backend API reference

All endpoints are JSON; `Content-Type: application/json` on requests with bodies.

### `POST /scrape` — create a scrape job

**Request body:**

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `prompt` | string | yes | — | 1–8000 chars |
| `country` | string | no | `us` (from `DEFAULT_COUNTRY`) | 2-letter ISO code, e.g. `gb`, `de` |
| `include.html` | boolean | no | `false` | include raw HTML in the result |
| `include.markdown` | boolean | no | `false` | include markdown rendering |

```json
{
  "prompt": "Who founded Anthropic?",
  "country": "us",
  "include": { "html": false, "markdown": true }
}
```

**Response — 202 Accepted:**

```json
{ "success": true, "public_id": "cloro_AbCdEf012345678", "status": "processing" }
```

**Errors:**

- `400` — `{ "success": false, "error": "prompt is required" }` (or similar Zod message)
- `503` — `{ "success": false, "error": "Could not queue the request" }` (queue / db unavailable)

---

### `GET /scrape/:public_id` — poll job status / result

**Path param:** `public_id` matching `cloro_[A-Za-z0-9]{15}`.

**Response — 200, status `processing`:**

```json
{
  "success": true,
  "public_id": "cloro_AbCdEf012345678",
  "status": "processing",
  "createdAt": "2026-05-20T10:29:11.007Z",
  "scrapeMs": null,
  "totalMs": null,
  "attempts": null,
  "wallHits": null
}
```

**Response — 200, status `success`:**

```json
{
  "success": true,
  "public_id": "cloro_AbCdEf012345678",
  "status": "success",
  "createdAt": "2026-05-20T10:29:11.007Z",
  "scrapeMs": 32408,
  "totalMs": 38211,
  "attempts": 5,
  "wallHits": 1,
  "result": {
    "text": "Anthropic was founded in 2021 by ...",
    "sources": [
      "https://en.wikipedia.org/wiki/Anthropic",
      "https://anthropic.com/company"
    ],
    "markdown": "Anthropic was founded in **2021** by ...",
    "html": "<p>Anthropic was founded in <strong>2021</strong> ..."
  }
}
```

`markdown` and `html` are only present if requested via `include`.

**Response — 200, status `failed`:**

```json
{
  "success": false,
  "public_id": "cloro_AbCdEf012345678",
  "status": "failed",
  "createdAt": "2026-05-20T10:29:11.007Z",
  "scrapeMs": null,
  "totalMs": 187320,
  "attempts": 15,
  "wallHits": 9,
  "error": "Sign-up wall while awaiting answer"
}
```

**Errors:**

- `400` — `{ "success": false, "error": "invalid public_id" }`
- `404` — `{ "success": false, "error": "unknown public_id" }`

---

### `GET /scrapes` — list recent jobs (history)

**Query params:** `limit` (1–500, default 100), `offset` (default 0).

```
GET /scrapes?limit=25&offset=0
```

**Response — 200:**

```json
{
  "success": true,
  "jobs": [
    {
      "publicId": "cloro_AbCdEf012345678",
      "prompt": "Who founded Anthropic?",
      "country": "us",
      "status": "success",
      "createdAt": "2026-05-20T10:29:11.007Z",
      "scrapeMs": 32408,
      "totalMs": 38211,
      "attempts": 5,
      "wallHits": 1,
      "error": null
    }
  ]
}
```

Ordered by `createdAt DESC, id DESC`.

---

### `GET /analytics` — aggregate metrics across all jobs

**Response — 200:**

```json
{
  "total": 500,
  "success": 481,
  "failed": 19,
  "processing": 0,
  "successRate": 96.2,
  "avgScrapeMs": 38245,
  "avgTotalMs": 198322
}
```

---

### `GET /stats` — live worker + queue snapshot

**Response — 200:**

```json
{
  "workers": 8,
  "browsers": 8,
  "tabsPerRequest": 5,
  "queue": { "waiting": 42, "active": 8 }
}
```

`browsers` always equals `workers` (one reused browser per worker process).

---

### `GET /events` — Server-Sent Events stream

`Content-Type: text/event-stream`. The connection stays open; the server pushes JSON-encoded `AppEvent` frames as they happen.

```
retry: 3000

data: {"type":"stats","workers":8,"tabsPerRequest":5,"queue":{"waiting":42,"active":8}}

data: {"type":"job","summary":{"publicId":"cloro_...","status":"success", ...}}

:
```

Frame types:

- `{ "type": "stats", "workers", "tabsPerRequest", "queue": { waiting, active } }` — emitted at most once per second when anything changes
- `{ "type": "job", "summary": <JobSummary> }` — emitted on every job state transition (queued → processing → success/failed)

Comments (lines starting with `:`) are 15-second heartbeats to keep intermediaries from closing the connection as idle.

Client example:

```js
const es = new EventSource('/events');
es.onmessage = (msg) => {
  const event = JSON.parse(msg.data);
  if (event.type === 'job') updateRow(event.summary);
  if (event.type === 'stats') updateHeader(event);
};
```

---

### `GET /health` — liveness probe

**Response — 200:**

```json
{ "status": "ok", "uptime": 12345 }
```

`uptime` is the api process uptime in seconds.

