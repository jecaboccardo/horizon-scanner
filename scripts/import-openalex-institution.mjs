#!/usr/bin/env node
/**
 * Ingest an organisation's working papers via the OpenAlex INSTITUTION filter.
 *
 * For orgs that (a) have NO clean repository API (CGD, J-PAL, IPA are all behind
 * Cloudflare) and (b) have NO dedicated OpenAlex source/series — the best
 * available path is OpenAlex's institution filter, narrowed to working-paper-ish
 * types (report|preprint). These orgs are small and OpenAlex indexes them
 * decently WITH abstracts, so this recovers the gray-lit the corpus was missing
 * (e.g. the Evans & Mendez Acosta returns-to-schooling meta-analysis).
 *
 * Tradeoff vs the repository-native crawlers (IDB Drupal / WB WDS): institution
 * coverage depends on OpenAlex, so it is not exhaustive — but for these orgs no
 * better source exists.
 *
 *   id            = normalized DOI if present, else openalex:<Wid>
 *   publication_type  preprint→working_paper, report→report, article→journal_article
 *   source / corpus_source = openalex / <tag>_openalex
 *   embedding     = null → run backfill-fast.mjs afterwards
 *
 * GOLDEN RULE: upsert { onConflict:'id', ignoreDuplicates:true } — never
 * overwrites existing rows; dedup also skips existing ids/dois/normalized-titles.
 *
 * Usage:
 *   node scripts/import-openalex-institution.mjs --institution I1319597252 \
 *        --venue "CGD Working Paper" --tag cgd --types report,preprint [--dry-run]
 *   # presets:
 *   node scripts/import-openalex-institution.mjs --preset cgd
 *   node scripts/import-openalex-institution.mjs --preset jpal
 *   node scripts/import-openalex-institution.mjs --preset ipa
 */
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
config();
const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const MAILTO = 'horizon-scanner@iadb.org';
const PRESETS = {
  cgd:  { institution: 'I1319597252', venue: 'CGD Working Paper',  tag: 'cgd',  types: 'report,preprint' },
  jpal: { institution: 'I4210113636', venue: 'J-PAL Working Paper', tag: 'jpal', types: 'report,preprint' },
  ipa:  { institution: 'I1313272365', venue: 'IPA Working Paper',  tag: 'ipa',  types: 'report,preprint' },
};

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DRY_RUN = args.includes('--dry-run');
const PRESET = flag('--preset', null);
const base = PRESET ? PRESETS[PRESET] : {};
if (PRESET && !base) { console.error(`unknown preset ${PRESET}`); process.exit(1); }
const INSTITUTION = flag('--institution', base.institution);
const VENUE = flag('--venue', base.venue || 'Working Paper');
const TAG = flag('--tag', base.tag || 'org');
const TYPES = (flag('--types', base.types || 'report,preprint')).split(',').map(s => s.trim()).filter(Boolean);
const MAX = parseInt(flag('--max', '0'), 10) || Infinity;
if (!INSTITUTION) { console.error('need --institution or --preset'); process.exit(1); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function normalizeDoi(raw) {
  if (!raw) return null;
  return String(raw).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim().toLowerCase() || null;
}
function normTitleKey(t) {
  if (!t) return '';
  return String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function reconstructAbstract(inv) {
  if (!inv || typeof inv !== 'object') return null;
  const words = [];
  for (const [w, ps] of Object.entries(inv)) for (const p of ps) words[p] = w;
  const txt = words.join(' ').replace(/\s+/g, ' ').trim();
  return txt || null;
}
function mapType(t) {
  if (t === 'preprint') return 'working_paper';
  if (t === 'report') return 'report';
  if (t === 'article' || t === 'review') return 'journal_article';
  if (t === 'book') return 'book';
  if (t === 'book-chapter') return 'book_chapter';
  return 'working_paper';
}

function mapWork(w) {
  const title = w.title ? String(w.title).replace(/\s+/g, ' ').trim() : null;
  if (!title) return null;
  const wid = String(w.id || '').replace('https://openalex.org/', '');
  const doi = normalizeDoi(w.doi);
  const id = doi ?? (wid ? `openalex:${wid}` : null);
  if (!id) return null;
  const authors = (w.authorships || []).map(a => a?.author?.display_name).filter(Boolean);
  const year = w.publication_year ?? null;
  const src = w.primary_location?.source?.display_name || null;
  return {
    id,
    title,
    canonical_doi: doi,
    year,
    abstract: reconstructAbstract(w.abstract_inverted_index),
    citation_count: typeof w.cited_by_count === 'number' ? w.cited_by_count : null,
    authors,
    publication_date: w.publication_date || (year ? `${year}-01-01` : null),
    is_open_access: !!w.open_access?.is_oa,
    open_access_pdf_url: w.primary_location?.pdf_url || w.best_oa_location?.pdf_url || null,
    fields_of_study: (w.concepts || []).slice(0, 12).map(c => c.display_name).filter(Boolean),
    venue: VENUE,
    publication_type: mapType(w.type),
    journal_issn: null,
    url: w.id || null,
    source: 'openalex',
    corpus_source: `${TAG}_openalex`,
    embedding: null,
    corpus_imported_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    raw_data: {
      openalex_id: wid,
      openalex_type: w.type,
      host_source: src,
    },
  };
}

async function fetchPage(cursor) {
  const params = new URLSearchParams({
    filter: `authorships.institutions.id:${INSTITUTION},type:${TYPES.join('|')}`,
    per_page: '200',
    cursor,
    mailto: MAILTO,
    select: 'id,doi,title,publication_year,publication_date,authorships,abstract_inverted_index,cited_by_count,primary_location,best_oa_location,open_access,concepts,type',
  });
  const res = await fetch(`https://api.openalex.org/works?${params}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return { records: (j.results || []).map(mapWork).filter(Boolean), next: j.meta?.next_cursor ?? null, total: j.meta?.count ?? 0 };
}

async function loadExisting() {
  const ids = new Set(), titles = new Set();
  const PAGE = 1000, CONC = 12;
  const { count } = await supabase.from('works').select('*', { count: 'exact', head: true });
  const total = count ?? 600000, nPages = Math.ceil(total / PAGE);
  process.stdout.write(`Loading existing (${total} rows, ${CONC}-way) for dedup`);
  async function page(p) {
    const { data } = await supabase.from('works').select('id,title').order('id', { ascending: true }).range(p * PAGE, p * PAGE + PAGE - 1);
    for (const r of data || []) { if (r.id) ids.add(r.id); const tk = normTitleKey(r.title); if (tk.length >= 20) titles.add(tk); }
  }
  for (let b = 0; b < nPages; b += CONC) { const batch = []; for (let k = 0; k < CONC && b + k < nPages; k++) batch.push(page(b + k)); await Promise.all(batch); process.stdout.write('.'); }
  process.stdout.write('\n');
  return { ids, titles };
}

async function upsertBatch(rows) {
  const { error } = await supabase.from('works').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
  if (error) throw new Error(error.message);
}

async function main() {
  console.log(`\n=== OpenAlex institution ingest: ${TAG} (${INSTITUTION}) types=${TYPES.join('|')} venue="${VENUE}" dry=${DRY_RUN} ===\n`);
  const { ids: existingIds, titles: existingTitles } = DRY_RUN ? { ids: new Set(), titles: new Set() } : await loadExisting();
  if (!DRY_RUN) console.log(`  existing: ${existingIds.size} ids, ${existingTitles.size} titles\n`);

  let cursor = '*', seen = 0, neu = 0, upserted = 0, dupId = 0, dupTitle = 0, withAbs = 0, errors = 0, total = null;
  const buffer = [];
  while (cursor && seen < MAX) {
    let page;
    try { page = await fetchPage(cursor); }
    catch (e) { console.error(`\n  fetch error: ${e.message} — retry`); await sleep(2000); try { page = await fetchPage(cursor); } catch (e2) { console.error(`  failed: ${e2.message}`); errors++; break; } }
    if (total == null) { total = page.total; console.log(`  OpenAlex reports ${total} ${TYPES.join('|')} works for this institution\n`); }
    if (!page.records.length) break;
    seen += page.records.length;
    for (const row of page.records) {
      if (DRY_RUN) { neu++; if (row.abstract) withAbs++; continue; }
      if (existingIds.has(row.id)) { dupId++; continue; }
      const tk = normTitleKey(row.title);
      if (tk.length >= 20 && existingTitles.has(tk)) { dupTitle++; continue; }
      buffer.push(row); existingIds.add(row.id); if (tk.length >= 20) existingTitles.add(tk);
      neu++; if (row.abstract) withAbs++;
    }
    if (!DRY_RUN && buffer.length >= 100) { try { await upsertBatch(buffer.splice(0, buffer.length)); upserted = neu - buffer.length; } catch (e) { console.error(`\n  upsert: ${e.message}`); errors++; } }
    process.stdout.write(`\r  seen=${seen} new=${neu} withAbs=${withAbs} dupId=${dupId} dupTitle=${dupTitle}   `);
    cursor = page.next;
    await sleep(200);
  }
  if (!DRY_RUN && buffer.length) { try { await upsertBatch(buffer); upserted = neu; } catch (e) { console.error(`\n  final upsert: ${e.message}`); errors++; } }
  console.log(`\n\nDone ${TAG}. seen=${seen} new=${neu} upserted=${DRY_RUN ? '(dry)' : upserted} withAbstract=${withAbs} dupId=${dupId} dupTitle=${dupTitle} errors=${errors}`);
  if (!DRY_RUN && neu > 0) console.log('Next: backfill-fast.mjs to embed (embedding is null).');
}
main().catch(e => { console.error(e); process.exit(1); });
