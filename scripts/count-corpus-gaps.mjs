#!/usr/bin/env node
// Reports counts of corpus gaps: null abstracts, embeddings, citations, SMS, geography
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'fs';
config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function cnt(extraFilters = []) {
  let q = sb.from('works')
    .select('*', { count: 'exact', head: true })
    .is('canonical_work_id', null)
    .not('is_noise', 'is', true);
  for (const f of extraFilters) q = q[f[0]](...f.slice(1));
  const { count, error } = await q;
  if (error) throw new Error(JSON.stringify(error));
  return count;
}

console.log('Counting corpus gaps...');

const [
  totalCanonical,
  nullAbstractAll,
  nullAbstractHasDoi,
  nullEmbedding,
  hasAbstractNullEmbedding,
  nullCitation,
  nullSms,
  nullSmsHasAbstract,
  nullGeography,
] = await Promise.all([
  cnt(),
  cnt([['is', 'abstract', null]]),
  cnt([['is', 'abstract', null], ['like', 'id', '10.%']]),
  cnt([['is', 'embedding', null]]),
  cnt([['not', 'abstract', 'is', null], ['is', 'embedding', null]]),
  cnt([['is', 'citation_count', null]]),
  cnt([['is', 'sms_level', null]]),
  cnt([['is', 'sms_level', null], ['not', 'abstract', 'is', null]]),
  cnt([['is', 'geography', null]]),
]);

const result = {
  generated_at: new Date().toISOString(),
  total_canonical_non_noise: totalCanonical,
  gaps: {
    null_abstract_total: nullAbstractAll,
    null_abstract_has_doi: nullAbstractHasDoi,
    null_embedding_total: nullEmbedding,
    has_abstract_null_embedding: hasAbstractNullEmbedding,
    null_citation_count: nullCitation,
    null_sms_level: nullSms,
    null_sms_has_abstract: nullSmsHasAbstract,
    null_geography: nullGeography,
  },
};

console.log(JSON.stringify(result, null, 2));
fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync('reports/corpus-gap-counts.json', JSON.stringify(result, null, 2));
console.log('\nWritten to reports/corpus-gap-counts.json');
