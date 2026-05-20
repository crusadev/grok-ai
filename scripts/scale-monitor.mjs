/**
 * Snapshot worker replica count + queue depth every TICK_MS while a load test
 * runs. NDJSON to stdout (or --out=path). Stop with SIGINT.
 *   node scripts/scale-monitor.mjs [--tick=5000] [--out=runs/scale.ndjson]
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const TICK = Number(args.tick ?? 5000);
const OUT = args.out ?? null;
const BASE = (args.base ?? 'http://localhost:3000').replace(/\/$/, '');

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, '');
}

const execFileAsync = promisify(execFile);

async function countWorkerContainers() {
  const { stdout } = await execFileAsync('docker', [
    'compose',
    'ps',
    '--status',
    'running',
    '--format',
    '{{.Service}}',
    'worker',
  ]);
  return stdout.split('\n').filter((l) => l.trim() === 'worker').length;
}

async function getStats() {
  try {
    const r = await fetch(`${BASE}/stats`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

const t0 = Date.now();
console.log('# scale-monitor t0=' + new Date(t0).toISOString());
console.log('# tick=' + TICK + 'ms  out=' + (OUT ?? '(stdout)'));

while (!stopping) {
  const ts = Date.now();
  let replicas = null;
  try { replicas = await countWorkerContainers(); } catch {}
  const stats = await getStats();
  const row = {
    t: ts,
    elapsedSec: ((ts - t0) / 1000).toFixed(1),
    replicas,
    waiting: stats?.queue?.waiting ?? null,
    active: stats?.queue?.active ?? null,
    workers: stats?.workers ?? null,
  };
  const line = JSON.stringify(row);
  if (OUT) appendFileSync(OUT, line + '\n');
  console.log(line);
  await new Promise((r) => setTimeout(r, TICK));
}
