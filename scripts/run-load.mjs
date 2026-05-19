/**
 * Submit prompts.json against the API with bounded in-flight, poll to terminal,
 * emit per-job NDJSON and a final summary. Host-direct by default.
 *   node scripts/run-load.mjs \
 *     [--prompts=prompts.json] [--concurrency=50] [--base=http://localhost:3000] \
 *     [--poll-ms=1500] [--job-timeout-ms=300000] [--out=runs/<ts>.ndjson]
 */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPTS = resolve(ROOT, args.prompts ?? 'prompts.json');
const CONCURRENCY = Number(args.concurrency ?? 50);
const BASE = (args.base ?? 'http://localhost:3000').replace(/\/$/, '');
const POLL_MS = Number(args['poll-ms'] ?? 1500);
const JOB_TIMEOUT = Number(args['job-timeout-ms'] ?? 300_000);
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = resolve(ROOT, args.out ?? `runs/${TS}.ndjson`);
const SUMMARY = OUT.replace(/\.ndjson$/, '.summary.json');

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, '');

const prompts = JSON.parse(readFileSync(PROMPTS, 'utf8'));
console.log(`loaded ${prompts.length} prompts from ${PROMPTS}`);
console.log(`target ${BASE} · concurrency=${CONCURRENCY} · poll=${POLL_MS}ms · timeout=${JOB_TIMEOUT}ms`);
console.log(`writing ${OUT}`);

const t0 = Date.now();
let submitted = 0;
let completed = 0;
let success = 0;
let failed = 0;
let timedOut = 0;
let inFlight = 0;
const results = [];

async function postJson(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

async function getJson(path) {
  const r = await fetch(BASE + path);
  return { status: r.status, body: await r.json() };
}

function record(line) {
  appendFileSync(OUT, JSON.stringify(line) + '\n');
  results.push(line);
}

async function runOne(spec, idx) {
  const submittedAt = Date.now();
  let publicId = null;
  try {
    const { status, body } = await postJson('/scrape', {
      prompt: spec.prompt,
      country: spec.country,
      include: { html: !!spec.html, markdown: !!spec.markdown },
    });
    if (status !== 202 || !body?.public_id) {
      record({
        idx,
        country: spec.country,
        status: 'submit_failed',
        httpStatus: status,
        error: body?.error ?? `http ${status}`,
        submittedAt,
        clientMs: Date.now() - submittedAt,
      });
      failed += 1;
      return;
    }
    publicId = body.public_id;
  } catch (err) {
    record({
      idx,
      country: spec.country,
      status: 'submit_failed',
      error: err?.message ?? String(err),
      submittedAt,
      clientMs: Date.now() - submittedAt,
    });
    failed += 1;
    return;
  }

  const deadline = submittedAt + JOB_TIMEOUT;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let res;
    try {
      res = await getJson(`/scrape/${publicId}`);
    } catch {
      continue;
    }
    const b = res.body ?? {};
    if (b.status === 'success' || b.status === 'failed') {
      record({
        idx,
        publicId,
        country: spec.country,
        markdown: !!spec.markdown,
        html: !!spec.html,
        status: b.status,
        scrapeMs: b.scrapeMs ?? null,
        totalMs: b.totalMs ?? null,
        attempts: b.attempts ?? null,
        wallHits: b.wallHits ?? null,
        error: b.error ?? null,
        sources: b.result?.sources?.length ?? 0,
        textLen: b.result?.text?.length ?? 0,
        submittedAt,
        clientMs: Date.now() - submittedAt,
      });
      if (b.status === 'success') success += 1; else failed += 1;
      return;
    }
  }

  record({
    idx,
    publicId,
    country: spec.country,
    status: 'client_timeout',
    submittedAt,
    clientMs: Date.now() - submittedAt,
  });
  timedOut += 1;
  failed += 1;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const liveTimer = setInterval(() => {
  const elapsed = (Date.now() - t0) / 1000;
  const rpm = completed > 0 ? (completed / elapsed) * 60 : 0;
  const remaining = prompts.length - completed;
  const eta = rpm > 0 ? remaining / (rpm / 60) : Infinity;
  process.stdout.write(
    `\r[${elapsed.toFixed(0)}s] submitted=${submitted}/${prompts.length} ` +
    `inflight=${inFlight} done=${completed} ok=${success} fail=${failed} ` +
    `(timeouts=${timedOut}) · ${rpm.toFixed(1)}/min · eta=${isFinite(eta) ? eta.toFixed(0) + 's' : '∞'}   `,
  );
}, 1000);

// Bounded in-flight: keep CONCURRENCY workers pulling from the queue.
let cursor = 0;
async function worker() {
  while (cursor < prompts.length) {
    const i = cursor++;
    inFlight += 1;
    submitted += 1;
    try {
      await runOne(prompts[i], i);
    } finally {
      inFlight -= 1;
      completed += 1;
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

clearInterval(liveTimer);
process.stdout.write('\n');

const wall = (Date.now() - t0) / 1000;
const ok = results.filter((r) => r.status === 'success');
const scrapeTimes = ok.map((r) => r.scrapeMs).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
const totalTimes = ok.map((r) => r.totalMs).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
const pct = (xs, p) => (xs.length === 0 ? null : xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]);

const attemptsHist = {};
for (const r of ok) {
  const a = r.attempts ?? 0;
  attemptsHist[a] = (attemptsHist[a] ?? 0) + 1;
}
const errorBreakdown = {};
for (const r of results.filter((r) => r.status !== 'success')) {
  const key = (r.error ?? r.status ?? 'unknown').slice(0, 80);
  errorBreakdown[key] = (errorBreakdown[key] ?? 0) + 1;
}
const byCountry = {};
for (const r of results) {
  const c = r.country ?? '??';
  byCountry[c] ??= { total: 0, success: 0 };
  byCountry[c].total += 1;
  if (r.status === 'success') byCountry[c].success += 1;
}

const summary = {
  prompts: prompts.length,
  concurrency: CONCURRENCY,
  base: BASE,
  startedAt: new Date(t0).toISOString(),
  wallSeconds: wall,
  throughputPerMin: prompts.length / (wall / 60),
  success,
  failed,
  timedOut,
  successRate: success / prompts.length,
  scrapeMs: { p50: pct(scrapeTimes, 50), p95: pct(scrapeTimes, 95), p99: pct(scrapeTimes, 99) },
  totalMs: { p50: pct(totalTimes, 50), p95: pct(totalTimes, 95), p99: pct(totalTimes, 99) },
  attemptsHistogram: attemptsHist,
  errorBreakdown,
  byCountry,
};
writeFileSync(SUMMARY, JSON.stringify(summary, null, 2) + '\n');

console.log('\n=== summary ===');
console.log(`wall:        ${wall.toFixed(1)}s (${(wall / 60).toFixed(1)} min)`);
console.log(`throughput:  ${summary.throughputPerMin.toFixed(1)}/min`);
console.log(`success:     ${success}/${prompts.length} (${(summary.successRate * 100).toFixed(1)}%)`);
console.log(`failed:      ${failed} (timeouts=${timedOut})`);
console.log(`scrape p50/p95/p99: ${summary.scrapeMs.p50}/${summary.scrapeMs.p95}/${summary.scrapeMs.p99} ms`);
console.log(`total  p50/p95/p99: ${summary.totalMs.p50}/${summary.totalMs.p95}/${summary.totalMs.p99} ms`);
console.log(`attempts histogram:`, attemptsHist);
console.log(`top errors:`, Object.entries(errorBreakdown).sort((a, b) => b[1] - a[1]).slice(0, 5));
console.log(`per country:`, byCountry);
console.log(`\nndjson: ${OUT}`);
console.log(`summary: ${SUMMARY}`);
