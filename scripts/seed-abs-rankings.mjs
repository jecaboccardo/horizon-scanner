// Seed abs_rankings table from scraped CSV
// Run: node scripts/seed-abs-rankings.mjs

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (line[i] === ',' && !inQuotes) {
      result.push(current); current = '';
    } else {
      current += line[i];
    }
  }
  result.push(current);
  return result;
}

const csv = readFileSync('data/abs_rankings_full.csv', 'utf8');
const lines = csv.split('\n').filter(l => l.trim());
const rows = lines.slice(1).map(parseCSVLine);

console.log(`Parsed ${rows.length} journals from CSV`);

// Map to DB schema
const records = rows.map(([issn, field, title, publisher, ajg2024, ajg2021, ajg2018]) => ({
  journal_name: title,
  abs_rating: ajg2024,
  field,
  issn,
  publisher,
  ajg2021,
  ajg2018,
}));

// Insert in batches of 200
const BATCH = 200;
let inserted = 0;
for (let i = 0; i < records.length; i += BATCH) {
  const batch = records.slice(i, i + BATCH);
  const { error } = await supabase
    .from('abs_rankings')
    .upsert(batch, { onConflict: 'journal_name' });
  if (error) {
    console.error(`Batch ${i / BATCH + 1} error:`, error.message);
    // Try individual inserts for failed batch
    for (const rec of batch) {
      const { error: e2 } = await supabase
        .from('abs_rankings')
        .upsert(rec, { onConflict: 'journal_name' });
      if (e2) console.error(`  Failed: ${rec.journal_name} — ${e2.message}`);
      else inserted++;
    }
  } else {
    inserted += batch.length;
    console.log(`  Batch ${Math.floor(i / BATCH) + 1}: ${batch.length} inserted (total: ${inserted})`);
  }
}

console.log(`\nDone! ${inserted} journals loaded into abs_rankings`);
