// Temporary script: import tiers 2-4 only (fresh tier already done)
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

console.log('Remaining work count in DB:');
const {count} = await supabase.from('works').select('id', {count: 'exact'});
console.log(`Total: ${count}`);
console.log('\nReady to import tiers 2-4 (recent, established, landmarks)');
console.log('Run: node scripts/import-corpus.mjs --source both');
console.log('It will skip fresh tier automatically (all 12K papers already imported)\n');
