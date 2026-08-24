/**
 * canonical-position-probe.mjs
 *
 * Purpose: distinguish two retrieval failure modes for q05/q06/q10/q11:
 *   1) Canonical papers are in the candidate pool but ranked too low
 *      → reranking problem (citation, recency, signal weighting)
 *   2) Canonical papers are NOT in the candidate pool at all
 *      → retrieval/synonym/embedding/pre-filter problem
 *
 * For each canonical paper from
 * reports/key-paper-corpus-vs-retrieval-2026-05-12.csv, fetch the production
 * retrieval ranking and the underlying signals (similarity, FTS, citations,
 * venue, SMS, age). Then simulate citation-aware reranking under 4 variants
 * × 3 α values and report top-20 movement.
 *
 * Two configs:
 *   no_filter     — match_works_v2 with no year/sms floor (ceiling reference;
 *                   the pre-2010 canonicals need this to even be candidates)
 *   current_prod  — match_works_v2 with filter_min_year=2010, filter_sms_min=2
 *                   (live today; expected to drop most pre-2010 papers entirely)
 *
 * Citation reranking variants (applied to the no_filter result so we don't
 * double-penalize pre-2010 papers we're trying to recover):
 *
 *   A. No boost (baseline) — same order as match_works_v2 returned
 *   B. Raw citation       — score = base × (1 + α × log(1+citations))
 *   C. Age-normalized     — citation_rate = citations / max(1, currentYear-year+1)
 *                           score = base × (1 + α × log(1+rate))
 *   D. Hybrid capped      — score = base × min(boost, 1 + cap)
 *                           where boost = 1 + α × log(1 + max(norm_total, norm_rate))
 *                           and cap = 0.50 (boost can't exceed +50% of base)
 *
 * α tested: 0.10, 0.20, 0.30. Relevance gate: citation boost is ONLY applied
 * to papers in the top-100 of the base ordering (positions 101+ get the
 * untouched base score). This implements "citation breaks ties among
 * relevant papers, not defines relevance" from the design brief.
 *
 * Base relevance score (positional, DCG-style discount):
 *   base = 1.0 / log2(rank + 1)   so rank 1 = 1.0, rank 2 = 0.63, rank 20 = 0.23
 *
 * Outputs:
 *   reports/canonical-position-probe-YYYY-MM-DD.json — machine-readable
 *   reports/canonical-position-probe-YYYY-MM-DD.md   — human-readable analysis
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LLM_BASE_URL,
 * LLM_API_KEY, OLLAMA_EMBEDDING_MODEL (defaults to nomic-embed-text-vllm).
 *
 * Usage:
 *   node scripts/canonical-position-probe.mjs
 *   node scripts/canonical-position-probe.mjs --queries q05,q06
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __dir = dirname(fileURLToPath(import.meta.url));
const QUERIES_PATH = join(__dir, '../evals/queries.json');
const AUDIT_PATH = join(__dir, '../reports/key-paper-corpus-vs-retrieval-2026-05-12.csv');

const SB = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const LLM_BASE = process.env.LLM_BASE_URL ?? 'https://llm.iotaimpact.com';
const LLM_KEY  = process.env.LLM_API_KEY;
const EMBED_MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:8b';

const MATCH_COUNT  = 500;       // ample headroom — match_works_v2 returns top-N by RRF
const NO_FILTER_THRESHOLD = 0.0;
const PROD_THRESHOLD = 0.40;

const DEFAULT_QUERIES = ['q05', 'q06', 'q10', 'q11'];
const ALPHAS = [0.10, 0.20, 0.30];
const RELEVANCE_GATE_TOP_N = 100;   // citation boost only applies within top-N base rank
const HARD_CAP = 0.50;              // hybrid variant D: boost capped at +50% of base
const CURRENT_YEAR = new Date().getUTCFullYear();

// ── Synonym expansion (mirrors supabase/functions/_shared/synonymExpander.ts) ─
// Kept in sync with the production expander so this probe reflects what prod
// actually sends to match_works_v2's FTS branch.
const SYNONYM_MAP = [
  { pattern: /\bgender.{0,5}violence\b|\bgbv\b/i,
    expansions: ['domestic violence', 'intimate partner violence', 'IPV', 'violence against women', 'gender-based violence', 'femicide'] },
  { pattern: /\bintimate partner violence\b|\bipv\b/i,
    expansions: ['domestic violence', 'gender violence', 'gender-based violence'] },
  { pattern: /\bdomestic violence\b/i,
    expansions: ['intimate partner violence', 'IPV', 'gender violence', 'gender-based violence'] },
  { pattern: /\bgender wage gap\b|\bgender pay gap\b/i,
    expansions: ['gender earnings gap', 'gender income gap', 'female earnings', 'wage discrimination'] },
  { pattern: /\bartificial intelligence\b|\bai\b(?!\s*and\s*ml)/i,
    expansions: ['machine learning', 'automation', 'algorithmic', 'digitalization', 'technology adoption', 'robotics'] },
  { pattern: /\bautomation\b/i,
    expansions: ['artificial intelligence', 'robotics', 'technological displacement', 'job displacement', 'routine tasks'] },
  { pattern: /\bdigital economy\b|\bdigitalization\b|\bdigitisation\b/i,
    expansions: ['information technology', 'ICT', 'internet adoption', 'broadband', 'e-commerce'] },
  { pattern: /\blabor (outcomes?|market results?)\b|\blabour (outcomes?|market results?)\b/i,
    expansions: ['employment', 'wages', 'earnings', 'unemployment', 'job creation', 'workforce participation'] },
  { pattern: /\bjob displacement\b|\bemployment loss\b/i,
    expansions: ['unemployment', 'layoffs', 'retrenchment', 'labor market transition'] },
  { pattern: /\binformal (sector|employment|work)\b/i,
    expansions: ['informality', 'informal labor', 'self-employment', 'undeclared work'] },
  { pattern: /\bcash transfers?\b/i,
    expansions: ['conditional cash transfer', 'CCT', 'social protection', 'safety net', 'welfare program', 'Bolsa Familia', 'Progresa', 'Oportunidades', 'SNAP'] },
  { pattern: /\bconditional cash transfers?\b|\bcct\b/i,
    expansions: ['cash transfers', 'social protection', 'safety net', 'Progresa', 'Oportunidades', 'Bolsa Familia'] },
  { pattern: /\bsocial protection\b|\bsafety net\b/i,
    expansions: ['cash transfers', 'social assistance', 'welfare programs', 'poverty reduction', 'social insurance'] },
  { pattern: /\beducation outcomes?\b|\blearning outcomes?\b/i,
    expansions: ['school enrollment', 'attendance', 'dropout', 'literacy', 'numeracy', 'test scores', 'academic achievement'] },
  { pattern: /\bschool dropout\b|\bdropout rates?\b/i,
    expansions: ['school attendance', 'school enrollment', 'grade repetition', 'educational attainment'] },
  { pattern: /\bteacher incentives?\b|\bteacher performance pay\b/i,
    expansions: ['teacher bonuses', 'teacher retention', 'teacher recruitment', 'merit pay', 'hard to staff schools'] },
  { pattern: /\bhealth outcomes?\b/i,
    expansions: ['mortality', 'morbidity', 'health status', 'child health', 'maternal health', 'nutrition', 'wellbeing'] },
  { pattern: /\bmental health\b/i,
    expansions: ['depression', 'anxiety', 'psychological wellbeing', 'psychiatric', 'mental illness'] },
  { pattern: /\bnutrition\b/i,
    expansions: ['stunting', 'wasting', 'malnutrition', 'food security', 'dietary', 'child development'] },
  { pattern: /\bmhealth\b|\bmobile health\b|\bdigital health\b/i,
    expansions: ['telemedicine', 'eHealth', 'health technology', 'SMS health', 'mobile applications health'] },
  { pattern: /\bfinancial inclusion\b/i,
    expansions: ['banking access', 'credit access', 'microfinance', 'mobile money', 'digital payments', 'unbanked'] },
  { pattern: /\bmicrofinance\b|\bmicrocredit\b/i,
    expansions: ['financial inclusion', 'small loans', 'credit access', 'women entrepreneurship'] },
  // PATCHED: original pattern was /\bmigration\b|\bmigrants?\b/ — does NOT match
  // the literal word "immigration", so queries about immigration get no expansion.
  { pattern: /\b(im|e)?migration\b|\b(im|e)?migrants?\b/i,
    expansions: ['emigration', 'immigration', 'remittances', 'displacement', 'refugees', 'internal migration', 'foreign-born', 'guest workers', 'Mariel'] },
  { pattern: /\bremittances?\b/i,
    expansions: ['money transfers', 'migration', 'diaspora', 'family transfers'] },
  { pattern: /\bclimate change\b/i,
    expansions: ['climate shocks', 'environmental shocks', 'extreme weather', 'temperature', 'rainfall', 'natural disasters', 'climate adaptation'] },
  { pattern: /\bnatural disasters?\b/i,
    expansions: ['floods', 'droughts', 'hurricanes', 'earthquakes', 'climate shocks', 'disaster risk'] },
  { pattern: /\bagricultural productivity\b|\bfarm productivity\b/i,
    expansions: ['crop yields', 'smallholder farmers', 'agricultural output', 'food production', 'rural livelihoods'] },
  { pattern: /\blatin america\b|\blac\b/i,
    expansions: ['América Latina', 'Latinoamérica', 'Caribe', 'Caribbean'] },

  // NEW (probe-only, not yet in prod): trade liberalization
  { pattern: /\btrade liberali[sz]ation\b|\btariff (cut|reduction|liberali[sz]ation)s?\b|\btrade reform\b/i,
    expansions: ['import competition', 'China shock', 'tariff reduction', 'WTO accession', 'import penetration', 'trade opening', 'globalization', 'export expansion', 'trade shock'] },

  // NEW (probe-only): teacher quality / effectiveness
  { pattern: /\bteacher quality\b|\bteacher effectiveness\b|\bteacher value.?added\b/i,
    expansions: ['teacher value-added', 'teacher VA', 'teacher effects', 'value-added teacher', 'high-quality teachers', 'teacher impacts', 'teacher performance pay', 'teacher absenteeism'] },
];

function expandQueryForFTS(query) {
  const appended = [];
  const added = new Set();
  for (const { pattern, expansions } of SYNONYM_MAP) {
    if (pattern.test(query)) {
      for (const term of expansions) {
        const norm = term.toLowerCase();
        if (!query.toLowerCase().includes(norm) && !added.has(norm)) {
          appended.push(term);
          added.add(norm);
        }
      }
    }
  }
  return appended.length === 0 ? query : `${query} ${appended.join(' ')}`;
}

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const queriesArg = args.find(a => a.startsWith('--queries='))?.split('=')[1];
const wantedQueryIds = queriesArg ? queriesArg.split(',') : DEFAULT_QUERIES;

// ── Audit CSV → canonical paper list per query ────────────────────────────────

function parseCsvLine(line) {
  // Minimal CSV with quoted commas — handle "..." quoting only
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function loadCanonicals(queryShortIds) {
  const raw = readFileSync(AUDIT_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(raw[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const byQuery = new Map();
  for (let i = 1; i < raw.length; i++) {
    const f = parseCsvLine(raw[i]);
    const q = f[idx.query];                   // e.g. "q05"
    if (!queryShortIds.has(q)) continue;
    // Audit CSV occasionally lists 2 DOIs for one logical paper separated by " / "
    // (e.g. Chetty Friedman Rockoff has two AER pieces). Split into a list so DOI
    // matching tries each one.
    const rawDoi = f[idx.doi] ?? '';
    const dois = rawDoi.split(/\s*\/\s*(?=10\.)/).map(normDoi).filter(Boolean);
    const paper = {
      label: f[idx.paper],
      status: f[idx.status],
      auditTop20Rank: f[idx.top20_rank] ? parseInt(f[idx.top20_rank], 10) : null,
      corpusTitle: f[idx.corpus_match] || null,
      doi: dois[0] ?? null,
      doiAliases: dois,
      year: f[idx.year] ? parseInt(f[idx.year], 10) : null,
      sourceNote: f[idx.source_or_note] || null,
    };
    if (!byQuery.has(q)) byQuery.set(q, []);
    byQuery.get(q).push(paper);
  }
  return byQuery;
}

function normDoi(d) {
  if (!d) return '';
  return d.toLowerCase().trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
}

function normTitle(t) {
  return (t ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

// ── LLM embed ─────────────────────────────────────────────────────────────────

async function embedQuery(text) {
  if (!LLM_KEY) throw new Error('LLM_API_KEY not set; cannot embed query');
  const res = await fetch(`${LLM_BASE}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: 'search_query: ' + text }),
  });
  const json = await res.json();
  if (!json?.data?.[0]?.embedding) {
    throw new Error('embed failed: ' + JSON.stringify(json).slice(0, 200));
  }
  return json.data[0].embedding;
}

// ── Retrieval ─────────────────────────────────────────────────────────────────

async function matchWorks(vec, queryText, params = {}) {
  const t0 = Date.now();
  const { data, error } = await SB.rpc('match_works_v2', {
    query_embedding: vec,
    query_text: queryText,
    match_threshold: NO_FILTER_THRESHOLD,
    match_count: MATCH_COUNT,
    ...params,
  });
  return { papers: data ?? [], ms: Date.now() - t0, error: error?.message ?? null };
}

// Convenience: run match_works_v2 with the synonym-expanded FTS query text
// (the exact form prod sends — embedding stays on the original query).
async function matchWorksWithSynonyms(vec, queryText, params = {}) {
  return matchWorks(vec, expandQueryForFTS(queryText), params);
}

// Direct DB lookup for canonical papers that don't appear in the result set.
// Computes the cosine similarity & FTS score for the given query against each
// missing canonical so we still have signals to interpret "why isn't it in".
async function lookupMissingCanonicals(vec, queryText, dois) {
  if (!dois.length) return new Map();
  // Use a parameterized SQL via supabase-js .rpc — we don't have a dedicated RPC,
  // so we go through PostgREST .from('works').select() filtered by doi list,
  // plus a separate RPC call for per-doi similarity. Simpler: select rows then
  // compute cosine in the SQL via a small inline RPC. Since we don't have such
  // an RPC, fall back to: select rows including embedding, compute cosine in JS.
  const { data, error } = await SB
    .from('works')
    .select('id, title, canonical_doi, year, citation_count, venue, sms_level, embedding, fts_vector')
    .in('canonical_doi', dois);
  if (error) {
    console.error('lookupMissingCanonicals error:', error.message);
    return new Map();
  }
  const out = new Map();
  for (const row of data ?? []) {
    let sim = null;
    if (row.embedding) {
      // embedding stored as pgvector text "[v1,v2,...]"
      const arr = typeof row.embedding === 'string'
        ? row.embedding.replace(/^\[|\]$/g, '').split(',').map(Number)
        : row.embedding;
      sim = cosine(vec, arr);
    }
    out.set(normDoi(row.canonical_doi), {
      id: row.id,
      title: row.title,
      year: row.year,
      citationCount: row.citation_count,
      venue: row.venue,
      smsLevel: row.sms_level,
      similarity: sim,
      ftsRank: null,   // not trivially retrievable without an RPC; mark as unknown
    });
  }
  return out;
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ── Reranking simulation ──────────────────────────────────────────────────────

function baseScore(rankIdx /* 0-based */) {
  // DCG-style positional discount: 1 / log2(rank + 2)  → rank 0 = 1.0
  return 1.0 / Math.log2(rankIdx + 2);
}

function citationRate(citations, year) {
  const age = Math.max(1, CURRENT_YEAR - year + 1);
  return citations / age;
}

// ── Production rerank composite (mirrors rerank.ts) ──────────────────────────
// Kept in sync with supabase/functions/_shared/rerank.ts. Used by Variant E
// to test the impact of the new citation weight on canonical recovery.

const COMPOSITE_WEIGHTS = {
  similarity: 0.65,
  rigor:      0.15,
  recency:    0.10,
  region:     0.05,
  citation:   0.05,
};

const COMPOSITE_WEIGHTS_NO_CIT = {
  similarity: 0.70,
  rigor:      0.15,
  recency:    0.10,
  region:     0.05,
  citation:   0.00,
};

const CITATION_RATE_CEILING = 500;
const CITATION_RATE_LOG_CEILING = Math.log(1 + CITATION_RATE_CEILING);

const LAC_KEYWORDS = [
  'latin america', 'latin american', 'america latina', 'américa latina', 'latam', 'lac',
  'caribbean', 'caribe', 'south america', 'central america', 'mesoamerica',
  'argentina', 'bolivia', 'brazil', 'brasil', 'chile', 'colombia', 'costa rica',
  'cuba', 'dominican republic', 'república dominicana', 'ecuador', 'el salvador',
  'guatemala', 'haiti', 'haití', 'honduras', 'jamaica', 'mexico', 'méxico',
  'nicaragua', 'panama', 'panamá', 'paraguay', 'peru', 'perú', 'uruguay', 'venezuela',
  'barbados', 'trinidad and tobago', 'guyana', 'suriname', 'belize',
  'andean', 'mercosur', 'cono sur',
];
const LAC_REGEX = new RegExp(`\\b(${LAC_KEYWORDS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');

function rigorScore(p) {
  const sms = Number(p.sms_level ?? 0);
  if (!Number.isFinite(sms) || sms < 1) return 0;
  return Math.min(sms, 5) / 5;
}
function recencyScore(p) {
  const year = Number(p.year ?? 0);
  if (!Number.isFinite(year) || year < 1900) return 0;
  const age = Math.max(0, CURRENT_YEAR - year);
  return Math.max(0, 1 - age / 25);
}
function similarityComposite(p) {
  const s = Number(p.similarity ?? 0);
  return Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : 0;
}
function regionScore(p, regex) {
  if (!regex) return 0;
  const hay = [p.title ?? '', p.abstract ?? '', Array.isArray(p.geography) ? p.geography.join(' ') : ''].join(' ');
  return regex.test(hay) ? 1 : 0;
}
function citationComposite(p) {
  const c = Number(p.citation_count ?? 0);
  if (!Number.isFinite(c) || c <= 0) return 0;
  const y = Number(p.year ?? 0);
  if (!Number.isFinite(y) || y < 1900) return 0;
  const age = Math.max(1, CURRENT_YEAR - y + 1);
  const rate = c / age;
  return Math.max(0, Math.min(1, Math.log(1 + rate) / CITATION_RATE_LOG_CEILING));
}

function compositeRerank(papers, weights, queryText) {
  // LAC regex only when the query mentions LAC (mirrors rerank.ts default behavior)
  const regex = LAC_REGEX.test(queryText) ? LAC_REGEX : null;
  const effSim = regex ? weights.similarity : weights.similarity + weights.region;
  const effReg = regex ? weights.region : 0;
  const scored = papers.map(p => {
    const score =
      effSim * similarityComposite(p) +
      weights.rigor * rigorScore(p) +
      weights.recency * recencyScore(p) +
      effReg * regionScore(p, regex) +
      weights.citation * citationComposite(p);
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ p }) => p);
}

function rerank(papers, variant, alpha) {
  // Apply citation factor to top-N (relevance gate), leave the tail untouched.
  // Then re-sort by adjusted score, but only within the gated region — papers
  // outside the gate stay in their original relative order at the tail.
  const totals = papers.map(p => p.citation_count ?? 0);
  const rates  = papers.map(p => citationRate(p.citation_count ?? 0, p.year ?? CURRENT_YEAR));
  const maxTotal = Math.max(1, ...totals);
  const maxRate  = Math.max(1, ...rates);

  const adjusted = papers.map((p, i) => {
    const base = baseScore(i);
    if (i >= RELEVANCE_GATE_TOP_N || variant === 'A') {
      return { ...p, _originalRank: i + 1, _base: base, _score: base, _boost: 1.0 };
    }
    const c = p.citation_count ?? 0;
    const r = citationRate(c, p.year ?? CURRENT_YEAR);
    let boost;
    if (variant === 'B') {
      boost = 1 + alpha * Math.log(1 + c);
    } else if (variant === 'C') {
      boost = 1 + alpha * Math.log(1 + r);
    } else if (variant === 'D') {
      const nt = c / maxTotal;
      const nr = r / maxRate;
      const raw = 1 + alpha * Math.log(1 + Math.max(nt, nr) * Math.max(maxTotal, maxRate));
      boost = Math.min(raw, 1 + HARD_CAP);
    } else {
      boost = 1.0;
    }
    return { ...p, _originalRank: i + 1, _base: base, _score: base * boost, _boost: boost };
  });

  // Stable sort: gated region by _score desc, tail keeps original order
  const head = adjusted.slice(0, RELEVANCE_GATE_TOP_N).sort((x, y) => y._score - x._score);
  const tail = adjusted.slice(RELEVANCE_GATE_TOP_N);
  return [...head, ...tail];
}

// ── Score lookup ──────────────────────────────────────────────────────────────

// Use the canonical paper title as the match anchor when DOIs aren't available
// (Altonji & Card 1991 etc.). The corpusTitle from the audit is the title that
// already matched in the DB during the audit, so an exact-normalised compare is
// sufficient. No substring-includes fallback — those produce false positives
// where multiple canonicals collapse to the same result row.
function titleMatch(resultTitle, canonicalCorpusTitle) {
  if (!resultTitle || !canonicalCorpusTitle) return false;
  return normTitle(resultTitle) === normTitle(canonicalCorpusTitle);
}

function findCanonicalPositions(papers, canonicals, lookupByDoi) {
  return canonicals.map(c => {
    // Try every DOI alias against every result row's normalised DOI
    const aliases = (c.doiAliases?.length ? c.doiAliases : (c.doi ? [c.doi] : []));
    let pos = -1;
    if (aliases.length) {
      pos = papers.findIndex(p => aliases.includes(normDoi(p.canonical_doi)));
    }
    // ONLY fall back to title match if the canonical has no DOI at all.
    // A canonical with a DOI that's not in the candidate pool means "missed
    // by retrieval" — never substitute a different paper for it.
    if (pos === -1 && aliases.length === 0 && c.corpusTitle) {
      pos = papers.findIndex(p => titleMatch(p.title, c.corpusTitle));
    }
    const inResult = pos !== -1;
    const row = inResult ? papers[pos] : null;
    // Direct lookup: pick the first alias that returned something in the DB
    let directLookup = null;
    if (!inResult) {
      for (const a of aliases) {
        const hit = lookupByDoi.get(a);
        if (hit) { directLookup = hit; break; }
      }
    }

    const citations = row?.citation_count ?? directLookup?.citationCount ?? null;
    const year = row?.year ?? directLookup?.year ?? c.year ?? null;
    const venue = row?.venue ?? directLookup?.venue ?? null;
    const sms = row?.sms_level ?? directLookup?.smsLevel ?? null;
    const sim = row?.similarity ?? directLookup?.similarity ?? null;
    const fts = row?.fts_rank ?? null;
    const citationRateValue = (citations != null && year != null) ? citationRate(citations, year) : null;

    return {
      label: c.label,
      doi: aliases[0] ?? null,
      doiAliases: aliases,
      auditStatus: c.status,
      auditTop20Rank: c.auditTop20Rank,
      title: row?.title ?? directLookup?.title ?? c.corpusTitle ?? null,
      year,
      venue,
      smsLevel: sms,
      citationCount: citations,
      citationRate: citationRateValue,
      rank: inResult ? pos + 1 : null,    // 1-based
      similarity: sim,
      ftsRank: fts,
      inTop50:  inResult && pos < 50,
      inTop100: inResult && pos < 100,
      inTop200: inResult && pos < 200,
      inCorpus: inResult || directLookup != null,
      foundVia: inResult ? 'match_works_v2' : (directLookup ? 'direct_doi_lookup' : 'not_found'),
    };
  });
}

// ── Report builders ───────────────────────────────────────────────────────────

function fmtNum(v) { return v == null ? '—' : (Number.isInteger(v) ? `${v}` : v.toFixed(3)); }
function fmtRank(v) { return v == null ? 'n/a' : `${v}`; }
function trimTitle(t, n = 70) { return !t ? '—' : (t.length > n ? t.slice(0, n - 1) + '…' : t); }

function tablePositions(rows) {
  const header = '| Paper | Audit status | Year | Cites | Cites/yr | Sim | FTS | Venue | SMS | Rank | Top50/100/200 |';
  const sep    = '|---|---|---:|---:|---:|---:|---:|---|---:|---:|---|';
  const body = rows.map(r => {
    const t50 = r.inTop50 ? '✓' : '·';
    const t100 = r.inTop100 ? '✓' : '·';
    const t200 = r.inTop200 ? '✓' : '·';
    const venue = r.venue ? trimTitle(r.venue, 22) : '—';
    return `| ${trimTitle(r.label, 32)} | ${r.auditStatus ?? '—'} | ${fmtNum(r.year)} | ${fmtNum(r.citationCount)} | ${fmtNum(r.citationRate)} | ${fmtNum(r.similarity)} | ${fmtNum(r.ftsRank)} | ${venue} | ${fmtNum(r.smsLevel)} | ${fmtRank(r.rank)} | ${t50}/${t100}/${t200} |`;
  });
  return [header, sep, ...body].join('\n');
}

// Synonym-only comparison: no filters anywhere. Isolates the synonym effect.
function tableSynonymOnly(rowsRaw, rowsSyn) {
  const byDoi = new Map(rowsSyn.map(r => [r.doi, r]));
  const header = '| Paper | Year | Cites/yr | Rank (raw) | Rank (+synonyms) | Δ syn |';
  const sep    = '|---|---:|---:|---:|---:|---|';
  const body = rowsRaw.map(r => {
    const s = byDoi.get(r.doi);
    const ra = r.rank, rs = s?.rank ?? null;
    let d = '—';
    if (ra != null && rs != null) {
      const diff = rs - ra;
      d = diff === 0 ? 'same' : (diff > 0 ? `+${diff} (hurt)` : `${diff} (helped)`);
    } else if (ra == null && rs != null) {
      d = `synonyms recovered — was out of pool`;
    } else if (ra != null && rs == null) {
      d = `synonyms lost`;
    } else {
      d = `still out of pool`;
    }
    return `| ${trimTitle(r.label, 32)} | ${fmtNum(r.year)} | ${fmtNum(r.citationRate)} | ${fmtRank(ra)} | ${fmtRank(rs)} | ${d} |`;
  });
  return [header, sep, ...body].join('\n');
}

// Four-way: all years vs synonyms vs year-filter vs both
function tableFourWay(rowsA, rowsB, rowsC, rowsD) {
  const mB = new Map(rowsB.map(r => [r.doi, r]));
  const mC = new Map(rowsC.map(r => [r.doi, r]));
  const mD = new Map(rowsD.map(r => [r.doi, r]));
  const header = '| Paper | Year | All years | + synonyms | + year≥2010 | + both (prod) |';
  const sep    = '|---|---:|---:|---:|---:|---:|';
  const body = rowsA.map(r => {
    return `| ${trimTitle(r.label, 32)} | ${fmtNum(r.year)} | ${fmtRank(r.rank)} | ${fmtRank(mB.get(r.doi)?.rank ?? null)} | ${fmtRank(mC.get(r.doi)?.rank ?? null)} | ${fmtRank(mD.get(r.doi)?.rank ?? null)} |`;
  });
  return [header, sep, ...body].join('\n');
}

// Three-way comparison: shows the synonym-expansion impact at a glance
// alongside the year-filter impact.
function tableThreeWay(rowsAllYears, rowsProdRaw, rowsProdSynonyms) {
  const byDoiRaw = new Map(rowsProdRaw.map(r => [r.doi, r]));
  const byDoiSyn = new Map(rowsProdSynonyms.map(r => [r.doi, r]));
  const header = '| Paper | Year | Cites/yr | All-years | Prod (raw FTS) | Prod (synonyms) | Δ syn | Δ yr-filter |';
  const sep    = '|---|---:|---:|---:|---:|---:|---|---|';
  const body = rowsAllYears.map(a => {
    const raw = byDoiRaw.get(a.doi);
    const syn = byDoiSyn.get(a.doi);
    const rA = a.rank, rR = raw?.rank ?? null, rS = syn?.rank ?? null;
    let dSyn = '—';
    if (rR != null && rS != null) {
      const d = rS - rR;
      dSyn = d === 0 ? 'same' : (d > 0 ? `+${d}` : `${d}`);
    } else if (rR == null && rS != null) {
      dSyn = `synonyms recovered`;
    } else if (rR != null && rS == null) {
      dSyn = `synonyms lost`;
    }
    let dYr = '—';
    if (rA != null && rS == null) {
      dYr = (a.year != null && a.year < 2010) ? 'dropped by year filter' : 'dropped';
    } else if (rA != null && rS != null) {
      const d = rS - rA;
      dYr = d === 0 ? 'same' : (d > 0 ? `+${d}` : `${d}`);
    } else if (rA == null && rS == null) {
      dYr = 'out of pool';
    }
    return `| ${trimTitle(a.label, 32)} | ${fmtNum(a.year)} | ${fmtNum(a.citationRate)} | ${fmtRank(rA)} | ${fmtRank(rR)} | ${fmtRank(rS)} | ${dSyn} | ${dYr} |`;
  });
  return [header, sep, ...body].join('\n');
}

// Side-by-side comparison: shows the year-filter impact at a glance —
// rank under no_filter (all years) vs rank under current_prod (year≥2010).
function tableSideBySide(rowsAllYears, rowsYear2010Floor) {
  const byDoi = new Map(rowsYear2010Floor.map(r => [r.doi, r]));
  const header = '| Paper | Year | Cites | Cites/yr | Rank — all years | Rank — year ≥ 2010 (prod) | Δ |';
  const sep    = '|---|---:|---:|---:|---:|---:|---|';
  const body = rowsAllYears.map(a => {
    const b = byDoi.get(a.doi);
    const ra = a.rank;
    const rb = b?.rank ?? null;
    let delta = '—';
    if (ra != null && rb == null) {
      // Pre-2010 papers: dropped by filter, not by ranking
      delta = (a.year != null && a.year < 2010) ? `dropped by year filter` : `dropped`;
    } else if (ra != null && rb != null) {
      const d = rb - ra;
      delta = d === 0 ? `same` : (d > 0 ? `+${d}` : `${d}`);
    } else if (ra == null && rb == null) {
      delta = `out of pool`;
    }
    return `| ${trimTitle(a.label, 32)} | ${fmtNum(a.year)} | ${fmtNum(a.citationCount)} | ${fmtNum(a.citationRate)} | ${fmtRank(ra)} | ${fmtRank(rb)} | ${delta} |`;
  });
  return [header, sep, ...body].join('\n');
}

function summarizeRerank(canonRowsByVariant) {
  // For each variant×alpha, count canonicals that entered top-20.
  const lines = ['| Variant | α | Canonicals in top-20 (before → after) | Moved in | Moved out |',
                 '|---|---:|---|---|---|'];
  for (const v of canonRowsByVariant) {
    lines.push(`| ${v.variant} | ${v.alpha.toFixed(2)} | ${v.before} → ${v.after} | ${v.movedIn.join('; ') || '—'} | ${v.movedOut.join('; ') || '—'} |`);
  }
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function probeQuery(query, canonicals) {
  console.log(`\n▸ ${query.id}: ${query.query.slice(0, 80)}`);

  const vec = await embedQuery(query.query);

  // 1) no_filter — raw query, no filters (ceiling reference)
  const noFilter = await matchWorks(vec, query.query, {});
  if (noFilter.error) {
    console.error(`  no_filter RPC error: ${noFilter.error}`);
    return null;
  }
  console.log(`  no_filter (raw):              ${noFilter.papers.length} papers in ${noFilter.ms}ms`);

  // 1b) no_filter + synonyms — isolates synonym effect from year/SMS gate
  const expandedAll = expandQueryForFTS(query.query);
  const noFilterSyn = await matchWorks(vec, expandedAll, {});
  console.log(`  no_filter (with synonyms):    ${noFilterSyn.papers?.length ?? 0} papers in ${noFilterSyn.ms}ms`);

  // 2) current_prod_raw — what the probe ran before (no synonym expansion)
  const currentProdRaw = await matchWorks(vec, query.query, {
    match_threshold: PROD_THRESHOLD,
    filter_min_year: 2010,
    filter_sms_min: 2,
  });
  console.log(`  current_prod (raw FTS):      ${currentProdRaw.papers?.length ?? 0} papers in ${currentProdRaw.ms}ms`);

  // 3) current_prod_with_synonyms — matches what prod actually does
  const expanded = expandQueryForFTS(query.query);
  const synonymAdded = expanded !== query.query
    ? expanded.slice(query.query.length).trim().split(/\s+/).filter(Boolean)
    : [];
  if (synonymAdded.length) {
    console.log(`  synonym expansion (+${synonymAdded.length}): ${synonymAdded.slice(0, 6).join(', ')}${synonymAdded.length > 6 ? '…' : ''}`);
  } else {
    console.log(`  synonym expansion (+0): no map entry matched`);
  }
  const currentProd = await matchWorks(vec, expanded, {
    match_threshold: PROD_THRESHOLD,
    filter_min_year: 2010,
    filter_sms_min: 2,
  });
  console.log(`  current_prod (with synonyms): ${currentProd.papers?.length ?? 0} papers in ${currentProd.ms}ms`);

  // For canonicals not in the no_filter result set, do a direct DOI lookup —
  // try every alias DOI so 2-DOI canonicals (e.g. Chetty AER pair) work.
  const allAliases = canonicals.flatMap(c => c.doiAliases ?? (c.doi ? [c.doi] : []));

  const noFilterDois = new Set(noFilter.papers.map(p => normDoi(p.canonical_doi)));
  const missingDois = allAliases.filter(d => d && !noFilterDois.has(d));
  const lookupNoFilter = await lookupMissingCanonicals(vec, query.query, missingDois);

  const prodDois = new Set((currentProd.papers ?? []).map(p => normDoi(p.canonical_doi)));
  const missingProd = allAliases.filter(d => d && !prodDois.has(d));
  const lookupProd = await lookupMissingCanonicals(vec, query.query, missingProd);

  const positionsNoFilter    = findCanonicalPositions(noFilter.papers, canonicals, lookupNoFilter);
  const positionsNoFilterSyn = findCanonicalPositions(noFilterSyn.papers ?? [], canonicals, lookupNoFilter);
  const positionsProdRaw     = findCanonicalPositions(currentProdRaw.papers ?? [], canonicals, lookupProd);
  const positionsProd        = findCanonicalPositions(currentProd.papers ?? [], canonicals, lookupProd);

  // Rerank simulation runs on the with-synonyms current_prod result (closest
  // to what production actually shows users). The composite reranker only
  // operates on the qualified pool the upstream classifier admits — citation
  // is a precision layer, not a recall fix.
  const variantSummary = [];
  const compositePool = currentProd.papers ?? [];

  for (const variant of ['A', 'B', 'C', 'D']) {
    for (const alpha of (variant === 'A' ? [0] : ALPHAS)) {
      const reranked = rerank(noFilter.papers, variant, alpha);
      const top20Doi = new Set(reranked.slice(0, 20).map(p => normDoi(p.canonical_doi)));
      const aliasHits = (c) => (c.doiAliases ?? (c.doi ? [c.doi] : [])).some(d => top20Doi.has(d));
      const before = positionsNoFilter.filter(r => r.rank != null && r.rank <= 20).length;
      const inSet  = canonicals.filter(aliasHits);
      const movedInRows = inSet.filter(c => {
        const orig = positionsNoFilter.find(r => r.doi === c.doi);
        return orig && (orig.rank == null || orig.rank > 20);
      }).map(c => `${c.label}${c.year ? ' (' + c.year + ')' : ''}`);
      const movedOutRows = positionsNoFilter
        .filter(r => r.rank != null && r.rank <= 20 && !top20Doi.has(r.doi))
        .map(r => `${r.label}${r.year ? ' (' + r.year + ')' : ''}`);
      variantSummary.push({
        variant, alpha, before, after: inSet.length,
        movedIn: movedInRows, movedOut: movedOutRows,
      });
    }
  }

  // Variants E and F: production composite reranker.
  // E = current weights (no citation term).  F = new weights with citation = 0.05.
  // Both operate on the current_prod pool — the qualified candidates production
  // actually surfaces. Comparing E vs F isolates the citation weight effect.
  for (const [tag, weights] of [['E', COMPOSITE_WEIGHTS_NO_CIT], ['F', COMPOSITE_WEIGHTS]]) {
    const reranked = compositeRerank(compositePool, weights, query.query);
    const top20Doi = new Set(reranked.slice(0, 20).map(p => normDoi(p.canonical_doi)));
    const aliasHits = (c) => (c.doiAliases ?? (c.doi ? [c.doi] : [])).some(d => top20Doi.has(d));
    const before = positionsProd.filter(r => r.rank != null && r.rank <= 20).length;
    const inSet  = canonicals.filter(aliasHits);
    const movedInRows = inSet.filter(c => {
      const orig = positionsProd.find(r => r.doi === c.doi);
      return orig && (orig.rank == null || orig.rank > 20);
    }).map(c => `${c.label}${c.year ? ' (' + c.year + ')' : ''}`);
    const movedOutRows = positionsProd
      .filter(r => r.rank != null && r.rank <= 20 && !top20Doi.has(r.doi))
      .map(r => `${r.label}${r.year ? ' (' + r.year + ')' : ''}`);
    variantSummary.push({
      variant: tag, alpha: weights.citation, before, after: inSet.length,
      movedIn: movedInRows, movedOut: movedOutRows,
    });
  }

  return {
    query,
    expandedQuery: expanded,
    synonymAdded,
    noFilter:        { count: noFilter.papers.length, ms: noFilter.ms },
    noFilterSyn:     { count: noFilterSyn.papers?.length ?? 0, ms: noFilterSyn.ms },
    currentProdRaw:  { count: currentProdRaw.papers?.length ?? 0, ms: currentProdRaw.ms },
    currentProd:     { count: currentProd.papers?.length ?? 0, ms: currentProd.ms },
    positionsNoFilter,
    positionsNoFilterSyn,
    positionsProdRaw,
    positionsProd,
    variantSummary,
    // Keep the raw top-50 for downstream analysis
    topNoFilter: noFilter.papers.slice(0, 50).map(p => ({
      rank: 0, // filled below
      id: p.id, doi: normDoi(p.canonical_doi), title: p.title, year: p.year,
      citation_count: p.citation_count, venue: p.venue, sms_level: p.sms_level,
      similarity: p.similarity, fts_rank: p.fts_rank,
    })).map((p, i) => ({ ...p, rank: i + 1 })),
  };
}

async function main() {
  if (!LLM_KEY) {
    console.error('\nERROR: LLM_API_KEY is not set in environment.');
    console.error('This probe needs to embed the query via LiteLLM.');
    console.error('Set LLM_API_KEY in .env (DevOps has the key) or run on the machine with credentials.\n');
    process.exit(1);
  }

  const qSet = new Set(wantedQueryIds);
  const evals = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  const canonicalsByQ = loadCanonicals(qSet);
  // Map q05 → q05-cct-school-attendance-learning, etc.
  const queries = evals.queries.filter(q => qSet.has(q.id.split('-')[0]));

  console.log(`\n${'='.repeat(80)}`);
  console.log(`CANONICAL POSITION PROBE  |  ${queries.length} queries`);
  console.log(`embedding=${EMBED_MODEL}  match_count=${MATCH_COUNT}`);
  console.log('='.repeat(80));

  const results = [];
  for (const q of queries) {
    const shortId = q.id.split('-')[0];
    const canonicals = canonicalsByQ.get(shortId) ?? [];
    if (canonicals.length === 0) {
      console.log(`\n▸ ${q.id}: no canonicals in audit CSV — skipping`);
      continue;
    }
    const probed = await probeQuery(q, canonicals);
    if (probed) results.push(probed);
  }

  const date = new Date().toISOString().slice(0, 10);
  const jsonPath = join(__dir, `../reports/canonical-position-probe-${date}.json`);
  const mdPath   = join(__dir, `../reports/canonical-position-probe-${date}.md`);

  writeFileSync(jsonPath, JSON.stringify({ runAt: new Date().toISOString(), results }, null, 2));

  // Build markdown
  const md = [];
  md.push(`# Canonical Position Probe — ${date}`);
  md.push('');
  md.push(`Probe to distinguish *retrieval* failures (canonical paper not in candidate pool) from *ranking* failures (canonical in pool but ranked too low). Then simulate citation-aware reranking under multiple variants to see what would move the canonicals into top-20 without raising prestige bias.`);
  md.push('');
  md.push(`**Configs probed:**`);
  md.push(`- \`no_filter\` — match_works_v2 threshold=0, no year/sms filters, match_count=${MATCH_COUNT}.`);
  md.push(`- \`current_prod\` — match_works_v2 threshold=0.40, filter_min_year=2010, filter_sms_min=2 (live prod config from eval-regime-harness.mjs).`);
  md.push('');
  md.push(`**Rerank variants** (only applied to no_filter result so pre-2010 canonicals can be candidates):`);
  md.push(`- A: no boost (baseline)`);
  md.push(`- B: raw citations — \`base × (1 + α·log(1+c))\``);
  md.push(`- C: age-normalized — \`base × (1 + α·log(1+rate))\` where rate = c / (years_old+1)`);
  md.push(`- D: hybrid capped at +${(HARD_CAP * 100).toFixed(0)}% — \`base × min(1+α·log(1+max(norm_total,norm_rate)·M), 1+${HARD_CAP})\``);
  md.push(`- α ∈ {${ALPHAS.join(', ')}}, relevance gate = top-${RELEVANCE_GATE_TOP_N} positions only`);
  md.push(`- Base relevance: \`1 / log2(rank+1)\` (DCG-style positional discount)`);
  md.push('');

  for (const r of results) {
    md.push(`---`);
    md.push('');
    md.push(`## ${r.query.id}`);
    md.push('');
    md.push(`> ${r.query.query}`);
    md.push('');
    if (r.query.intent) md.push(`**Intent:** ${r.query.intent}`);
    md.push('');
    md.push(`**Counts retrieved:** no_filter ${r.noFilter.count} · current_prod (raw FTS) ${r.currentProdRaw.count} · current_prod (with synonyms) ${r.currentProd.count}`);
    md.push('');
    if (r.synonymAdded.length) {
      md.push(`**Synonym expansion (+${r.synonymAdded.length}):** ${r.synonymAdded.slice(0, 10).join(', ')}${r.synonymAdded.length > 10 ? '…' : ''}`);
    } else {
      md.push(`**Synonym expansion: ⚠ no map entry matched this query** — FTS branch uses the raw query.`);
    }
    md.push('');
    md.push(`### Synonym test — no_filter vs no_filter+synonyms (isolates synonym effect)`);
    md.push('');
    md.push(`Removes the year/SMS gate so we can see whether synonyms recover canonicals into the candidate pool at all. "Δ syn" is rank shift between raw and with-synonyms — negative is good.`);
    md.push('');
    md.push(tableSynonymOnly(r.positionsNoFilter, r.positionsNoFilterSyn));
    md.push('');
    md.push(`### Four-way comparison — full filter and synonym matrix`);
    md.push('');
    md.push(`no_filter (ceiling) → no_filter+synonyms → current_prod (raw FTS) → current_prod with synonyms. The last column is what live prod returns.`);
    md.push('');
    md.push(tableFourWay(r.positionsNoFilter, r.positionsNoFilterSyn, r.positionsProdRaw, r.positionsProd));
    md.push('');
    md.push(`### Canonical positions — all years (no_filter, ceiling)`);
    md.push('');
    md.push(tablePositions(r.positionsNoFilter));
    md.push('');
    md.push(`### Canonical positions — year ≥ 2010, with synonyms (live prod)`);
    md.push('');
    md.push(tablePositions(r.positionsProd));
    md.push('');
    md.push(`### Rerank simulation — canonicals reaching top-20 (no_filter base)`);
    md.push('');
    md.push(summarizeRerank(r.variantSummary));
    md.push('');
    md.push(`### Top-20 (no_filter, before reranking)`);
    md.push('');
    md.push('| Rank | Title | Year | Cites | Sim | FTS | Venue |');
    md.push('|---:|---|---:|---:|---:|---:|---|');
    for (const p of r.topNoFilter.slice(0, 20)) {
      md.push(`| ${p.rank} | ${trimTitle(p.title, 60)} | ${fmtNum(p.year)} | ${fmtNum(p.citation_count)} | ${fmtNum(p.similarity)} | ${fmtNum(p.fts_rank)} | ${trimTitle(p.venue, 22)} |`);
    }
    md.push('');
  }

  md.push('---');
  md.push('');
  md.push('## Notes for reading');
  md.push('');
  md.push(`- "rank = n/a" in current_prod almost always means the paper is pre-2010 (filter_min_year=2010 drops it). Compare to no_filter — if rank exists there, the failure is the year pre-filter, not the embedding.`);
  md.push(`- "Cites/yr" is age-normalized: \`citations / max(1, ${CURRENT_YEAR} - year + 1)\`. Variant C boosts on this.`);
  md.push(`- Variant A is a sanity check: same ordering as no_filter, so "Canonicals in top-20" reflects the floor that reranking has to beat.`);
  md.push(`- "Moved out" lists papers that lost their top-20 spot. Inspect for prestige bias — high-citation but off-topic papers crowding out lower-cited but on-topic ones.`);
  md.push(`- FTS column may be blank for canonicals not in the SQL result; the function returns it only for papers that survived RRF combination.`);

  writeFileSync(mdPath, md.join('\n') + '\n');
  console.log(`\nWrote:\n  ${mdPath}\n  ${jsonPath}\n`);
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});
