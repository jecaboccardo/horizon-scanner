#!/usr/bin/env node
/**
 * Backfill SMS for IDB papers with missing sms_level.
 *
 * Strategy:
 *   1. Papers that already have an abstract → classify with Qwen directly.
 *   2. Papers missing an abstract → search for it via:
 *        a. IDB JSON:API (title / DOI match — proven reliable)
 *        b. Semantic Scholar title search
 *        c. OpenAlex title search
 *      Abstract is saved to DB if found.
 *   3. Papers where NO abstract could be found after all searches →
 *      logged for manual review. Nothing is auto-marked SMS=0.
 *
 * Usage:
 *   node scripts/backfill-idb-sms-from-pages.mjs --dry-run
 *   node scripts/backfill-idb-sms-from-pages.mjs
 *   node scripts/backfill-idb-sms-from-pages.mjs --skip-fetch   # only classify papers already having abstracts
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const LLM_BASE = (process.env.LLM_BASE_URL || 'https://llm.iotaimpact.com').replace(/\/+$/, '');
const LLM_KEY = process.env.LLM_API_KEY;
const QWEN_MODEL = process.env.LLM_MODEL || 'qwen2.5:14b-synthesis';

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_FETCH = process.argv.includes('--skip-fetch');
const IDB_JSONAPI = 'https://publications.iadb.org/en/jsonapi/node/publication';
const SS_API = 'https://api.semanticscholar.org/graph/v1/paper/search';
const OA_API = 'https://api.openalex.org/works';
const FETCH_CONCURRENCY = 4;
const QWEN_BATCH = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Load targets
// ---------------------------------------------------------------------------

async function loadTargets() {
  const rows = [];
  let from = 0;
  const PAGE = 500;
  while (true) {
    const { data, error } = await supabase
      .from('works')
      .select('id,title,abstract,url,open_access_pdf_url,canonical_doi,year,source')
      .or('source.eq.idb,source.eq.idb_publications,source_family.eq.IADB,venue.eq.IDB Publication')
      .is('sms_level', null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`load failed: ${error.message}`);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Abstract fetching — source A: IDB JSON:API
// ---------------------------------------------------------------------------

function normalizeTitle(title) {
  return String(title || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(raw) {
  if (!raw) return null;
  return String(raw)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

function normalizeDoi(raw) {
  if (!raw) return null;
  const value = typeof raw === 'object' ? raw.uri : raw;
  return String(value || '')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .trim().toLowerCase() || null;
}

async function fetchFromIdbApi(paper) {
  // Try DOI lookup first, then title search
  const searchParams = new URLSearchParams({
    'filter[field_doi]': paper.canonical_doi || '',
    'include': 'field_author',
    'fields[node--publication]': 'title,field_abstract,field_doi,field_date_issued_text',
    'page[limit]': '3',
  });

  let url = paper.canonical_doi
    ? `${IDB_JSONAPI}?filter[field_doi]=${encodeURIComponent(paper.canonical_doi)}&fields[node--publication]=title,field_abstract&page[limit]=3`
    : `${IDB_JSONAPI}?filter[title]=${encodeURIComponent(paper.title || '')}&fields[node--publication]=title,field_abstract&page[limit]=5`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/vnd.api+json' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;

    const body = await res.json();
    const items = Array.isArray(body?.data) ? body.data : [];
    const paperNorm = normalizeTitle(paper.title);

    for (const item of items) {
      const attrs = item?.attributes || {};
      const matchNorm = normalizeTitle(attrs.title);
      // Accept if DOI match or title similarity is close
      const doiMatch = paper.canonical_doi && normalizeDoi(attrs.field_doi) === paper.canonical_doi;
      const titleMatch = paperNorm && matchNorm && (
        matchNorm === paperNorm ||
        matchNorm.includes(paperNorm.slice(0, 30)) ||
        paperNorm.includes(matchNorm.slice(0, 30))
      );
      if (doiMatch || titleMatch) {
        const raw = attrs.field_abstract?.value ?? attrs.field_abstract;
        const abstract = cleanText(raw);
        if (abstract && abstract.length > 40) return abstract;
      }
    }
  } catch { /* timeout or network */ }
  return null;
}

// ---------------------------------------------------------------------------
// Abstract fetching — source B: Semantic Scholar
// ---------------------------------------------------------------------------

async function fetchFromSemanticScholar(paper) {
  try {
    const q = encodeURIComponent((paper.title || '').slice(0, 120));
    const url = `${SS_API}?query=${q}&fields=title,abstract&limit=3`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'HorizonScanner/1.0 (research tool)' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = await res.json();
    const paperNorm = normalizeTitle(paper.title);

    for (const item of (body?.data ?? [])) {
      if (!item?.abstract) continue;
      const matchNorm = normalizeTitle(item.title);
      if (
        matchNorm === paperNorm ||
        matchNorm.includes(paperNorm.slice(0, 30)) ||
        paperNorm.includes(matchNorm.slice(0, 30))
      ) {
        return item.abstract.trim();
      }
    }
  } catch { /* ignore */ }
  return null;
}

// ---------------------------------------------------------------------------
// Abstract fetching — source C: OpenAlex
// ---------------------------------------------------------------------------

async function fetchFromOpenAlex(paper) {
  try {
    const q = encodeURIComponent((paper.title || '').slice(0, 120));
    const url = `${OA_API}?search=${q}&select=title,abstract_inverted_index&per-page=3&mailto=horizon-scanner@iadb.org`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = await res.json();
    const paperNorm = normalizeTitle(paper.title);

    for (const item of (body?.results ?? [])) {
      const matchNorm = normalizeTitle(item.title);
      const titleClose =
        matchNorm === paperNorm ||
        matchNorm.includes(paperNorm.slice(0, 30)) ||
        paperNorm.includes(matchNorm.slice(0, 30));
      if (!titleClose) continue;

      // Reconstruct abstract from inverted index
      const inv = item?.abstract_inverted_index;
      if (inv && typeof inv === 'object') {
        const wordPositions = [];
        for (const [word, positions] of Object.entries(inv)) {
          for (const pos of positions) wordPositions.push({ word, pos });
        }
        wordPositions.sort((a, b) => a.pos - b.pos);
        const text = wordPositions.map((x) => x.word).join(' ').trim();
        if (text.length > 40) return text;
      }
    }
  } catch { /* ignore */ }
  return null;
}

// ---------------------------------------------------------------------------
// Fetch abstract for a single paper — tries all three sources in order
// ---------------------------------------------------------------------------

async function findAbstract(paper) {
  // 1. IDB JSON:API (most authoritative for IDB papers)
  let abstract = await fetchFromIdbApi(paper);
  if (abstract) return { abstract, source: 'idb_jsonapi' };

  await sleep(300);

  // 2. Semantic Scholar
  abstract = await fetchFromSemanticScholar(paper);
  if (abstract) return { abstract, source: 'semantic_scholar' };

  await sleep(300);

  // 3. OpenAlex
  abstract = await fetchFromOpenAlex(paper);
  if (abstract) return { abstract, source: 'openalex' };

  return null;
}

// ---------------------------------------------------------------------------
// Concurrent map helper
// ---------------------------------------------------------------------------

async function mapConcurrent(items, fn, limit) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Qwen SMS classification
// ---------------------------------------------------------------------------

const SMS_SYSTEM = `You are an expert research methodologist. Classify each paper's methodological rigor using the Scientific Methods Scale (SMS).

SMS levels:
0 = Non-empirical: literature reviews, theoretical frameworks, policy documents, strategy guides, institutional reports with no original data
1 = Descriptive/qualitative: surveys without controls, case studies, descriptive analysis, qualitative research
2 = Observational: primary empirical, cross-sectional regression with controls but no causal identification
3 = Quasi-experimental: panel data with fixed effects, interrupted time series
4 = Strong quasi-experimental: DiD, RDD, IV, synthetic control, propensity score matching with pre/post
5 = RCT: randomized controlled trial with random assignment

Return JSON only — no prose:
{"classifications":[{"id":"...","sms_level":N,"methodology_design":"RCT|DiD|IV|RDD|Panel|Observational|Qualitative|Descriptive|Review|Theoretical|Institutional|Other","rationale":"one sentence"}]}`;

async function classifyBatch(papers) {
  const payload = papers.map((p) => ({
    id: p.id,
    title: p.title || '',
    year: p.year || null,
    abstract: (p.abstract || '').slice(0, 800),
  }));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  let res;
  try {
    res = await fetch(`${LLM_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${LLM_KEY}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: QWEN_MODEL,
        temperature: 0,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SMS_SYSTEM },
          { role: 'user', content: `Classify these ${papers.length} papers:\n${JSON.stringify(payload)}` },
        ],
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Qwen ${res.status}: ${txt.slice(0, 200)}`);
  }

  const body = await res.json();
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error('Qwen returned no content');

  const parsed = JSON.parse(content);
  const list = parsed?.classifications ?? parsed?.results ?? (Array.isArray(parsed) ? parsed : null);
  if (!Array.isArray(list)) throw new Error(`Unexpected Qwen shape: ${JSON.stringify(parsed).slice(0, 200)}`);
  return list;
}

function causalStrength(level) {
  if (level >= 4) return 'high';
  if (level === 3) return 'moderate';
  if (level === 0) return 'signal';
  return 'limited';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n=== IDB SMS backfill — multi-source abstract search + Qwen classification ===');
  console.log(`Dry run:     ${DRY_RUN}`);
  console.log(`Skip fetch:  ${SKIP_FETCH}\n`);

  const targets = await loadTargets();
  console.log(`IDB papers missing SMS: ${targets.length}`);

  const withAbstract = targets.filter((p) => p.abstract && p.abstract.trim().length > 40);
  const noAbstract   = targets.filter((p) => !p.abstract || p.abstract.trim().length <= 40);
  console.log(`  already have abstract: ${withAbstract.length}`);
  console.log(`  need abstract search:  ${noAbstract.length}\n`);

  // ── Step 1: search for abstracts ──────────────────────────────────────────
  const fetchStats = { idb_jsonapi: 0, semantic_scholar: 0, openalex: 0, not_found: 0 };

  if (!SKIP_FETCH && noAbstract.length) {
    console.log('Searching for abstracts (IDB JSON:API → Semantic Scholar → OpenAlex)...');
    let done = 0;
    await mapConcurrent(noAbstract, async (paper) => {
      const found = await findAbstract(paper);
      if (found) {
        paper.abstract = found.abstract;
        fetchStats[found.source]++;
        if (!DRY_RUN) {
          await supabase.from('works').update({ abstract: found.abstract }).eq('id', paper.id);
        }
      } else {
        fetchStats.not_found++;
      }
      done++;
      if (done % 10 === 0 || done === noAbstract.length) {
        process.stdout.write(
          `\r  done ${done}/${noAbstract.length} | idb:${fetchStats.idb_jsonapi} ss:${fetchStats.semantic_scholar} oa:${fetchStats.openalex} missing:${fetchStats.not_found}  `
        );
      }
      await sleep(200);
    }, FETCH_CONCURRENCY);
    console.log('\n');
    console.log('Abstract search results:');
    console.log(`  Found via IDB JSON:API:      ${fetchStats.idb_jsonapi}`);
    console.log(`  Found via Semantic Scholar:  ${fetchStats.semantic_scholar}`);
    console.log(`  Found via OpenAlex:          ${fetchStats.openalex}`);
    console.log(`  Not found anywhere:          ${fetchStats.not_found}\n`);
  }

  // ── Step 2: classify everything that now has an abstract ──────────────────
  const toClassify   = targets.filter((p) => p.abstract && p.abstract.trim().length > 40);
  const stillMissing = targets.filter((p) => !p.abstract || p.abstract.trim().length <= 40);

  console.log(`Papers ready for Qwen classification: ${toClassify.length}`);
  console.log(`Papers with no abstract found:        ${stillMissing.length} (logged for manual review)\n`);

  let classified = 0;
  let errors = 0;

  const chunks = [];
  for (let i = 0; i < toClassify.length; i += QWEN_BATCH) chunks.push(toClassify.slice(i, i + QWEN_BATCH));

  for (const batch of chunks) {
    try {
      const results = await classifyBatch(batch);
      const byId = new Map(results.map((r) => [String(r.id), r]));

      for (const paper of batch) {
        const result = byId.get(String(paper.id));
        if (!result || result.sms_level == null) { errors++; continue; }

        const level = Math.max(0, Math.min(5, Math.round(Number(result.sms_level))));
        const row = {
          sms_level: level,
          methodology_design: result.methodology_design || 'Other',
          causal_strength: causalStrength(level),
          sms_method: 'qwen_llm_page_fetch',
          sms_rationale: String(result.rationale || '').slice(0, 200),
          updated_at: new Date().toISOString(),
        };

        if (DRY_RUN) {
          console.log(`  [SMS ${level} / ${row.methodology_design}] ${String(paper.title).slice(0, 70)}`);
          console.log(`    ${row.sms_rationale}`);
        } else {
          const { error } = await supabase.from('works').update(row).eq('id', paper.id);
          if (error) { console.error(`\n  update failed ${paper.id}: ${error.message}`); errors++; continue; }
        }
        classified++;
      }
    } catch (err) {
      console.error(`\n  Qwen batch error: ${err.message}`);
      errors += batch.length;
      await sleep(5000); // back off before retrying next batch
    }

    process.stdout.write(`\r  classified ${classified} | errors ${errors} | ${Math.min(classified + errors, toClassify.length)}/${toClassify.length}  `);
    await sleep(1200);
  }

  // ── Step 3: report papers still missing abstract ──────────────────────────
  if (stillMissing.length) {
    console.log(`\n\n${'─'.repeat(60)}`);
    console.log(`${stillMissing.length} papers had no abstract found in ANY source — manual review needed:`);
    console.log('─'.repeat(60));
    for (const p of stillMissing) {
      console.log(`  ${p.id}`);
      console.log(`  Title: ${String(p.title).slice(0, 90)}`);
      console.log(`  URL:   ${p.url || '(none)'}`);
      console.log('');
    }
  }

  console.log('\n=== Done ===');
  console.log(`Classified via Qwen: ${classified}`);
  console.log(`Classification errors: ${errors}`);
  console.log(`No abstract found (manual review): ${stillMissing.length}`);
}

main().catch((err) => {
  console.error('Fatal:', err?.message || err);
  process.exit(1);
});
