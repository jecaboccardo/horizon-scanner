#!/usr/bin/env bash
# Runs 3 backfill workers in parallel, partitioned by direction
# Worker 0: ascending IDs (low end)
# Worker 1: descending IDs (high end)
# Worker 2: ascending IDs (catches overlap in middle)

WORKERS=3
LOG_DIR="logs"
mkdir -p "$LOG_DIR"

check_done() {
  node -e "
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
config();
const sb = createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
sb.from('works').select('*', { count: 'exact', head: true }).is('embedding', null).then(({ count }) => { console.log(count); process.exit(0); });
" 2>/dev/null
}

run_worker() {
  local id=$1
  while true; do
    WORKER=$id node scripts/backfill-fast.mjs >> "$LOG_DIR/worker-${id}.log" 2>&1
    sleep 2
  done
}

echo "Starting $WORKERS parallel backfill workers..."
echo "Logs: $LOG_DIR/worker-{0,1,2}.log"
echo "Press Ctrl+C to stop"

# Start workers in background
for i in $(seq 0 $((WORKERS - 1))); do
  run_worker $i &
  PIDS+=($!)
  echo "Worker $i started (PID ${PIDS[-1]})"
  sleep 3  # stagger starts slightly so they don't grab identical first batches
done

# Monitor until done
while true; do
  sleep 60
  MISSING=$(check_done)
  echo "[$(date '+%H:%M')] Missing embeddings: $MISSING"
  if [ "$MISSING" = "0" ]; then
    echo "All papers embedded! Stopping workers..."
    for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null; done
    exit 0
  fi
done
