#!/usr/bin/env node
/**
 * Backfill abstracts for CEPR Discussion Papers via OpenAlex "twin" matching.
 *
 * CEPR DPs in the corpus are keyed by their SSRN/published DOI (mostly
 * 10.2139/ssrn.*), and SSRN deposits NO abstract to Crossref/OpenAlex (and the
 * SSRN page is Cloudflare-blocked). But the SAME paper often has a published /
 * working-paper TWIN that OpenAlex DOES carry an abstract for. We find it by
 * EXACT normalized-title match + author-surname overlap (so we never grab a
 * different same-ish-title paper, e.g. "Distorted Beliefs and Asset Prices" vs
 * "Asset Pricing with Distorted Beliefs"), and only when a real abstract exists.
 *
 * Gap-only / golden rule: writes `abstract` only on CEPR rows where it is NULL.
 * Read-mostly; never upserts new rows.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-abstracts-cepr-twin.mjs [--dry-run] [--limit N]
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'fs';
config();

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1]) : Infinity; })();
const CONCURRENCY = 5;
const SLEEP_MS = 150;
const MAILTO = 'horizon-scanner@iadb.org';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
const invToText = (inv) => {
  if (!inv) return null;
  const out = []; for (const [w, ps] of Object.entries(inv)) for (const p of ps) out[p] = w;
  return out.filter(Boolean).join(' ');
};
const surnames = (authors) => {
  if (!Array.isArray(authors)) return new Set();
  return new Set(authors.map((a) => {
    const name = typeof a === 'string' ? a : (a?.name || a?.full_name || '');
    const parts = String(name).trim().split(/\s+/);
    return norm(parts[parts.length - 1] || '');
  }).filter(Boolean));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTwinAbstract(title, authors) {
  const nt = norm(title);
  if (!nt) return null;
  const url = `https://api.openalex.org/works?filter=title.search:${encodeURIComponent(title)}&per-page=10&mailto=${MAILTO}`;
  let j;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    j = await res.json();
  } catch { return null; }
  const ours = surnames(authors);
  const exact = (j.results || []).filter((w) => norm(w.title) === nt);
  for (const w of exact) {
    const ab = invToText(w.abstract_inverted_index);
    if (!ab || ab.length < 120) continue;
    // Author-overlap safety: if both sides have authors, require >=1 surname match.
    const theirs = surnames((w.authorships || []).map((a) => a.author?.display_name));
    if (ours.size && theirs.size) {
      const overlap = [...ours].some((s) => theirs.has(s));
      if (!overlap) continue;
    }
    return ab.replace(/\s+/g, ' ').trim();
  }
  return null;
}

async function main() {
  console.log(`\n=== CEPR abstract backfill (OpenAlex twin-match) ===`);
  console.log(`DryRun: ${DRY_RUN} | Limit: ${LIMIT === Infinity ? 'none' : LIMIT} | Concurrency: ${CONCURRENCY}\n`);

  const rows = [];
  let fromIdx = 0;
  while (rows.length < LIMIT) {
    const { data, error } = await sb.from('works')
      .select('id, title, authors')
      .eq('venue', 'CEPR Discussion Papers')
      .is('abstract', null).is('canonical_work_id', null).not('is_noise', 'is', true)
      .order('id').range(fromIdx, fromIdx + 999);
    if (error) { console.error('DB error:', error.message); break; }
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
    fromIdx += 1000;
  }
  const targets = rows.slice(0, LIMIT === Infinity ? rows.length : LIMIT);
  console.log(`Targets: ${targets.length} CEPR DPs missing abstracts`);
  if (targets.length === 0) return;

  let filled = 0, notFound = 0, errors = 0;
  const filledIds = [];
  const start = Date.now();

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (p) => {
      const abstract = await findTwinAbstract(p.title, p.authors);
      if (!abstract) { notFound++; return; }
      if (DRY_RUN) { filled++; filledIds.push(p.id); return; }
      const { error } = await sb.from('works').update({ abstract }).eq('id', p.id);
      if (error) errors++;
      else { filled++; filledIds.push(p.id); }
    }));
    await sleep(SLEEP_MS);
    const elapsed = (Date.now() - start) / 60000;
    const rate = Math.round((i + batch.length) / Math.max(elapsed, 0.01));
    process.stdout.write(`\r  ${i + batch.length}/${targets.length} | filled ${filled} | not_found ${notFound} | err ${errors} | ${rate}/min`);
  }
  process.stdout.write('\n');

  const summary = { filled, notFound, errors, total: targets.length, dryRun: DRY_RUN, elapsed_min: Math.round((Date.now() - start) / 60000) };
  console.log('\nDone:', JSON.stringify(summary, null, 2));
  fs.mkdirSync('reports', { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(`reports/backfill-abstracts-cepr-${date}.json`, JSON.stringify({ summary }, null, 2));
  if (!DRY_RUN && filledIds.length) {
    fs.writeFileSync(`reports/backfill-abstracts-cepr-${date}-ids.json`, JSON.stringify({ ids: filledIds }, null, 2));
    console.log(`Filled ids → reports/backfill-abstracts-cepr-${date}-ids.json (re-embed these next)`);
  }
}

main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
