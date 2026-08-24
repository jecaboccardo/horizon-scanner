#!/usr/bin/env node
/**
 * scripts/import-corpus.mjs
 *
 * Phase 12: Bulk corpus import script (runs locally, no edge function timeout).
 *
 * Usage:
 *   node scripts/import-corpus.mjs                         # full import (~35K papers)
 *   node scripts/import-corpus.mjs --limit 100             # test with 100 papers
 *   node scripts/import-corpus.mjs --dry-run               # count papers without importing
 *   node scripts/import-corpus.mjs --source openalex       # OpenAlex only
 *   node scripts/import-corpus.mjs --source semantic_scholar  # SS only
 *   node scripts/import-corpus.mjs --source idb            # IDB Publications only
 *   node scripts/import-corpus.mjs --source idb --keep-index  # IDB import without disrupting live searches
 *   node scripts/import-corpus.mjs --backfill-embeddings   # re-embed existing rows where embedding IS NULL
 *
 * Requires .env with: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { classifyTopics } from './scl-topics.mjs';
import { isDeniedVenue, loadVenueDenylist } from './lib/venue-denylist.mjs';

config(); // Load .env

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}
if (!GEMINI_KEY) {
  console.warn('No GEMINI_API_KEY — using Ollama for embeddings (requires ollama running locally)');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const hasFlag = (name) => args.includes(`--${name}`);

const LIMIT = parseInt(getArg('limit') || '0', 10) || Infinity;
const DRY_RUN = hasFlag('dry-run');
const SOURCE = getArg('source') || 'both'; // 'openalex', 'semantic_scholar', 'both', 'idb'
const BACKFILL = hasFlag('backfill-embeddings');
const KEEP_INDEX = hasFlag('keep-index'); // skip drop/rebuild of pgvector index
const VENUE_DENYLIST = loadVenueDenylist();

// ---------------------------------------------------------------------------
// Tiered import strategy
// ---------------------------------------------------------------------------

const currentYear = new Date().getFullYear();

const TIERS = [
  { name: 'fresh',       yearStart: currentYear - 2,  yearEnd: currentYear,      minCitations: 1,  target: 12000 },
  { name: 'recent',      yearStart: currentYear - 5,  yearEnd: currentYear - 3,  minCitations: 10, target: 10000 },
  { name: 'established', yearStart: currentYear - 10,  yearEnd: currentYear - 6,  minCitations: 25, target: 8000 },
  { name: 'landmarks',   yearStart: 1990,              yearEnd: currentYear - 11, minCitations: 50, target: 5000 },
];

// ---------------------------------------------------------------------------
// Index management (drop/rebuild pgvector index to avoid timeout during import)
// ---------------------------------------------------------------------------

async function dropEmbeddingIndex() {
  console.log('Attempting to drop pgvector index for faster import...');
  try {
    // Try RPC function (may not exist yet)
    const { error } = await supabase.rpc('drop_embedding_index');
    if (error) {
      if (error.message.includes('does not exist')) {
        console.log('RPC function not available yet — index will be rebuilt slower\n');
      } else {
        console.warn(`Could not drop index: ${error.message}`);
      }
    } else {
      console.log('Index dropped successfully\n');
    }
  } catch (err) {
    // Silently fail if RPC not available — this is optional optimization
  }
}

async function rebuildEmbeddingIndex() {
  console.log('\nOptionally rebuilding pgvector index...');
  try {
    // Try RPC function (may not exist yet)
    const { error } = await supabase.rpc('rebuild_embedding_index');
    if (error) {
      if (!error.message.includes('does not exist')) {
        console.warn(`Index rebuild issue: ${error.message}`);
      }
    } else {
      console.log('Index rebuilt successfully');
    }
  } catch (err) {
    // Silently fail if RPC not available
  }
}

// ---------------------------------------------------------------------------
// Embedding via LiteLLM proxy (vLLM-served nomic-embed-text-vllm).
//
// Migrated 2026-05-08: was hitting `localhost:11434` Ollama directly. The
// 10.10.10.130 Ollama backend behind LiteLLM is being decommissioned, and
// localhost-Ollama in any CT is on the same path. vLLM is also faster than
// Ollama for embeddings, so this also fixes ingest latency.
//
// Tradeoff acknowledged: existing 256k corpus rows were embedded with Ollama
// `nomic-embed-text`. New rows from this script land in vLLM space (avg
// cos 0.994 vs Ollama for the same text — see scripts/verify-embedding-compat.mjs).
// Drift is small enough that mixed-space cosine retrieval still works, but a
// full corpus re-embed via vLLM is the right end-state to unify the space.
// ---------------------------------------------------------------------------

const LLM_BASE_URL = process.env.LLM_BASE_URL ?? 'https://llm.iotaimpact.com';
const LLM_API_KEY = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
const EMBED_MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:8b';
const EMBED_URL = `${LLM_BASE_URL.replace(/\/+$/, '')}/v1/embeddings`;

if (!LLM_API_KEY) {
  console.error('FATAL: LLM_API_KEY (or OPENAI_API_KEY) not set. Cannot embed.');
  process.exit(1);
}

async function embedSingle(text) {
  for (let attempt = 1; attempt <= 1; attempt++) {
    try {
      const response = await fetch(EMBED_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${LLM_API_KEY}`,
        },
        body: JSON.stringify({ model: EMBED_MODEL, input: text.slice(0, 2000) }),
        signal: AbortSignal.timeout(600000), // 10 min per paper
      });
      if (!response.ok) {
        process.stderr.write(`H${response.status}`);
        await sleep(5000);
        continue;
      }
      const data = await response.json();
      const vec = data?.data?.[0]?.embedding;
      if (Array.isArray(vec) && vec.length > 0) {
        return vec;
      } else {
        process.stderr.write('E');
        await sleep(2000);
      }
    } catch (err) {
      process.stderr.write('!');
      await sleep(5000);
    }
  }
  return null;
}

async function embedBatch(texts) {
  // Embed papers one at a time with long timeout instead of batch.
  // This handles Ollama's slowness (30-60+ sec per paper) without timing out.
  const results = [];
  for (const text of texts) {
    const emb = await embedSingle(text);
    results.push(emb);
  }
  return results;
}

// ---------------------------------------------------------------------------
// OpenAlex fetcher
// ---------------------------------------------------------------------------

const OA_URL = 'https://api.openalex.org/works';
const OA_EMAIL = process.env.OPENALEX_EMAIL || 'horizon-scanner@iadb.org';
// OpenAlex OR syntax: pipe-separate IDs within a single filter field
const OA_CONCEPTS = 'concepts.id:C162324750|C17744445|C144133560|C199539241|C41008148|C71924100|C15744967|C144024400|C149923435|C142362112|C187736073';
// Economics | Political science | Business | Law | Computer science |
// Medicine | Psychology | Sociology | Demography | Epidemiology | Gerontology

function reconstructAbstract(inverted) {
  if (!inverted || typeof inverted !== 'object') return null;
  const positions = [];
  for (const [word, posList] of Object.entries(inverted)) {
    if (!Array.isArray(posList)) continue;
    for (const p of posList) positions.push([p, word]);
  }
  if (!positions.length) return null;
  positions.sort((a, b) => a[0] - b[0]);
  return positions.map(([, w]) => w).join(' ');
}

function normDoi(raw) {
  if (!raw) return null;
  return String(raw).replace(/^https?:\/\/doi\.org\//i, '').toLowerCase().trim() || null;
}

async function fetchOpenAlexTier(tier, existingDois) {
  const papers = [];
  let cursor = '*';
  let page = 0;

  while (papers.length < tier.target) {
    const params = new URLSearchParams({
      mailto: OA_EMAIL,
      filter: [
        `from_publication_date:${tier.yearStart}-01-01`,
        `to_publication_date:${tier.yearEnd}-12-31`,
        'type:article', 'has_doi:true', 'has_abstract:true',
        `cited_by_count:>${tier.minCitations - 1}`,
        OA_CONCEPTS,
      ].join(','),
      sort: 'cited_by_count:desc',
      per_page: '200',
      cursor,
    });

    const url = `${OA_URL}?${params}`;
    process.stdout.write(`\r  [OA] ${tier.name} page ${++page}, have ${papers.length}/${tier.target}`);

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) { console.error(`\n  [OA] HTTP ${res.status}`); break; }
      const data = await res.json();
      const results = data.results || [];
      if (!results.length) break;

      for (const raw of results) {
        if (papers.length >= tier.target) break;
        const doi = normDoi(raw.doi);
        const id = doi || `oa:${raw.id?.match(/\/(W\d+)$/)?.[1]}`;
        if (!id || !raw.title) continue;
        if (doi && existingDois.has(doi)) continue;
        if (doi) existingDois.add(doi);

        const loc = raw.primary_location || {};
        const src = loc.source || {};
        const oa = raw.open_access || {};

        papers.push({
          id, title: raw.title, year: raw.publication_year,
          abstract: reconstructAbstract(raw.abstract_inverted_index),
          citationCount: raw.cited_by_count ?? null, doi,
          authors: (raw.authorships || []).map((a) => a?.author?.display_name).filter(Boolean),
          publicationDate: raw.publication_date,
          isOpenAccess: Boolean(oa.is_oa),
          openAccessPdfUrl: oa.oa_url || null,
          fieldsOfStudy: (raw.concepts || []).map((c) => c?.display_name).filter(Boolean),
          venue: src.display_name || null, journalIssn: src.issn_l || null,
          url: oa.oa_url || loc.landing_page_url || (doi ? `https://doi.org/${doi}` : null),
          source: 'openalex',
        });
      }

      cursor = data.meta?.next_cursor;
      if (!cursor) break;
      await sleep(200);
    } catch (err) {
      console.error(`\n  [OA] Error: ${err.message}`);
      break;
    }
  }

  console.log(`\n  [OA] ${tier.name}: ${papers.length} papers`);
  return papers;
}

// ---------------------------------------------------------------------------
// Semantic Scholar fetcher
// ---------------------------------------------------------------------------

const SS_URL = 'https://api.semanticscholar.org/graph/v1/paper/search';
const SS_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY;
const SS_FIELDS = 'paperId,title,abstract,year,citationCount,authors,publicationDate,isOpenAccess,openAccessPdf,externalIds,venue,journal';
const SS_QUERIES = [
  // Core development economics (existing)
  'development economics', 'conditional cash transfers',
  'impact evaluation developing countries', 'public policy economics',
  'social protection programs', 'labor market developing countries',
  'education economics', 'health economics developing countries',
  'fiscal policy Latin America', 'poverty reduction',
  'inequality economics', 'microfinance impact',
  'climate adaptation developing countries',
  'trade policy developing countries',

  // ECD
  'early childhood development Latin America',
  'parenting program low income',
  'home visiting intervention developing countries',
  'nurturing care developing countries',
  'child mental health developing countries',
  'early stimulation intervention',
  'early childhood education quality',

  // Health systems
  'hospital efficiency Latin America',
  'non-communicable diseases Latin America',
  'primary care quality low income countries',
  'digital health developing countries',
  'maternal health Latin America',
  'chronic disease management Latin America',
  'health system resilience developing countries',
  'universal health coverage Latin America',
  'telemedicine low income countries',

  // Aging & long-term care
  'long-term care Latin America',
  'pension system reform Latin America',
  'caregiving policy developing countries',
  'dementia care low income',
  'aging population Latin America',
  'informal caregiving developing countries',

  // Gender & GBV
  'gender-based violence Latin America',
  'intimate partner violence intervention',
  'GBV prevention developing countries',
  'gender norms division of labor',
  'domestic violence shelter effectiveness',
  'unpaid care work Latin America',
  'women economic empowerment Latin America',

  // Diversity & racial equity
  'Afro-descendants Latin America',
  'racial inequality Latin America',
  'racial discrimination employment',
  'intergenerational mobility race Latin America',
  'indigenous poverty Latin America',

  // Migration
  'migrant integration Latin America',
  'Venezuelan migration',
  'regularization migration Latin America',
  'social cohesion migration developing countries',
  'skills certification migrants',
  'return migration Central America',
  'refugee integration developing countries',

  // AI & digital transformation
  'artificial intelligence labor market developing countries',
  'automation employment Latin America',
  'digital transformation public services developing countries',
  'AI education developing countries',
  'future of work Latin America',
  'platform economy developing countries',

  // Adaptive social protection & climate
  'adaptive social protection climate',
  'climate shock social protection',
  'disaster social protection developing countries',

  // Education (expanded)
  'teacher effectiveness developing countries',
  'education technology RCT',
  'AI tutor developing countries',
  'school dropout Latin America',
  'teacher training quality',
  'higher education access Latin America',

  // Skills & labor (expanded)
  'vocational training effectiveness',
  'public employment services',
  'labor informality Latin America',
  'skills mismatch Latin America',
];

async function fetchSSTier(tier, existingDois) {
  const papers = [];
  const headers = { 'Content-Type': 'application/json' };
  if (SS_KEY) headers['x-api-key'] = SS_KEY;
  const limitPerQuery = Math.min(100, Math.ceil(tier.target / SS_QUERIES.length));

  for (const query of SS_QUERIES) {
    if (papers.length >= tier.target) break;

    const params = new URLSearchParams({
      query, fields: SS_FIELDS, limit: String(limitPerQuery),
      year: `${tier.yearStart}-${tier.yearEnd}`,
      minCitationCount: String(tier.minCitations),
    });

    try {
      const res = await fetch(`${SS_URL}?${params}`, { headers, signal: AbortSignal.timeout(15000) });
      if (res.status === 429) { console.warn('\n  [SS] Rate limited, pausing 5s'); await sleep(5000); continue; }
      if (!res.ok) { console.error(`\n  [SS] HTTP ${res.status}`); continue; }

      const data = await res.json();
      for (const raw of (data.data || [])) {
        if (papers.length >= tier.target) break;
        const doi = normDoi(raw.externalIds?.DOI);
        const id = doi || (raw.paperId ? `ss:${raw.paperId}` : null);
        if (!id || !raw.title) continue;
        if (doi && existingDois.has(doi)) continue;
        if (doi) existingDois.add(doi);

        papers.push({
          id, title: raw.title, year: raw.year,
          abstract: raw.abstract, citationCount: raw.citationCount ?? null, doi,
          authors: (raw.authors || []).map((a) => a?.name).filter(Boolean),
          publicationDate: raw.publicationDate, isOpenAccess: raw.isOpenAccess || false,
          openAccessPdfUrl: raw.openAccessPdf?.url || null,
          fieldsOfStudy: [], venue: raw.venue || raw.journal?.name || null,
          journalIssn: null,
          url: doi ? `https://doi.org/${doi}` : `https://www.semanticscholar.org/paper/${raw.paperId}`,
          source: 'semantic_scholar',
        });
      }

      await sleep(SS_KEY ? 200 : 1100);
    } catch (err) {
      console.error(`\n  [SS] Error for "${query}": ${err.message}`);
    }
  }

  console.log(`  [SS] ${tier.name}: ${papers.length} papers`);
  return papers;
}

// ---------------------------------------------------------------------------
// IDB Publications fetcher (JSON:API, free, no auth)
// ---------------------------------------------------------------------------

const IDB_JSONAPI_URL = 'https://publications.iadb.org/en/jsonapi/node/publication';

function cleanIdbText(raw) {
  if (!raw) return null;
  const stripped = String(raw).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ');
  return stripped.replace(/\s+/g, ' ').trim() || null;
}

function extractIdbAuthors(publication, includedMap) {
  const authorRels = publication.relationships?.field_author?.data;
  if (!Array.isArray(authorRels)) return [];
  const names = [];
  for (const rel of authorRels) {
    const inc = includedMap.get(`${rel.type}:${rel.id}`);
    const name = inc?.attributes?.title ?? inc?.attributes?.name;
    if (name) names.push(name.trim());
  }
  return names;
}

function extractIdbSubjects(publication, includedMap) {
  const subjectRels = publication.relationships?.field_subject?.data;
  if (!Array.isArray(subjectRels)) return [];
  const subjects = [];
  for (const rel of subjectRels) {
    const inc = includedMap.get(`${rel.type}:${rel.id}`);
    const name = inc?.attributes?.name ?? inc?.attributes?.title;
    if (name) subjects.push(name.trim());
  }
  return subjects;
}

/**
 * Fetch all IDB publications, paginating through the JSON:API.
 * No tier system — IDB publications are all institutional (Tier A equivalent).
 *
 * @param {Set<string>} existingDois
 * @param {Set<string>} existingIds
 * @param {number} limit
 * @returns {Promise<object[]>}
 */
async function fetchIdbPublications(existingDois, existingIds, limit = Infinity) {
  const papers = [];
  let offset = 0;
  const PAGE = 50; // JSON:API max per page
  let page = 0;
  let consecutiveErrors = 0;

  while (papers.length < limit) {
    const params = new URLSearchParams();
    params.set('sort', '-field_date_issued_text');
    params.set('page[limit]', String(PAGE));
    params.set('page[offset]', String(offset));
    params.set('include', 'field_author,field_subject');

    const url = `${IDB_JSONAPI_URL}?${params.toString()}`;
    process.stdout.write(`\r  [IDB] page ${++page}, offset ${offset}, have ${papers.length}`);

    try {
      const res = await fetch(url, {
        headers: { 'Accept': 'application/vnd.api+json' },
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        console.error(`\n  [IDB] HTTP ${res.status}`);
        consecutiveErrors++;
        if (consecutiveErrors >= 3) { console.error('  [IDB] Too many errors, stopping'); break; }
        await sleep(3000);
        continue;
      }

      consecutiveErrors = 0;
      const data = await res.json();
      const resources = data.data ?? [];

      if (resources.length === 0) {
        console.log(`\n  [IDB] No more results at offset ${offset}`);
        break;
      }

      // Build included entity map for this page
      const includedMap = new Map();
      if (Array.isArray(data.included)) {
        for (const inc of data.included) {
          includedMap.set(`${inc.type}:${inc.id}`, inc);
        }
      }

      for (const resource of resources) {
        if (papers.length >= limit) break;

        const attrs = resource.attributes;
        if (!attrs) continue;

        const title = cleanIdbText(attrs.title);
        if (!title) continue;

        // Extract DOI — can be string or {uri, title, options}
        const rawDoi = typeof attrs.field_doi === 'object' ? attrs.field_doi?.uri : attrs.field_doi;
        const doi = rawDoi ? rawDoi.replace(/^https?:\/\/doi\.org\//i, '').replace(/^https?:\/\/dx\.doi\.org\//i, '').trim().toLowerCase() || null : null;

        const nodeId = resource.id;
        const id = doi ?? `idb:${nodeId}`;

        // Skip if already in DB
        if (doi && existingDois.has(doi)) continue;
        if (existingIds.has(id)) continue;
        if (doi) existingDois.add(doi);

        const abstract = cleanIdbText(attrs.field_abstract?.value ?? attrs.field_abstract);
        const dateStr = attrs.field_date_issued_text;
        const year = dateStr ? parseInt(String(dateStr).slice(0, 4), 10) || null : null;
        const publicationDate = dateStr ? String(dateStr).slice(0, 10) : null;

        const pdfUrl = attrs.field_document_link_en?.uri
          ?? attrs.field_document_link_es?.uri
          ?? attrs.field_document_link_pt?.uri
          ?? null;

        const handleId = attrs.field_handle_id;
        const pubUrl = handleId
          ? `https://publications.iadb.org/en/publication/${handleId}`
          : `https://publications.iadb.org/en/node/${nodeId}`;

        papers.push({
          id,
          title,
          year,
          abstract,
          citationCount: null,
          doi,
          authors: extractIdbAuthors(resource, includedMap),
          publicationDate,
          isOpenAccess: true,
          openAccessPdfUrl: pdfUrl,
          fieldsOfStudy: extractIdbSubjects(resource, includedMap),
          venue: 'IDB Publication',
          journalIssn: null,
          url: pubUrl,
          source: 'idb_publications',
        });
      }

      offset += resources.length;

      // Check if there's a next page
      if (!data.links?.next) {
        console.log(`\n  [IDB] Reached last page`);
        break;
      }

      // Be polite — small delay between pages
      await sleep(500);
    } catch (err) {
      console.error(`\n  [IDB] Error: ${err.message}`);
      consecutiveErrors++;
      if (consecutiveErrors >= 3) { console.error('  [IDB] Too many errors, stopping'); break; }
      await sleep(3000);
    }
  }

  console.log(`\n  [IDB] Total: ${papers.length} publications fetched`);
  return papers;
}

// ---------------------------------------------------------------------------
// SMS classifier (simplified keyword-based — matches smsClassifier.ts)
// ---------------------------------------------------------------------------

const SMS_PATTERNS = [
  { design: 'RCT', level: 5, re: /\b(randomized|randomised|rct|random assignment|random allocation)\b/i },
  { design: 'DiD', level: 4, re: /\b(difference.in.difference|did|diff.in.diff|double difference)\b/i },
  { design: 'IV', level: 4, re: /\b(instrumental variable|iv\b|two.stage least squares|2sls)\b/i },
  { design: 'RDD', level: 4, re: /\b(regression discontinuity|rdd|sharp discontinuity|fuzzy discontinuity)\b/i },
  { design: 'Observational', level: 2, re: /\b(observational|cross.sectional|panel data|fixed effects|regression analysis)\b/i },
  { design: 'Qualitative', level: 1, re: /\b(qualitative|case study|ethnograph|interview|focus group)\b/i },
];

function classifyPaper(paper) {
  const text = `${paper.title || ''} ${paper.abstract || ''}`;
  for (const p of SMS_PATTERNS) {
    if (p.re.test(text)) {
      return { smsLevel: p.level, design: p.design, causalStrength: p.level >= 4 ? 'high' : p.level >= 3 ? 'moderate' : 'limited', smsMethod: 'keyword_scan' };
    }
  }
  return { smsLevel: null, design: null, causalStrength: null, smsMethod: null };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function warmOllama() {
  console.log('Warming up Ollama (loading model into memory)...');
  try {
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, input: 'warmup' }),
      signal: AbortSignal.timeout(600000),  // 10 min — Ollama can be slow
    });
    const raw = await res.text();
    const data = JSON.parse(raw);
    if (data.embeddings?.[0]?.length) {
      console.log(`Ollama ready (${data.embeddings[0].length} dims)\n`);
    } else {
      console.error('Ollama warmup failed — check if model is pulled');
      process.exit(1);
    }
  } catch (err) {
    console.error(`Ollama not responding: ${err.message}`);
    console.error('Make sure Ollama is running: ollama serve');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Backfill mode: re-embed existing works where embedding IS NULL
// ---------------------------------------------------------------------------

async function backfillEmbeddings() {
  console.log(`=== Backfill Embeddings ===`);
  console.log(`Limit: ${LIMIT === Infinity ? 'none' : LIMIT} | Dry run: ${DRY_RUN}\n`);

  const { count, error: countErr } = await supabase
    .from('works').select('*', { count: 'exact', head: true })
    .is('embedding', null);
  if (countErr) { console.error(`Count error: ${countErr.message}`); process.exit(1); }
  console.log(`Works missing embeddings: ${count}\n`);

  if (DRY_RUN || !count) { console.log('DRY RUN or nothing to do — exiting'); return; }

  const PAGE = 100;
  let processed = 0;
  let updated = 0;
  let errors = 0;
  const target = Math.min(count, LIMIT);

  while (processed < target) {
    // Always fetch from offset 0 — each iteration the "null embedding" set shrinks
    const { data: rows, error } = await supabase
      .from('works').select('id, title, abstract, source')
      .is('embedding', null)
      .limit(PAGE);
    if (error) { console.error(`\nFetch error: ${error.message}`); break; }
    if (!rows || rows.length === 0) break;

    const texts = rows.map((r) => `${r.title || ''} ${r.abstract || ''}`.slice(0, 2000));
    let embeddings;
    try { embeddings = await embedBatch(texts); }
    catch (err) { console.error(`\nEmbed error: ${err.message}`); errors += rows.length; await sleep(5000); continue; }

    // Update each row (Supabase has no bulk update by id — must loop or upsert by pk)
    const updates = [];
    for (let j = 0; j < rows.length; j++) {
      const emb = embeddings[j];
      if (!emb) { errors++; continue; }
      updates.push({ id: rows[j].id, embedding: `[${emb.join(',')}]`, source: rows[j].source, updated_at: new Date().toISOString() });
    }
    // Use .update().eq() instead of upsert — upsert falls back to INSERT when
    // the id doesn't conflict (e.g. type mismatch on the vector column), which
    // then fails the NOT NULL constraint on title. Plain UPDATE can never INSERT.
    for (const u of updates) {
      const { error: upErr } = await supabase.from('works')
        .update({ embedding: u.embedding, updated_at: u.updated_at })
        .eq('id', u.id);
      if (upErr) { console.error(`\nUpdate error ${u.id}: ${upErr.message}`); errors++; }
      else updated++;
    }

    processed += rows.length;
    process.stdout.write(`\r  Processed: ${processed}/${target}, updated: ${updated}, errors: ${errors}`);
  }
  console.log(`\n\n=== Backfill done: ${updated} embedded, ${errors} errors ===\n`);
}

// ---------------------------------------------------------------------------
// Shared: embed + upsert a batch of papers into the works table
// ---------------------------------------------------------------------------

async function embedAndUpsert(papers, existingIds, stats, denylistIds = new Set(), newWorkIds = null) {
  const BATCH = 10;
  const allowedPapers = papers.filter((paper) => {
    // Denylist check — permanently excluded papers (noised/deleted)
    if (denylistIds.has(paper.id)) { stats.skipped++; return false; }
    if (paper.doi && denylistIds.has(normDoi(paper.doi))) { stats.skipped++; return false; }
    if (!isDeniedVenue(paper.venue, VENUE_DENYLIST)) return true;
    stats.skipped++;
    return false;
  });

  for (let i = 0; i < allowedPapers.length; i += BATCH) {
    const batch = allowedPapers.slice(i, i + BATCH);

    // Embed
    const texts = batch.map((p) => `${p.title} ${p.abstract || ''}`.slice(0, 2000));
    let embeddings;
    try {
      embeddings = await embedBatch(texts);
    } catch (err) {
      console.error(`\n  Embedding error: ${err.message}`);
      stats.errors += batch.length;
      await sleep(5000);
      continue;
    }

    // Build rows
    const rows = [];
    for (let j = 0; j < batch.length; j++) {
      const emb = embeddings[j];
      if (!emb) { stats.errors++; continue; }

      const paper = batch[j];
      const sms = classifyPaper(paper);

      // Determine corpus_source label
      let corpusSource = 'api_retrieval';
      if (paper.source === 'idb_publications') corpusSource = 'idb_bulk';
      else if (paper.source === 'semantic_scholar') corpusSource = 'semantic_scholar_bulk';
      else corpusSource = 'openalex_bulk';

      rows.push({
        id: paper.id,
        title: paper.title,
        canonical_doi: paper.doi || null,
        year: paper.year || null,
        abstract: paper.abstract || null,
        citation_count: paper.citationCount ?? null,
        authors: paper.authors || [],
        publication_date: paper.publicationDate || null,
        is_open_access: paper.isOpenAccess || false,
        open_access_pdf_url: paper.openAccessPdfUrl || null,
        fields_of_study: paper.fieldsOfStudy || [],
        venue: paper.venue || null,
        journal_issn: paper.journalIssn || null,
        url: paper.url || null,
        source: paper.source || 'corpus',
        sms_level: sms.smsLevel,
        methodology_design: sms.design,
        causal_strength: sms.causalStrength,
        sms_method: sms.smsMethod,
        embedding: `[${emb.join(',')}]`,
        corpus_source: corpusSource,
        corpus_imported_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    if (rows.length > 0) {
      const { error } = await supabase.from('works').upsert(rows, { onConflict: 'id', ignoreDuplicates: false });
      if (error) {
        console.error(`\n  Upsert error: ${error.message}`);
        stats.errors += rows.length;
        await sleep(3000);
      } else {
        stats.imported += rows.length;
        for (const row of rows) {
          existingIds.add(row.id);
          if (newWorkIds) newWorkIds.push(row.id);
        }
      }
      await sleep(2000);
    }

    process.stdout.write(`\r  Processing: ${Math.min(i + BATCH, allowedPapers.length)}/${allowedPapers.length} (${stats.imported} imported)`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (BACKFILL) { await backfillEmbeddings(); return; }

  // Skip warmup for now — Ollama too slow on this machine
  // Papers will be imported with NULL embeddings, backfilled later
  if (!DRY_RUN && process.env.REQUIRE_OLLAMA) {
    await warmOllama();
  }

  console.log(`=== Corpus Import ===`);
  console.log(`Source: ${SOURCE} | Limit: ${LIMIT === Infinity ? 'none' : LIMIT} | Dry run: ${DRY_RUN}`);
  console.log(`Denylist: ${VENUE_DENYLIST.venues.length} venues (${VENUE_DENYLIST.path})`);
  if (SOURCE !== 'idb') {
    console.log(`Tiers: ${TIERS.map((t) => `${t.name}(${t.yearStart}-${t.yearEnd}, ${t.minCitations}+ cites, target ${t.target})`).join(', ')}`);
  }
  console.log();

  // Drop index before import to prevent statement timeouts
  // --keep-index skips this so live vector searches aren't disrupted
  if (!DRY_RUN && !KEEP_INDEX) {
    await dropEmbeddingIndex();
  }

  // Load corpus denylist — work IDs that must never be re-imported (noised/deleted papers).
  // Populated from is_noise=true papers. Prevents weekly ingest from re-adding them.
  const denylistIds = new Set();
  {
    let dlFrom = 0;
    while (true) {
      const { data, error } = await supabase
        .from('corpus_denylist').select('work_id')
        .range(dlFrom, dlFrom + 999);
      if (error) { console.error(`Denylist load error: ${error.message}`); break; }
      if (!data?.length) break;
      for (const r of data) denylistIds.add(r.work_id);
      if (data.length < 1000) break;
      dlFrom += 1000;
    }
  }
  console.log(`Corpus denylist: ${denylistIds.size} IDs (will be skipped on import)\n`);

  // Load existing DOIs (paginated — Supabase caps single selects at 1000)
  const existingDois = new Set();
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('works').select('canonical_doi')
      .not('canonical_doi', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) { console.error(`DOI preload error: ${error.message}`); break; }
    if (!data || data.length === 0) break;
    for (const r of data) {
      const d = normDoi(r.canonical_doi);
      if (d) existingDois.add(d);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`Existing DOIs in DB: ${existingDois.size}\n`);

  // Load existing work IDs from DB (to skip papers already imported)
  const existingIds = new Set();
  let fromId = 0;
  const PAGE_SIZE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('works').select('id')
      .range(fromId, fromId + PAGE_SIZE - 1);
    if (error) { console.error(`Work ID preload error: ${error.message}`); break; }
    if (!data || data.length === 0) break;
    for (const r of data) existingIds.add(r.id);
    if (data.length < PAGE_SIZE) break;
    fromId += PAGE_SIZE;
  }
  console.log(`Existing work IDs in DB: ${existingIds.size}\n`);

  const stats = { imported: 0, errors: 0, skipped: 0 };

  // -----------------------------------------------------------------------
  // IDB import path — no tiers, just fetch all publications
  // -----------------------------------------------------------------------
  if (SOURCE === 'idb') {
    console.log('--- IDB Publications (all years, no citation threshold) ---\n');

    const papers = await fetchIdbPublications(existingDois, existingIds, LIMIT);

    if (DRY_RUN) {
      console.log(`\n  DRY RUN: would import ${papers.length} IDB publications`);
    } else {
      console.log(`\n  Embedding and importing ${papers.length} IDB publications...\n`);
      const newWorkIds = [];
      await embedAndUpsert(papers, existingIds, stats, denylistIds, newWorkIds);
      await runIngestDedup(supabase, newWorkIds);
    }

    if (!DRY_RUN && !KEEP_INDEX) await rebuildEmbeddingIndex();
    console.log(`\n\n=== Done: ${stats.imported} imported, ${stats.skipped} skipped, ${stats.errors} errors ===\n`);
    return;
  }

  // -----------------------------------------------------------------------
  // Tiered OA/SS import path (existing behavior)
  // -----------------------------------------------------------------------
  for (const tier of TIERS) {
    if (stats.imported >= LIMIT) break;
    console.log(`\n--- Tier: ${tier.name} (${tier.yearStart}-${tier.yearEnd}, ${tier.minCitations}+ cites) ---`);

    let papers = [];
    const remaining = LIMIT - stats.imported;
    // Cap fetch target to remaining limit — don't fetch 12K if we only need 500
    const cappedTier = { ...tier, target: Math.min(tier.target, remaining) };

    if (SOURCE === 'openalex' || SOURCE === 'both') {
      papers.push(...await fetchOpenAlexTier(cappedTier, existingDois));
    }
    if (SOURCE === 'semantic_scholar' || SOURCE === 'both') {
      const ssRemaining = Math.max(0, remaining - papers.length);
      if (ssRemaining > 0) {
        papers.push(...await fetchSSTier({ ...tier, target: ssRemaining }, existingDois));
      }
    }

    if (papers.length > remaining) papers = papers.slice(0, remaining);

    if (DRY_RUN) {
      console.log(`  DRY RUN: would import ${papers.length} papers`);
      stats.imported += papers.length;
      continue;
    }

    // Filter out papers already in DB
    const deniedCount = papers.filter((p) => !existingIds.has(p.id) && isDeniedVenue(p.venue, VENUE_DENYLIST)).length;
    const toImport = papers.filter((p) => !existingIds.has(p.id) && !isDeniedVenue(p.venue, VENUE_DENYLIST));
    if (toImport.length < papers.length) {
      const skipped = papers.length - toImport.length;
      const existingCount = skipped - deniedCount;
      console.log(`  Skipping ${existingCount} already in DB, ${deniedCount} denied venues`);
      stats.skipped += skipped;
    }

    const newWorkIds = [];
    await embedAndUpsert(toImport, existingIds, stats, new Set(), newWorkIds);
    await runIngestDedup(supabase, newWorkIds);
    console.log(`\n  Tier ${tier.name}: done`);
  }

  // Rebuild index after import completes
  if (!DRY_RUN && !KEEP_INDEX) {
    await rebuildEmbeddingIndex();
  }

  console.log(`\n=== Done: ${stats.imported} imported, ${stats.skipped} skipped, ${stats.errors} errors ===\n`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Post-ingest deduplication
//
// Runs after every import batch. Finds new shadow/canonical pairs using the
// same normalized-title logic as migration 20260528000001_fuzzy_dedup.sql,
// then:
//   1. Marks shadows (canonical_work_id = canonical.id)
//   2. Inherits abstract / authors / geography / citation_count to canonical
//   3. Nulls embeddings on shadows so they leave the pgvector ANN index
//
// Publication-type preference (lower wins):
//   journal_article=1, discussion_paper=2, working_paper=3,
//   report=4, institutional=5, preprint=6, other=99
// ---------------------------------------------------------------------------

function pubTypeRank(pt) {
  const map = {
    journal_article: 1,
    discussion_paper: 2,
    working_paper: 3,
    report: 4,
    institutional: 5,
    preprint: 6,
  };
  return map[pt] ?? 99;
}

function normalizeTitle(t) {
  if (!t) return '';
  return t
    .toLowerCase()
    .replace(/\s*\((en|es|pt|fr)\)\s*$/i, '')   // strip language tag
    .replace(/[‐‑‒–—\-]/g, ' ')                 // all dash types → space
    .replace(/[^a-z0-9 ]/g, '')                  // strip punctuation
    .replace(/\s+/g, ' ')                         // collapse whitespace
    .trim();
}

function stripResearchInsightsPrefix(t) {
  return t.replace(/^research insights\s*:\s*/i, '');
}

async function runIngestDedup(supabase, newWorkIds) {
  if (!newWorkIds || newWorkIds.length === 0) return;

  console.log(`\n[dedup] Checking ${newWorkIds.length} newly imported papers for duplicates...`);

  // Fetch newly imported works
  const { data: newWorks, error: nErr } = await supabase
    .from('works')
    .select('id, title, publication_type, year, abstract, authors, geography, citation_count, canonical_work_id')
    .in('id', newWorkIds)
    .is('canonical_work_id', null);

  if (nErr || !newWorks?.length) return;

  // Build normalized title index for existing canonicals (fetch in batches)
  // We only need titles + types for matching — keep it lightweight
  const existingIndex = new Map(); // normalizedTitle → [{id, publication_type, year}]
  let from = 0;
  const PAGE = 2000;
  while (true) {
    const { data } = await supabase
      .from('works')
      .select('id, title, publication_type, year, abstract, authors, geography, citation_count')
      .is('canonical_work_id', null)
      .eq('is_noise', false)
      .not('id', 'in', `(${newWorkIds.slice(0, 400).join(',')})`)  // exclude newly imported
      .range(from, from + PAGE - 1);
    if (!data || data.length === 0) break;
    for (const w of data) {
      const nt = normalizeTitle(w.title);
      if (!nt || nt.length < 10) continue;
      if (!existingIndex.has(nt)) existingIndex.set(nt, []);
      existingIndex.get(nt).push(w);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const pairs = []; // [{shadowId, canonicalId, shadow, canonical}]

  for (const nw of newWorks) {
    let nt = normalizeTitle(nw.title);
    const isResearchInsights = /^research insights\s*:/i.test(nw.title);
    if (isResearchInsights) nt = normalizeTitle(stripResearchInsightsPrefix(nw.title));

    // Skip very short titles — too generic to match safely
    if (nt.length < 30) continue;

    const candidates = existingIndex.get(nt) || [];
    for (const existing of candidates) {
      if (Math.abs((nw.year || 0) - (existing.year || 0)) > (isResearchInsights ? 4 : 8)) continue;
      const newRank = pubTypeRank(nw.publication_type);
      const exRank  = pubTypeRank(existing.publication_type);
      if (newRank === exRank) continue;

      // Author guard: if both have non-empty authors, first author's last name must match
      const nwAuthors = Array.isArray(nw.authors) ? nw.authors : (nw.authors ? JSON.parse(nw.authors) : []);
      const exAuthors = Array.isArray(existing.authors) ? existing.authors : (existing.authors ? JSON.parse(existing.authors) : []);
      if (nwAuthors.length > 0 && exAuthors.length > 0) {
        const lastName = (s) => s.split(' ').pop().toLowerCase().replace(/[^a-z]/g, '');
        if (lastName(String(nwAuthors[0])) !== lastName(String(exAuthors[0]))) continue;
      }

      if (newRank > exRank) {
        pairs.push({ shadowId: nw.id, canonicalId: existing.id, shadow: nw, canonical: existing });
      } else {
        pairs.push({ shadowId: existing.id, canonicalId: nw.id, shadow: existing, canonical: nw });
      }
      break;
    }
  }

  if (pairs.length === 0) {
    console.log('[dedup] No duplicates found.');
    return;
  }

  console.log(`[dedup] Found ${pairs.length} duplicate pair(s) — applying...`);

  for (const { shadowId, canonicalId, shadow, canonical } of pairs) {
    // Inherit metadata to canonical if missing
    const updates = {};
    if (!canonical.abstract && shadow.abstract) updates.abstract = shadow.abstract;
    const canonicalAuthors = Array.isArray(canonical.authors) ? canonical.authors : (canonical.authors ? JSON.parse(canonical.authors) : []);
    const shadowAuthors = Array.isArray(shadow.authors) ? shadow.authors : (shadow.authors ? JSON.parse(shadow.authors) : []);
    if (canonicalAuthors.length === 0 && shadowAuthors.length > 0) updates.authors = shadow.authors;
    if ((!canonical.geography || canonical.geography.length === 0) && shadow.geography?.length) updates.geography = shadow.geography;
    if ((shadow.citation_count || 0) > (canonical.citation_count || 0)) updates.citation_count = shadow.citation_count;

    if (Object.keys(updates).length > 0) {
      await supabase.from('works').update(updates).eq('id', canonicalId);
    }

    // Mark shadow + null its embedding
    await supabase.from('works')
      .update({ canonical_work_id: canonicalId, embedding: null })
      .eq('id', shadowId);

    console.log(`[dedup]  shadow: ${shadowId} (${shadow.publication_type}) → canonical: ${canonicalId} (${canonical.publication_type})`);
  }

  console.log('[dedup] Done.\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
