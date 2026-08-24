import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { data } = await supabase
  .from('works')
  .select('id, title, abstract, source')
  .is('embedding', null)
  .limit(3);

console.log('Sample of missing embeddings:');
data.forEach(row => {
  console.log(`\nID: ${row.id} (${row.source})`);
  console.log(`Title: ${row.title ? row.title.slice(0, 80) : 'NULL'}`);
  console.log(`Abstract: ${row.abstract ? row.abstract.slice(0, 60) + '...' : 'NULL'}`);
});
