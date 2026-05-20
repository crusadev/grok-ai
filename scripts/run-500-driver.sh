#!/usr/bin/env bash
# Unattended 500-prompt run driver. Wraps the load test + monitor and prints
# a clear DONE marker so progress is easy to check with `tail -f runs/pp500.driver.log`.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==================================================="
echo " 500-prompt unattended run"
echo " started:  $(date -Iseconds)"
echo " host:     $(hostname)"
echo " pid:      $$"
echo "==================================================="

# Sample queue + replicas every 5s for the duration of the run.
node scripts/scale-monitor.mjs --tick=5000 --out=runs/pp500.monitor.ndjson \
  > runs/pp500.monitor.stdout 2>&1 &
MON=$!
echo "monitor pid=$MON"

# Concurrency 50 keeps the queue well-fed so the autoscaler stays at max
# replicas (8) throughout. poll-ms 3000 keeps client→api load reasonable
# (~17 polls/s steady-state). job-timeout-ms 300000 = 5 min hard ceiling.
node scripts/run-load.mjs \
  --prompts=prompts.scale500.json \
  --concurrency=50 \
  --poll-ms=3000 \
  --job-timeout-ms=300000 \
  --out=runs/pp500.ndjson \
  > runs/pp500.load.stdout 2>&1

LOAD_EXIT=$?
echo "load test exited with code $LOAD_EXIT"

# Stop the monitor cleanly so the ndjson flushes.
kill -INT "$MON" 2>/dev/null
wait "$MON" 2>/dev/null

echo "==================================================="
echo " DONE at $(date -Iseconds)"
echo "==================================================="
# Inline summary so a single `tail` reveals the headline numbers.
tail -25 runs/pp500.load.stdout
