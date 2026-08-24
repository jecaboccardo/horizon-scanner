import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Count by source and corpus_source
const { data } = await supabase
  .from('works')
  .select('source, corpus_source, publication_date', { count: 'exact' });

console.log('Import status by source:');
const bySrc = {};
for (const row of data || []) {
  const key = `${row.source}/${row.corpus_source || 'direct'}`;
  bySrc[key] = (bySrc[key] || 0) + 1;
}

Object.entries(bySrc).sort().forEach(([k, v]) => {
  console.log(`  ${k}: ${v}`);
});

// Check year distribution for Semantic Scholar
const { data: ssYears } = await supabase.rpc('select', {
  select: 'year, count(*) as cnt',
  from: 'works',
  where: 'source = \'semantic_scholar\'',
  group_by: 'year',
  order_by: 'year desc'
});

console.log('\nSemantic Scholar year distribution:');
const grouped = {};
for (const row of data || []) {
  if (row.source !== 'semantic_scholar') continue;
  const y = row.publication_date?.slice(0, 4) || '?';
  grouped[y] = (grouped[y] || 0) + 1;
}

Object.entries(grouped).sort((a, b) => b[0] - a[0]).slice(0, 10).forEach(([y, c]) => {
  console.log(`  ${y}: ${c}`);
});
