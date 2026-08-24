#!/usr/bin/env node
/**
 * Bulk CEPR Discussion Paper abstract backfill via EconPapers number-range crawl.
 *
 * CEPR DPs in the corpus are keyed by SSRN/journal DOI (no abstract in any free
 * API; SSRN page is Cloudflare-blocked). EconPapers hosts every CEPR DP at a
 * stable, CURL-FRIENDLY page `econpapers.repec.org/paper/cprceprdp/<N>.htm` whose
 * <meta name="citation_abstract"> carries the full abstract. There is no public
 * bulk index / working search, so we crawl the DP-NUMBER RANGE, extract each
 * page's citation_title/abstract/author, and match against our missing rows by
 * EXACT normalized title + author-token overlap (never write a wrong abstract).
 *
 * Number<->year is ~linear: DP18000≈2023, DP19000≈2024, DP19900≈2025, ~DP21600≈2026.
 *
 * Gap-only / golden rule: writes `abstract` only on rows where it is NULL, and
 * re-checks NULL immediately before each write. Read-only against EconPapers.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-abstracts-cepr-econpapers-crawl.mjs --from 18700 --to 21700
 *   node --env-file=.env scripts/backfill-abstracts-cepr-econpapers-crawl.mjs --from 8000 --to 18700   # older tail
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'fs';
config();

const args = process.argv.slice(2);
const numArg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? parseInt(args[i + 1]) : def; };
const FROM = numArg('--from', 18700);
const TO = numArg('--to', 21700);
const CONCURRENCY = numArg('--concurrency', 8);
const DRY_RUN = args.includes('--dry-run');
const FUZZY = args.includes('--fuzzy'); // author-gated prefix-containment title match (subtitle cases)
const UA = 'Mozilla/5.0 (HorizonScanner; horizon-scanner@iadb.org)';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const nameTokens = (arr) => { const s = new Set(); for (const x of (Array.isArray(arr) ? arr : [])) { const n = typeof x === 'string' ? x : (x?.name || x?.full_name || ''); for (const w of norm(n).split(' ')) if (w.length >= 3) s.add(w); } return s; };
const dec = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
const meta = (h, name) => (h.match(new RegExp(`<meta\\s+name=["']${name}["']\\s+content=["']([\\s\\S]*?)["']`, 'i')) || [])[1];

async function main() {
  console.log(`\n=== CEPR EconPapers crawl ${DRY_RUN ? '(DRY-RUN)' : ''} — DP ${FROM}..${TO} (concurrency ${CONCURRENCY}) ===`);
  // Load missing CEPR rows -> normalized-title index.
  const rows = [];
  let off = 0;
  while (true) {
    const { data, error } = await sb.from('works').select('id,title,authors')
      .eq('venue', 'CEPR Discussion Papers').is('abstract', null).is('canonical_work_id', null).not('is_noise', 'is', true)
      .order('id').range(off, off + 999);
    if (error) { console.error('DB error:', error.message); break; }
    if (!data?.length) break;
    rows.push(...data); if (data.length < 1000) break; off += 1000;
  }
  const byTitle = new Map();
  const missArr = []; // for fuzzy (prefix-containment) fallback, author-gated
  for (const r of rows) {
    const k = norm(r.title); if (!k) continue;
    const rec = { ...r, ntitle: k, ntoks: k.split(' ').filter(Boolean), atoks: nameTokens(r.authors) };
    byTitle.set(k, rec); missArr.push(rec);
  }
  console.log(`Missing CEPR rows: ${rows.length} (indexable titles: ${byTitle.size})${FUZZY ? ' [FUZZY on]' : ''}`);

  // Fuzzy match: their/our title where the shorter is a word-boundary PREFIX of the
  // longer (catches EconPapers' "<title>: <subtitle>"), shorter >=6 significant
  // words. Author-overlap is enforced separately by the caller, so this is safe.
  const fuzzyMatch = (theirNorm) => {
    if (!FUZZY) return null;
    for (const r of missArr) {
      const a = r.ntitle, b = theirNorm;
      if (a.length < 25 || b.length < 25) continue;
      const shorter = a.length <= b.length ? a : b, longer = a.length <= b.length ? b : a;
      const sw = shorter.split(' ').length;
      if (sw >= 6 && (longer === shorter || longer.startsWith(shorter + ' '))) return r;
    }
    return null;
  };

  const numbers = [];
  for (let n = TO; n >= FROM; n--) numbers.push(n); // descend: newest first (where most of our papers are)

  let fetched = 0, pages = 0, matched = 0, wrote = 0, authMismatch = 0;
  const filledIds = [];
  const start = Date.now();

  let idx = 0;
  async function worker() {
    while (idx < numbers.length) {
      const n = numbers[idx++];
      pages++;
      let html;
      try {
        const res = await fetch(`https://econpapers.repec.org/paper/cprceprdp/${n}.htm`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) continue;
        html = await res.text();
      } catch { continue; }
      fetched++;
      const t = meta(html, 'citation_title'); if (!t) continue;
      const hit = byTitle.get(norm(t)) || fuzzyMatch(norm(t));
      if (!hit) continue;
      matched++;
      const ab = meta(html, 'citation_abstract'); if (!ab || ab.length < 120) continue;
      const auths = [...html.matchAll(/<meta\s+name=["']citation_author["']\s+content=["']([^"']+)["']/gi)].map((m) => dec(m[1]));
      const theirs = nameTokens(auths);
      if (hit.atoks.size && theirs.size && ![...hit.atoks].some((x) => theirs.has(x))) { authMismatch++; continue; }
      const abstract = dec(ab).replace(/\s+/g, ' ').trim();
      if (DRY_RUN) { wrote++; filledIds.push(hit.id); console.log(`  [DP${n}] would fill: ${t.slice(0, 50)}`); continue; }
      // gap-only re-check
      const { data: live } = await sb.from('works').select('abstract').eq('id', hit.id).single();
      if (live && live.abstract) continue;
      const { error } = await sb.from('works').update({ abstract }).eq('id', hit.id);
      if (!error) { wrote++; filledIds.push(hit.id); console.log(`  [DP${n}] ✓ ${t.slice(0, 48)} (${abstract.length}ch)`); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const summary = { from: FROM, to: TO, pages, pagesExist: fetched, titleMatched: matched, authMismatch, filled: wrote, missingAtStart: rows.length, dryRun: DRY_RUN, elapsed_min: Math.round((Date.now() - start) / 60000) };
  console.log('\nDone:', JSON.stringify(summary, null, 2));
  fs.mkdirSync('reports', { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(`reports/backfill-abstracts-cepr-crawl-${date}-${FROM}-${TO}.json`, JSON.stringify({ summary, filledIds }, null, 2));
  if (!DRY_RUN && filledIds.length) {
    fs.writeFileSync(`reports/backfill-abstracts-cepr-crawl-${date}-${FROM}-${TO}-ids.json`, JSON.stringify({ ids: filledIds }, null, 2));
    console.log(`Filled ids → reports/backfill-abstracts-cepr-crawl-${date}-${FROM}-${TO}-ids.json (re-embed next)`);
  }
}
main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
