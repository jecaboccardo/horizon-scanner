#!/usr/bin/env node
/**
 * Backfill works.geography (text[]) by regex over title + abstract +
 * raw_data. Tags individual countries plus region rollups (LAC,
 * Caribbean, Central America, OECD).
 *
 * Idempotent. Only writes rows where geography IS NULL (or empty array).
 * Sorted by id for resumability.
 *
 * Usage:
 *   node scripts/backfill-geography.mjs --dry-run --limit 5000
 *   node scripts/backfill-geography.mjs
 *
 * Prerequisite: migration 20260510000001_geography_column.sql applied.
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : Infinity;
})();
// Optional: restrict to a list of work ids (still gap-only — NULL/empty geography
// + has abstract). Accepts ["id",...] or [{id},...]. Used to backfill geography
// for a targeted set (e.g. papers that just gained an abstract) without re-paging
// the whole corpus's NULL-geo rows.
const IDS_FILE = (() => { const i = args.indexOf('--ids-file'); return i >= 0 ? args[i + 1] : null; })();

const PAGE = 1000;
const CONCURRENCY = 20;

// Country regex map. Each value: [canonicalName, regex].
// LAC sub-regions get rolled up automatically (any LAC country also tags 'LAC').
const LAC_COUNTRIES = [
  ['Brazil', /\b(brazil|brasil|brazilian|brasilian)\b/i],
  ['Mexico', /\b(mexico|mexican)\b/i],
  ['Colombia', /\b(colombia|colombian)\b/i],
  ['Argentina', /\b(argentina|argentine|argentinian)\b/i],
  ['Chile', /\b(chile|chilean)\b/i],
  ['Peru', /\b(peru|peruvian)\b/i],
  ['Ecuador', /\b(ecuador|ecuadorian|ecuadorean)\b/i],
  ['Bolivia', /\b(bolivia|bolivian)\b/i],
  ['Uruguay', /\buruguay\b/i],
  ['Paraguay', /\bparaguay\b/i],
  ['Venezuela', /\b(venezuela|venezuelan)\b/i],
  ['Costa Rica', /\bcosta\s*rica\b/i],
  ['Panama', /\bpanama\b/i],
  ['Honduras', /\bhonduras\b/i],
  ['Guatemala', /\bguatemala\b/i],
  ['El Salvador', /\bel\s*salvador\b/i],
  ['Nicaragua', /\bnicaragua\b/i],
  ['Dominican Republic', /\bdominican\s*republic\b/i],
  ['Haiti', /\bhaiti(an)?\b/i],
  ['Jamaica', /\bjamaica\b/i],
  ['Trinidad and Tobago', /\btrinidad\b/i],
  ['Barbados', /\bbarbados\b/i],
  ['Guyana', /\bguyana\b/i],
  ['Suriname', /\bsuriname\b/i],
  ['Belize', /\bbelize\b/i],
];
const CENTRAL_AMERICA = new Set([
  'Honduras', 'Guatemala', 'El Salvador', 'Nicaragua', 'Costa Rica', 'Panama', 'Belize',
]);
const CARIBBEAN = new Set([
  'Dominican Republic', 'Haiti', 'Jamaica', 'Trinidad and Tobago', 'Barbados',
  'Guyana', 'Suriname',
]);

const OTHER_COUNTRIES = [
  ['United States', /\b(united\s*states|\busa\b|\bu\.s\.a?\.?\b|american(?:s)?\b)\b/i],
  ['Canada', /\b(canada|canadian)\b/i],
  ['United Kingdom', /\b(united\s*kingdom|britain|british|\buk\b|england|england\b|scotland|wales)\b/i],
  ['Germany', /\b(germany|german)\b/i],
  ['France', /\b(france|french)\b/i],
  ['Italy', /\b(italy|italian)\b/i],
  ['Spain', /\b(spain|spanish)\b/i],
  ['Portugal', /\b(portugal|portuguese)\b/i],
  ['Netherlands', /\b(netherlands|dutch|holland)\b/i],
  ['Sweden', /\b(sweden|swedish)\b/i],
  ['Norway', /\b(norway|norwegian)\b/i],
  ['Denmark', /\b(denmark|danish)\b/i],
  ['Finland', /\b(finland|finnish)\b/i],
  ['Switzerland', /\b(switzerland|swiss)\b/i],
  ['Austria', /\b(austria|austrian)\b/i],
  ['Belgium', /\b(belgium|belgian)\b/i],
  ['Ireland', /\b(ireland|irish)\b/i],
  ['Greece', /\b(greece|greek)\b/i],
  ['Poland', /\b(poland|polish)\b/i],
  ['Turkey', /\b(turkey|t[uü]rkiye|turkish)\b/i],
  ['Russia', /\b(russia|russian)\b/i],
  ['Ukraine', /\b(ukraine|ukrainian)\b/i],
  ['China', /\b(china|chinese)\b/i],
  ['India', /\b(india|indian)\b/i],
  ['Japan', /\b(japan|japanese)\b/i],
  ['South Korea', /\b(south\s*korea|korean)\b/i],
  ['Indonesia', /\b(indonesia|indonesian)\b/i],
  ['Vietnam', /\b(vietnam|vietnamese)\b/i],
  ['Thailand', /\b(thailand|thai)\b/i],
  ['Philippines', /\b(philippines|filipino)\b/i],
  ['Malaysia', /\b(malaysia|malaysian)\b/i],
  ['Singapore', /\bsingapore\b/i],
  ['Pakistan', /\b(pakistan|pakistani)\b/i],
  ['Bangladesh', /\b(bangladesh|bangladeshi)\b/i],
  ['Sri Lanka', /\bsri\s*lanka\b/i],
  ['Nigeria', /\b(nigeria|nigerian)\b/i],
  ['Kenya', /\b(kenya|kenyan)\b/i],
  ['South Africa', /\bsouth\s*africa\b/i],
  ['Ethiopia', /\b(ethiopia|ethiopian)\b/i],
  ['Egypt', /\b(egypt|egyptian)\b/i],
  ['Morocco', /\b(morocco|moroccan)\b/i],
  ['Ghana', /\b(ghana|ghanaian)\b/i],
  ['Tanzania', /\btanzania\b/i],
  ['Uganda', /\b(uganda|ugandan)\b/i],
  ['Australia', /\b(australia|australian)\b/i],
  ['New Zealand', /\b(new\s*zealand)\b/i],
];

const OECD = new Set([
  'United States', 'Canada', 'United Kingdom', 'Germany', 'France', 'Italy',
  'Spain', 'Portugal', 'Netherlands', 'Sweden', 'Norway', 'Denmark',
  'Finland', 'Switzerland', 'Austria', 'Belgium', 'Ireland', 'Greece',
  'Poland', 'Turkey', 'Japan', 'South Korea', 'Australia', 'New Zealand',
]);

function extractGeography(text) {
  if (!text || typeof text !== 'string') return [];
  const tags = new Set();

  for (const [name, re] of LAC_COUNTRIES) {
    if (re.test(text)) tags.add(name);
  }
  for (const [name, re] of OTHER_COUNTRIES) {
    if (re.test(text)) tags.add(name);
  }
  // Region rollups
  if ([...tags].some((c) => LAC_COUNTRIES.some(([n]) => n === c))) tags.add('LAC');
  if ([...tags].some((c) => CENTRAL_AMERICA.has(c))) tags.add('Central America');
  if ([...tags].some((c) => CARIBBEAN.has(c))) tags.add('Caribbean');
  if ([...tags].some((c) => OECD.has(c))) tags.add('OECD');
  // Generic phrase tags
  if (/\b(latin\s*america|lac\b|cepal|eclac|iadb|\bidb\b)\b/i.test(text)) tags.add('LAC');
  if (/\bcaribbean\b/i.test(text)) tags.add('Caribbean');
  if (/\bcentral\s*america\b/i.test(text)) tags.add('Central America');
  if (/\b(oecd|developed\s*countries|high.income\s*countries)\b/i.test(text)) tags.add('OECD');
  if (/\b(sub.saharan\s*africa|africa)\b/i.test(text)) tags.add('Africa');
  if (/\b(southeast\s*asia|south.east\s*asia)\b/i.test(text)) tags.add('Southeast Asia');
  if (/\b(south\s*asia)\b/i.test(text)) tags.add('South Asia');
  if (/\b(east\s*asia)\b/i.test(text)) tags.add('East Asia');
  if (/\b(middle\s*east)\b/i.test(text)) tags.add('Middle East');
  if (/\b(europe(an)?)\b/i.test(text)) tags.add('Europe');

  return [...tags].sort();
}

async function* iterateTargets() {
  // IDS-FILE mode: only the listed ids, still gap-only (NULL/empty geo + has abstract).
  if (IDS_FILE) {
    const raw = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8'));
    const ids = raw.map((x) => (typeof x === 'string' ? x : x?.id)).filter(Boolean);
    for (let i = 0; i < ids.length && i < LIMIT; i += 200) {
      const batch = ids.slice(i, i + 200);
      const { data, error } = await supabase
        .from('works')
        .select('id, title, abstract')
        .in('id', batch)
        .or('geography.is.null,geography.eq.{}')
        .not('abstract', 'is', null);
      if (error) throw new Error(`ids-file fetch failed: ${error.message}`);
      if (data && data.length) yield data;
    }
    return;
  }

  // ABSTRACT PASS (2026-06-13): target rows whose title pass left geography NULL
  // OR empty {} (the title found nothing), restricted to rows that HAVE an
  // abstract to mine. KEYSET pagination by id (not offset) — the loop writes
  // matched rows out of the filtered set as it goes, so offset paging would skip
  // rows; `id > cursor` is stable under that mutation. (Original was
  // `.is('geography', null)` + offset.)
  let cursor = '';
  let yielded = 0;
  while (yielded < LIMIT) {
    let q = supabase
      .from('works')
      .select('id, title, abstract')
      .or('geography.is.null,geography.eq.{}')
      .not('abstract', 'is', null)
      .order('id', { ascending: true })
      .limit(PAGE);
    if (cursor) q = q.gt('id', cursor);
    const { data, error } = await q;
    if (error) {
      if (error.message?.includes('terminated')) {
        console.error(`  [retry] cursor ${cursor} terminated, waiting 3s`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw new Error(`targets fetch failed: ${error.message}`);
    }
    if (!data || data.length === 0) break;
    cursor = data[data.length - 1].id;
    yielded += data.length;
    yield data;
    if (data.length < PAGE) break;
  }
}

async function applyUpdates(updates) {
  if (updates.length === 0) return 0;
  let ok = 0;
  for (let i = 0; i < updates.length; i += CONCURRENCY) {
    const slice = updates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (u) => {
        const { id, geography } = u;
        try {
          const { error } = await supabase.from('works').update({ geography }).eq('id', id);
          if (error) {
            console.error(`  [warn] update ${id}: ${error.message}`);
            return false;
          }
          return true;
        } catch (err) {
          console.error(`  [warn] update ${id} threw: ${err.message}`);
          return false;
        }
      }),
    );
    ok += results.filter(Boolean).length;
  }
  return ok;
}

async function main() {
  console.log('='.repeat(70));
  console.log('Backfill works.geography');
  console.log('='.repeat(70));
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Limit:   ${LIMIT === Infinity ? '(unlimited)' : LIMIT.toLocaleString()}\n`);

  let processed = 0;
  let matched = 0;
  let writtenTotal = 0;
  const tagCounts = new Map();

  for await (const page of iterateTargets()) {
    const updates = [];
    for (const w of page) {
      processed += 1;
      // Skip raw_data — country signal lives in title + abstract for ~99% of
      // papers, and stringifying multi-KB JSONB per row was the main CPU cost.
      const text = `${w.title || ''} ${w.abstract || ''}`;
      const geo = extractGeography(text);
      if (geo.length > 0) {
        matched += 1;
        for (const t of geo) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
        updates.push({ id: w.id, geography: geo });
      }
      // ABSTRACT PASS (2026-06-13): write ONLY on a match. Non-matches stay as-is
      // ({} or NULL) — the old else-branch wrote {} for every non-match, which is
      // ~200k pointless no-op writes when the target set is already-{} rows. The
      // keyset cursor (id>last) prevents re-scanning regardless.
    }
    if (!DRY_RUN) {
      const ok = await applyUpdates(updates);
      writtenTotal += ok;
    }
    console.log(`  ${processed.toLocaleString()} scanned · ${matched.toLocaleString()} matched (${((matched / processed) * 100).toFixed(1)}%) · ${writtenTotal.toLocaleString()} written`);
  }

  console.log('\nTop geography tags:');
  const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  for (const [t, c] of sorted) {
    console.log(`  ${t.padEnd(28)} ${c.toLocaleString()}`);
  }
}

main().catch((err) => {
  console.error('[backfill-geography] failed:', err.message);
  process.exit(1);
});
