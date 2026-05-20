# 500-Prompt Load Test — Report | Further documentation

Date of run: 2026-05-20
Hardware: single i9-12900K, 32 GB RAM DDR5
Stack: docker-compose (api, worker x N, db, redis, web) + host-side autoscaler
Proxy provider: PrivateProxy.me (rotating residential, `edge1-us.privateproxy.me:8888`)

---

## 1. Why jobs failed and how to fix them

### 1.1 The two failure numbers explained

Two failure counts appeared during the run and they measured different things:

| Source | Number | What it actually counts |
|---|---|---|
| Frontend / DB | ~22 (snapshot during run) → **19** (final) | Jobs the worker terminally failed and wrote `status='failed'` to Postgres |
| Load-test summary (`pp500.summary.json`) | 108 | Jobs the test client (`scripts/run-load.mjs`) gave up polling on after `--job-timeout-ms=300000` (5 min) |

Reconciling the 108 client-timeouts against the DB (`GET /scrape/:id` for each):

```
of 108 "client_timeouts":
  actual DB success: 89    ← server finished, client had given up polling
  actual DB failed:  19    ← real failures
  still processing:   0
```

**True numbers: 481 / 500 = 96.2% success, 19 real failures (3.8%).** The 22 the frontend showed was a mid-run snapshot that still included a handful of in-flight jobs that later resolved.

### 1.2 Breakdown of the 19 real failures

```
9  page.goto: Timeout 12000ms exceeded            ← proxy/edge nav timeout
4  Authenticity check while awaiting answer       ← grok anti-bot (Cloudflare-class)
3  Sign-up wall while awaiting answer             ← grok anti-bot (sign-up CTA mid-stream)
2  Timed out waiting for Grok to start answering
1  scrape job deadline exceeded                   ← server-side 150 s cap
```

### 1.3 Per-country distribution (reconciled, post-run)

| Country | Total | Success | Rate |
|---|---|---|---|
| us | 75  | 75  | **100.0%** |
| ca | 287 | 286 | **99.7%**  |
| br | 11  | 11  | **100.0%** |
| de | 23  | 22  | **95.7%**  |
| gb | 48  | 44  | **91.7%**  |
| jp | 22  | 17  | 77.3%      |
| fr | 17  | 13  | 76.5%      |
| au | 17  | 13  | 76.5%      |

US/CA/BR ran flawlessly. Failures concentrate in **smaller proxy pools** (JP/FR/AU), suggesting IP-pool starvation more than fundamental anti-bot defeat.
The current test run used PrivateProxy as the proxy pool, a previous test done with decodo proxy pool ran 250 requests without failures, this is more a matter of proxies quality.

## 2. Run metrics — the headline table

| Metric | Value |
|---|---|
| Prompts | 500 |
| Client concurrency | 50 (in-flight cap at the load-test side) |
| Wall clock | **2723.3 s (45 min 23 s)** |
| Throughput | **11.0 jobs/min** (0.18 RPS sustained) |
| Per-worker throughput | 1.4 jobs/min/worker (saturated at 8 workers) |
| Real success | **481 / 500 = 96.2%** |
| Real failed | 19 (3.8%) |
| Mislabeled timeouts | 108 (89 succeeded, 19 failed on the server) |
| Proxy bandwidth | ~2.7 GB total (~5.4 MB/req) |

### 2.1 Latency

`scrapeMs` is the time *inside the worker* doing the scrape — proxy/page/streaming time only.
`totalMs` is queue wait + scrape — what the user sees end-to-end.

|  | scrapeMs | totalMs |
|---|---|---|
| p50 | **32.4 s** | 255.0 s |
| p95 | 69.0 s     | 292.8 s |
| p99 | 87.6 s     | 298.2 s |

The huge gap between `scrapeMs` and `totalMs` is **queue time**. We submitted at concurrency 50 against 8 workers, so the median job spent ~4 min waiting in line before its 32 s of actual work. This is by design — it's how the queue tolerates burst submissions — but it does mean the 5-min client timeout was tight (see §1.1).

### 2.2 The 64% bandwidth win is real

Compared to a pre-cache 10-prompt baseline (14.9 MB/req), this 500-prompt run averaged **5.4 MB/req** — a 64% reduction maintained at 50× scale. The extended CDN cache (`CDN_CACHE_PATH_PATTERNS` matching `/_next/static/`, `.js`, `.css`, `.woff2`, etc.) caught Monaco editor, Cloudflare challenge JS, Stripe, Google APIs, Cookielaw — all previously refetched per browser context.

---

## 3. How the autoscaler and scalability actually work

### 3.1 Component diagram

```
                         ┌────────────────┐
   client (run-load) ──▶ │   api (Node)   │ ──▶ writes job row to Postgres
                         │  /scrape POST  │     status='processing'
                         └───────┬────────┘     enqueues into BullMQ
                                 │
                                 ▼
                         ┌────────────────┐
                         │ Redis (BullMQ) │  ◀── autoscaler reads waiting/active
                         │   scrape queue │
                         └───────┬────────┘
                                 │
                  ┌──────────────┼──────────────┐
                  ▼              ▼              ▼
            ┌──────────┐   ┌──────────┐   ┌──────────┐
            │ worker-1 │   │ worker-2 │ … │ worker-N │   (N = 1…MAX_WORKER_REPLICAS)
            │          │   │          │   │          │
            │ 1 browser│   │ 1 browser│   │ 1 browser│
            │ 5 tabs   │   │ 5 tabs   │   │ 5 tabs   │
            │ per job  │   │ per job  │   │ per job  │
            └─────┬────┘   └─────┬────┘   └─────┬────┘
                  │              │              │
                  └──────────────┼──────────────┘
                                 ▼
                         writes back to Postgres
                         publishes job event to Redis pub/sub
                                 │
                                 ▼
                            api SSE stream ──▶ React frontend
```

The host runs one autoscaler process (`dist/autoscaler.js`) that watches Redis and calls `docker compose --scale worker=N` when the target changes.

### 3.2 What scales horizontally

| Component | Scaled by | Limit |
|---|---|---|
| Worker containers | Autoscaler tick on queue depth | `MAX_WORKER_REPLICAS=8` (RAM-bound on this box) |
| Browser contexts (per worker) | `TABS_PER_REQUEST=5` per job | Per-job, not per-worker |
| Postgres connections | `PG_POOL_MAX=3` per worker, 6 for api | DB-side `max_connections`, irrelevant at this scale |
| BullMQ queue | Redis throughput | Effectively unbounded for our load |

What doesn't scale on a single box: **RAM** (32 GB ceiling = ~16 workers at 1.8 GB each + ~2 GB headroom), **CPU** (16 cores saturate around 8–12 active workers under Chromium load), **single Docker daemon** (can't span hosts).

### 3.3 The autoscaler algorithm — exact behavior

Source: `src/autoscaler.ts`.

```ts
const TICK_MS = 5000;

function desiredReplicas(waiting, active, current) {
  const want   = Math.ceil((waiting + active) / WORKER_CONCURRENCY) || 1;
  const target = Math.min(Math.max(want, 1), MAX_WORKER_REPLICAS);
  if (target >= current) return target;   // scale-up: snap immediately
  if (active > 0)        return current;  // scale-down: hold while jobs in flight
  return target;                          // queue fully drained: shrink
}
```

Three rules drive everything:

1. **Scale up snaps to the target.** No ramp, no cool-down. If the queue jumps to 30 jobs, the next tick (≤5 s) requests 8 workers.
2. **Scale down is held while `active > 0`.** Docker Compose kills workers by the highest replica index, and we have no way to guarantee those indices are the idle ones. So we wait until every job finishes before shrinking. This is the fix for the mid-job-kill failures we hit on the original 60-prompt test (where workers 6/7/8 got SIGTERMed mid-scrape).
3. **Hard cap at `MAX_WORKER_REPLICAS`.** Configured in `.env` (8 in this setup), checked at process startup against `GLOBAL_MAX_CONCURRENT_JOBS` so RAM can't be exceeded.

Each tick:

```
1. Read BullMQ waiting + active counts (2 cheap Redis reads)
2. Compute desired replicas
3. If different from current: call `docker compose up -d --no-recreate --scale worker=N`
4. Wait TICK_MS (5 s), repeat
```

Total tick cost: <50 ms when no scaling is needed; ~1–3 s when actually rescaling (Compose has to do its bookkeeping).

### 3.4 Graceful worker drain

When `docker compose --scale worker=N` shrinks the pool, the workers being removed receive `SIGTERM`. Their shutdown path is in `src/worker-main.ts`:

```
1. SIGTERM caught
2. logger.info("draining in-flight jobs")
3. stopWorker() → bullmq.Worker.close() — waits for the active job to finish
4. closeBrowser() — closes shared Chromium cleanly
5. closeEvents(), closeQueue(), closeDb()
6. process.exit(0)
```

Two safety nets:

- `stop_grace_period: 240 s` in `docker-compose.yml` — Docker won't SIGKILL before this elapses (we observed totalMs.p99 ~ 187 s, so 240 s comfortably covers the worst case)
- A `setTimeout(..., 225_000)` in the worker — we force-exit ourselves 15 s before Docker would, so Docker's SIGKILL is never the one to pull the plug

Combined with rule 2 above (don't shrink while `active > 0`), the result is **zero mid-job kills**. Verified across the 60-prompt and 500-prompt runs.

### 3.5 What the 500-prompt run looked like in real time

From `runs/pp500.monitor.ndjson` (sampled every 5 s):

- t=0–5 s: 1 worker, queue jumps from 0 to ~50 waiting as the load test submits
- t=5–15 s: autoscaler scales 1 → 8 in two ticks
- t=15 s – 44 min: 8 workers saturated, queue drains at ~11 jobs/min, `active=8` continuously, `waiting` decreasing
- t=44 min: queue empty, `active` starts decreasing (8 → 5 → 1 → 0)
- t=45 min 23 s: `active=0` for first time; autoscaler shrinks 8 → 1 on next tick

Behaviour matched the spec exactly — no scale-down jitter, no replica thrashing.

### 3.6 Where this architecture stops scaling

The cliff this PoC will hit before others matter:

1. **Single-host RAM ceiling.** At 1.8 GB/worker × 8 = 14.4 GB workers + ~2 GB for db/redis/api/web/OS = ~16.5 GB. Headroom for 16 workers (28.8 GB workers) is technically there, but CPU saturates first under Chromium.
2. **Single Docker daemon.** Can't span hosts. To go past ~16 workers requires either multiple boxes with shared Redis (still single-master queue) or moving to k8s.
3. **Per-tab proxy bandwidth.** 5 contexts/req × ~5.4 MB/req → at higher throughput, proxy is the dollar-line item, not the rate limit.
4. **grok.com anti-bot tolerance.** Volume itself draws attention. The PoC succeeds at 0.18 RPS partly because it's quiet; sustained 16 RPS would change grok's defensive posture.

This was a decision made to not overcomplicate things for the PoC due to lack of time

### 3.7 Production scaling plan

The plan is intentionally the architecture we already run — sized up, not redesigned. Two principles:

1. **One single entry point for all client traffic.** Every request hits one backend URL. The client never knows about workers, queues, or proxies — that complexity stays internal.
2. **Automatic scaling end-to-end.** Both the backend itself and the worker pool grow and shrink on load, with no human in the loop, fast enough that a traffic spike is absorbed before the queue tail becomes user-visible.

```
                    ┌────────────────────────────┐
   clients ───────▶ │   load balancer (one URL)  │
                    └─────────────┬──────────────┘
                                  │
                    ┌─────────────▼──────────────┐
                    │  backend (api) — N replicas│   ← autoscaled on CPU / RPS
                    │   POST /scrape  (enqueue)  │
                    │   GET  /scrape/:id (read)  │
                    │   GET  /events     (SSE)   │
                    └─────────────┬──────────────┘
                                  │
                          ┌───────▼────────┐
                          │ managed Redis  │   ← BullMQ queue absorbs bursts
                          │ (queue + pubsub)│
                          └───────┬────────┘
                                  │
                    ┌─────────────▼──────────────┐
                    │ worker pool — M replicas   │   ← autoscaled on QUEUE DEPTH
                    │ (same image as the PoC)    │     (the autoscaler.ts logic,
                    │ 1 browser + 5-tab race     │      ported to the host platform)
                    └─────────────┬──────────────┘
                                  │
                          ┌───────▼────────┐
                          │ managed Postgres│
                          │ (job results)   │
                          └─────────────────┘
```

#### Why this works without redesign

Every part of this picture already exists in the PoC; only the deployment surface changes:

| Component | PoC today | Production |
|---|---|---|
| Backend entry point | `api` container, one replica | Same code, **N replicas behind a load balancer**, autoscaled on RPS / CPU |
| Burst absorption | BullMQ + Redis container | Same, **managed Redis** (Elasticache / MemoryStore / equivalent) |
| Worker pool | 1–M containers, scaled by `autoscaler.ts` | Same image, **scaled cluster-wide** on queue depth |
| Job state | Postgres container | Same schema, **managed Postgres** (RDS / Cloud SQL / equivalent) |
| Provider abstraction | `ProxyProvider` factory | Unchanged — add new vendors as new branches |
| CDN cache | Per-host Docker volume | Shared cache layer (or rebuilt on each pod from a baked image) |

The autoscaling story applies in **two places**, both already designed-for:

- **Backend autoscaling.** The api service is stateless, so it scales linearly on RPS. Set a target like "5 RPS per replica" and the platform handles it. No code change.
- **Worker autoscaling.** The PoC's `desiredReplicas()` algorithm — scale up immediately, hold scale-down while jobs are active — ports directly to any queue-depth-driven autoscaler the host platform supports.

The current scale-up reaction time is ~5–15 s (one autoscaler tick + container start). In production the same number is dominated by:

- Container cold start: ~5–10 s for the image to pull and Node to boot
- Browser warm-up: ~2–3 s for Chromium to be ready
- **Total: ~10–15 s for a brand-new worker to start processing**

