import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { data, error } = await supabase
  .from('works')
  .select('id, title, abstract')
  .is('embedding', null)
  .limit(3);

if (error) {
  console.error('Fetch error:', error);
  process.exit(1);
}

console.log('Fetched:', data.length, 'papers');
data.forEach(r => console.log(`  - ${r.id}: "${r.title}"`));
