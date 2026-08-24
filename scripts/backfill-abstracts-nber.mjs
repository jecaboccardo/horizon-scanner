#!/usr/bin/env node
/**
 * Backfill abstracts for NBER working papers via EconPapers / RePEc.
 * Targets papers with id LIKE '10.3386/%' AND abstract IS NULL.
 *
 * Source: https://econpapers.repec.org/paper/nbrnberwo/{number}.htm
 *   The full abstract is served in the <meta name="citation_abstract"> tag.
 *   (NBER deposits NO abstract to Crossref/OpenAlex, so the free-API sweeps miss
 *   every 10.3386 paper; and the old api.nber.org/papers/{n}.json endpoint is now
 *   404. RePEc — the same source these rows were ingested from — has the abstract.)
 * DOI format: 10.3386/w29690 → series nbrnberwo, number = 29690.
 *
 * Gap-only / golden rule: only writes `abstract` on rows where it is NULL.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-abstracts-nber.mjs [--dry-run] [--limit N]
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'fs';
config();

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i+1]) : Infinity; })();
const CONCURRENCY = 8;
const SLEEP_MS = 120; // ~8 req/s

const sb = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractNberNumber(doi) {
  // Working papers only: 10.3386/w29690 → { letter:'w', digits:'29690' }.
  // EconPapers maps the 'w' series to nbrnberwo. Non-'w' (c=chapters, t=technical,
  // h=historical) live under different RePEc handles → skip (return null).
  const match = String(doi).match(/^10\.3386\/(w)(\d+)$/i);
  return match ? match[2] : null;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

async function fetchNberAbstract(number) {
  // number is the digits-only working-paper id (letter stripped by extractNberNumber).
  const url = `https://econpapers.repec.org/paper/nbrnberwo/${number}.htm`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (HorizonScanner; horizon-scanner@iadb.org)' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/<meta\s+name=["']citation_abstract["']\s+content=["']([\s\S]*?)["']\s*\/?>/i);
    if (!m) return null;
    const abstract = decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
    return abstract.length > 30 ? abstract : null;
  } catch {
    return null;
  }
}

async function main() {
  console.log(`\n=== NBER abstract backfill ===`);
  console.log(`Dry run: ${DRY_RUN} | Limit: ${LIMIT === Infinity ? 'none' : LIMIT} | Concurrency: ${CONCURRENCY}\n`);

  // Load all NBER papers missing abstracts
  const rows = [];
  let from = 0;
  while (rows.length < LIMIT) {
    const { data, error } = await sb.from('works')
      .select('id, title, year')
      .is('abstract', null)
      .is('canonical_work_id', null)
      .not('is_noise', 'is', true)
      .gte('id', '10.3386')
      .lt('id', '10.3387')
      .order('id')
      .range(from, from + 999);
    if (error || !data?.length) break;
    rows.push(...data.filter(r => extractNberNumber(r.id)));
    if (data.length < 1000) break;
    from += 1000;
  }

  const targets = rows.slice(0, LIMIT === Infinity ? rows.length : LIMIT);
  console.log(`Targets: ${targets.length} NBER papers missing abstracts`);
  if (DRY_RUN || targets.length === 0) return;

  let filled = 0, notFound = 0, errors = 0;
  const filledIds = []; // persisted so the downstream re-embed can target exactly these
  const start = Date.now();

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (paper) => {
      const num = extractNberNumber(paper.id);
      if (!num) { notFound++; return; }
      const abstract = await fetchNberAbstract(num);
      if (!abstract) { notFound++; return; }
      const { error } = await sb.from('works').update({ abstract }).eq('id', paper.id);
      if (error) errors++;
      else { filled++; filledIds.push(paper.id); }
    }));
    await sleep(SLEEP_MS);
    const elapsed = (Date.now() - start) / 60000;
    const rate = Math.round((i + batch.length) / Math.max(elapsed, 0.01));
    process.stdout.write(`\r  ${i + batch.length}/${targets.length} | filled ${filled} | not_found ${notFound} | err ${errors} | ${rate}/min`);
  }

  process.stdout.write('\n');
  const summary = { filled, notFound, errors, total: targets.length, elapsed_min: Math.round((Date.now()-start)/60000) };
  console.log('\nDone:', JSON.stringify(summary, null, 2));
  fs.mkdirSync('reports', { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(`reports/backfill-abstracts-nber-${date}.json`, JSON.stringify({ summary }, null, 2));
  // Sidecar ids → feed straight into backfill-reembed-with-abstract.mjs --ids-file
  fs.writeFileSync(`reports/backfill-abstracts-nber-${date}-ids.json`, JSON.stringify({ ids: filledIds }, null, 2));
  if (filledIds.length) console.log(`Filled ids → reports/backfill-abstracts-nber-${date}-ids.json (re-embed these next)`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
