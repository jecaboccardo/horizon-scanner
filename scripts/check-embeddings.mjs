import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { count: total } = await supabase.from('works').select('id', { count: 'exact', head: true });
const { count: missing } = await supabase.from('works').select('id', { count: 'exact', head: true }).is('embedding', null);

console.log(`Total papers: ${total}`);
console.log(`Missing embeddings: ${missing}`);
console.log(`Embedded: ${total - missing} (${Math.round((total - missing) / total * 100)}%)`);
