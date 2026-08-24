#!/usr/bin/env node
/**
 * DIAGNOSTIC (read-only) — find "wrong geography tag" rows of the Keefer class:
 * papers whose stored geography[] is NON-EMPTY and does NOT include 'LAC', yet a
 * high-precision regex over title + abstract finds explicit Latin-America /
 * Caribbean signal. These are papers the region HARD filter silently excludes or
 * mislabels (e.g. Keefer 2020 tagged ["OECD","United States"] for a 7-LAC-city
 * study). `--mode geography` backfill can't fix them — it's gap-only (NULL/{}),
 * and these already have a (wrong) tag.
 *
 * Writes reports/geography-lac-mismatch.json with counts + samples + an ids file
 * (reports/geography-lac-mismatch-ids.json, [{id}]) for a targeted re-extraction.
 *
 * NEVER writes to works. Safe to run while prod is live.
 *
 * Usage:
 *   node --env-file=.env scripts/detect-geography-lac-mismatch.mjs
 *   node --env-file=.env scripts/detect-geography-lac-mismatch.mjs --limit 5000
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const args = process.argv.slice(2);
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : Infinity; })();

// High-precision LAC signal (word-boundary). Country names + region phrases.
// Applied to ACCENT-NORMALIZED text so "México"/"Perú"/"Brasil" match too.
const LAC = [
  ['Brazil', /\b(brazil|brasil|brazilian|brasilian)\b/i], ['Mexico', /\b(mexico|mexican)\b/i],
  ['Colombia', /\b(colombia|colombian)\b/i], ['Argentina', /\b(argentin[ae]|argentinian)\b/i],
  ['Chile', /\b(chile|chilean|chili)\b/i], ['Peru', /\b(peru|peruvian)\b/i],
  ['Ecuador', /\b(ecuador|ecuadorian|ecuadorean|equador)\b/i], ['Bolivia', /\b(bolivia|bolivian)\b/i],
  ['Uruguay', /\buruguay\b/i], ['Paraguay', /\bparaguay\b/i], ['Venezuela', /\b(venezuela|venezuelan)\b/i],
  ['Costa Rica', /\bcosta\s*rica\b/i], ['Panama', /\bpanama\b/i], ['Honduras', /\bhonduras\b/i],
  ['Guatemala', /\bguatemala\b/i], ['El Salvador', /\bel\s*salvador\b/i], ['Nicaragua', /\bnicaragua\b/i],
  ['Dominican Rep.', /\bdominican\s*republic|republica\s*dominicana\b/i], ['Haiti', /\bhaiti(an)?\b/i],
  ['Jamaica', /\bjamaica\b/i], ['Trinidad', /\btrinidad\b/i], ['Barbados', /\bbarbados\b/i],
  ['Guyana', /\bguyana\b/i], ['Suriname', /\bsuriname?\b/i], ['Belize', /\bbelize\b/i], ['Cuba', /\bcuba\b/i],
  ['Latin America', /\blatin\s*americ|america\s*latina|latinoameric/i], ['LAC', /\b(lac|cepal|eclac)\b/i],
  ['Caribbean', /\bcaribbean\b/i], ['Central America', /\bcentral\s*americ/i],
  ['South America', /\bsouth\s*americ/i], ['Andean', /\bandean|andes\b/i], ['Mercosur', /\bmercosur\b/i],
];

// Strip diacritics so accented tags/text ("México", "Perú") match the ASCII regex.
function norm(text) {
  return (text || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function lacHits(text) {
  if (!text || typeof text !== 'string') return [];
  const n = norm(text);
  const hits = [];
  for (const [label, re] of LAC) if (re.test(n)) hits.push(label);
  return [...new Set(hits)];
}

// ilike terms to pre-filter DB-side (broad; the regex above is the precise gate).
const ILIKE_TERMS = [
  'brazil', 'brasil', 'mexico', 'colombia', 'argentin', 'chile', 'peru',
  'ecuador', 'bolivia', 'uruguay', 'paraguay', 'venezuela', 'costa rica',
  'panama', 'honduras', 'guatemala', 'salvador', 'nicaragua', 'dominican',
  'haiti', 'jamaica', 'trinidad', 'barbados', 'guyana', 'suriname', 'belize',
  'latin america', 'caribbean', 'cepal', 'eclac',
];
const OR_ABSTRACT = ILIKE_TERMS.map((t) => `abstract.ilike.*${t}*`).join(',');
const OR_TITLE = ILIKE_TERMS.map((t) => `title.ilike.*${t}*`).join(',');

async function main() {
  const PAGE = 1000;
  let cursor = '';
  let scanned = 0;
  const mismatches = [];

  // Two passes (abstract-mention, then title-mention) unioned by id — PostgREST
  // can't OR across two column-groups cleanly in one .or(), so we run each.
  for (const orClause of [OR_ABSTRACT, OR_TITLE]) {
    cursor = '';
    for (;;) {
      let q = supabase
        .from('works')
        .select('id, title, abstract, geography, year, venue')
        .not('is_noise', 'is', true)
        .not('abstract', 'is', null)
        .not('geography', 'is', null)
        .neq('geography', '{}')
        .not('geography', 'cs', '{LAC}')
        .or(orClause)
        .order('id', { ascending: true })
        .limit(PAGE);
      if (cursor) q = q.gt('id', cursor);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      cursor = data[data.length - 1].id;
      for (const row of data) {
        scanned++;
        // GENUINE wrong tag = the stored geography carries NO LAC signal at all
        // (not even a free-form/accented LAC token), yet the paper's own text does.
        // This isolates the Keefer class from correctly-tagged LAC papers that
        // merely lack the literal 'LAC' rollup token (Brazil/Mexico/"Latin America").
        const geoHits = lacHits((row.geography || []).join(' | '));
        if (geoHits.length > 0) continue;
        const titleHits = lacHits(row.title || '');
        const hits = lacHits(`${row.title || ''}\n${row.abstract || ''}`);
        if (hits.length === 0) continue;
        // Confidence tier for the re-extraction candidate list:
        //  T1 (high): LAC signal in the TITLE → the paper is about LAC.
        //  T2 (med): an explicit REGION PHRASE ("Latin America"/"LAC"/"Caribbean"/…)
        //            in the text → regional study, not an incidental country name.
        //  T3 (low): only a lone country name in the abstract → often incidental
        //            (e.g. "Uruguay Round", a comparison aside). Needs LLM judgment.
        const PHRASES = new Set(['Latin America', 'LAC', 'Caribbean', 'Central America', 'South America', 'Andean', 'Mercosur']);
        const hasPhrase = hits.some((h) => PHRASES.has(h));
        const tier = titleHits.length > 0 ? 1 : (hasPhrase ? 2 : 3);
        mismatches.push({
          id: row.id, year: row.year, venue: row.venue, tier,
          geography: row.geography, lacHits: hits, titleHits, title: (row.title || '').slice(0, 120),
        });
      }
      if (scanned >= LIMIT) break;
    }
    if (scanned >= LIMIT) break;
  }

  // Dedup by id (a row can match both abstract- and title-ilike passes).
  const byId = new Map();
  for (const m of mismatches) if (!byId.has(m.id)) byId.set(m.id, m);
  const unique = [...byId.values()];

  // Distribution of the wrong tags currently stored (what they're mislabeled as).
  const tagCounts = {};
  for (const m of unique) for (const t of m.geography) tagCounts[t] = (tagCounts[t] || 0) + 1;

  const tierCounts = { 1: 0, 2: 0, 3: 0 };
  for (const m of unique) tierCounts[m.tier]++;

  const report = {
    generated_at: new Date().toISOString(),
    scanned_candidate_rows: scanned,
    mismatch_count: unique.length,
    tier_counts: tierCounts,
    tier_legend: {
      1: 'HIGH — LAC signal in title (paper is about LAC); safe to re-extract',
      2: 'MED — explicit region phrase in text (regional study)',
      3: 'LOW — lone country name in abstract; often incidental, needs LLM judgment',
    },
    stored_tag_distribution: Object.fromEntries(
      Object.entries(tagCounts).sort((a, b) => b[1] - a[1]),
    ),
    samples: unique.slice(0, 40),
  };
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync('reports/geography-lac-mismatch.json', JSON.stringify(report, null, 2));
  // Full list (all tiers) + a high-confidence T1+T2 subset for a first re-extraction pass.
  fs.writeFileSync(
    'reports/geography-lac-mismatch-ids.json',
    JSON.stringify(unique.map((m) => ({ id: m.id, tier: m.tier })), null, 2),
  );
  fs.writeFileSync(
    'reports/geography-lac-mismatch-ids-t1t2.json',
    JSON.stringify(unique.filter((m) => m.tier <= 2).map((m) => ({ id: m.id })), null, 2),
  );

  console.log(JSON.stringify({
    scanned_candidate_rows: scanned,
    mismatch_count: unique.length,
    tier_counts: tierCounts,
    top_stored_tags: Object.fromEntries(Object.entries(report.stored_tag_distribution).slice(0, 12)),
    t1_samples: unique.filter((m) => m.tier === 1).slice(0, 8).map((m) => ({ title: m.title, geo: m.geography })),
    t3_samples: unique.filter((m) => m.tier === 3).slice(0, 6).map((m) => ({ title: m.title, hits: m.lacHits })),
  }, null, 2));
  console.log('\nWritten: geography-lac-mismatch.json + -ids.json + -ids-t1t2.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
