#!/bin/bash

# Continuous backfill loop — keeps embedding until all papers done
LOG="/tmp/continuous-backfill.log"

echo "=== Continuous Backfill Started ===" >> $LOG
echo "Target: Embed all 27,592 papers" >> $LOG
echo "Start time: $(date)" >> $LOG

while true; do
  echo "" >> $LOG
  echo "--- Backfill attempt at $(date) ---" >> $LOG
  
  # Check current status
  STATUS=$(node -e "
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();
const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { count } = await supabase.from('works').select('*', { count: 'exact', head: true }).is('embedding', null);
console.log(count);
" 2>/dev/null)
  
  echo "Missing embeddings: $STATUS" >> $LOG
  
  if [ "$STATUS" = "0" ] || [ -z "$STATUS" ]; then
    echo "✓ All papers embedded! Exiting." >> $LOG
    echo "Completion time: $(date)" >> $LOG
    break
  fi
  
  # Run backfill for up to 4 hours
  timeout 14400 node scripts/backfill-fast.mjs >> $LOG 2>&1
  
  # Wait 5 minutes before next attempt
  sleep 300
done
