#!/usr/bin/env node
/**
 * Import RePEc-style working papers (NBER, IZA, CEPR, World Bank, OECD).
 * Pulls from OpenAlex by source/institution filter, dedupes against existing
 * DOIs/IDs, tags rows with everything needed so no backfill is required:
 *   - corpus_source = 'repec_bulk'
 *   - source        = 'repec'
 *   - venue         = series name
 *   - methodology_design / sms_level  (regex on title+abstract)
 *   - repec_rank / repec_percentile   (from data/repec_rankings.csv when matched)
 *   - raw_data.scl_topics             (pre-computed, copy to scl_topics[] post-migration)
 *   - raw_data.source_type            ('working_paper')
 *   - raw_data.series_key             (e.g. 'nber','iza','cepr','wb','oecd')
 *
 * Embeddings are left NULL — run scripts/backfill-fast.mjs after this completes.
 *
 * Usage:
 *   node scripts/import-repec.mjs                       # all series, last 15y
 *   node scripts/import-repec.mjs --dry-run             # count only, no insert
 *   node scripts/import-repec.mjs --series nber         # one series
 *   node scripts/import-repec.mjs --years 10            # last N years
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { classifyTopics } from './scl-topics.mjs';

config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function flagValue(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const DRY_RUN = args.includes('--dry-run');
const YEARS = parseInt(flagValue('--years', '15'));
const SERIES_ARG = flagValue('--series', 'all');
const YEAR_FROM = new Date().getFullYear() - YEARS;

// ---------------------------------------------------------------------------
// Series catalogue
// ---------------------------------------------------------------------------
// Each series resolves to one or more OpenAlex filters. Multiple filters in a
// series are unioned (we run them sequentially, dedupe inside).
const SERIES = {
  nber: {
    venue: 'NBER Working Papers',
    repecKey: 'nbr.nberwo',
    filters: [
      'primary_location.source.id:S2809516038', // NBER source
    ],
  },
  iza: {
    venue: 'IZA Discussion Papers',
    repecKey: 'iza.izadps',
    filters: [
      'institutions.id:I197518295,type:preprint', // IZA institution, preprint type
      'institutions.id:I197518295,type:report',
    ],
  },
  cepr: {
    venue: 'CEPR Discussion Papers',
    repecKey: 'cpr.ceprdp',
    filters: [
      'institutions.id:I4210140326,type:preprint',
      'institutions.id:I4210140326,type:report',
    ],
  },
  wb: {
    venue: 'World Bank Working Paper / Report',
    repecKey: 'wbk.wbrwps',
    filters: [
      'primary_location.source.id:S4377196270', // WB Open Knowledge Repo
      'primary_location.source.id:S4306401179', // WB Documents & Reports
      'primary_location.source.id:S4210231086', // WB Policy Research WP
    ],
  },
  oecd: {
    venue: 'OECD Working Papers',
    repecKey: 'oec.oecdec',
    filters: [
      'primary_location.source.id:S4210239538', // OECD Economics Dept
      'primary_location.source.id:S4210221173', // OECD Social Emp & Migration
      'primary_location.source.id:S4210230829', // OECD Education
      'primary_location.source.id:S4210233738', // OECD Health
      'primary_location.source.id:S4210234223', // OECD Development
      'primary_location.source.id:S4210218933', // OECD Public Governance
      'primary_location.source.id:S4210240609', // OECD Trade Policy
      'primary_location.source.id:S4210210614', // OECD STI
      'primary_location.source.id:S4210174957', // OECD International Investment
      'primary_location.source.id:S4210213477', // OECD Finance/Insurance/Pensions
    ],
  },
};

function getSelectedSeries() {
  if (SERIES_ARG === 'all') return Object.entries(SERIES);
  if (!SERIES[SERIES_ARG]) {
    console.error(`Unknown series: ${SERIES_ARG}. Choose from: ${Object.keys(SERIES).join(', ')}`);
    process.exit(1);
  }
  return [[SERIES_ARG, SERIES[SERIES_ARG]]];
}

// ---------------------------------------------------------------------------
// RePEc rank lookup (optional enrichment from data/repec_rankings.csv)
// ---------------------------------------------------------------------------
function loadRepecRanks() {
  const csvPath = path.join(__dirname, '..', 'data', 'repec_rankings.csv');
  if (!fs.existsSync(csvPath)) return new Map();
  const map = new Map();
  const text = fs.readFileSync(csvPath, 'utf-8');
  const lines = text.split(/\r?\n/).slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    // CSV: rank,journal_name,publisher,score,items_listed,percentile,...
    const cols = parseCsvLine(line);
    if (cols.length < 6) continue;
    const name = cols[1].toLowerCase();
    const rank = parseInt(cols[0]);
    const percentile = parseFloat(cols[5]);
    map.set(name, { rank, percentile });
  }
  return map;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
    else if (c === '"') inQ = !inQ;
    else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const REPEC_RANKS = loadRepecRanks();

function lookupRepecRank(seriesVenue, paperVenue) {
  const candidates = [paperVenue, seriesVenue].filter(Boolean).map(s => s.toLowerCase());
  for (const c of candidates) {
    if (REPEC_RANKS.has(c)) return REPEC_RANKS.get(c);
    for (const [k, v] of REPEC_RANKS) {
      if (c.includes(k) || k.includes(c)) return v;
    }
  }
  return { rank: null, percentile: null };
}

// ---------------------------------------------------------------------------
// OpenAlex fetcher
// ---------------------------------------------------------------------------
const OA_URL = 'https://api.openalex.org/works';
const OA_EMAIL = process.env.OPENALEX_EMAIL || 'horizon-scanner@iadb.org';

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

async function fetchFilter(filterStr, existingDois, existingIds, seriesKey, seriesCfg) {
  const papers = [];
  let cursor = '*';
  let page = 0;

  while (true) {
    const params = new URLSearchParams({
      mailto: OA_EMAIL,
      filter: [
        filterStr,
        `from_publication_date:${YEAR_FROM}-01-01`,
      ].join(','),
      sort: 'publication_date:desc',
      per_page: '200',
      select: 'id,doi,title,abstract_inverted_index,publication_year,publication_date,cited_by_count,authorships,primary_location,open_access,concepts,type',
      cursor,
    });

    let data;
    try {
      const res = await fetch(`${OA_URL}?${params}`, { signal: AbortSignal.timeout(25000) });
      if (!res.ok) {
        console.error(`\n  [OA ${res.status}] ${filterStr.slice(0, 60)}`);
        // 429 → backoff
        if (res.status === 429) { await sleep(8000); continue; }
        break;
      }
      data = await res.json();
    } catch (err) {
      console.error(`\n  Fetch error on ${filterStr}: ${err.message}`);
      await sleep(3000);
      continue;
    }

    const results = data.results || [];
    if (!results.length) break;

    for (const raw of results) {
      const doi = normDoi(raw.doi);
      const oaWid = raw.id?.match(/\/(W\d+)$/)?.[1];
      const id = doi || (oaWid ? `oa:${oaWid}` : null);
      if (!id || !raw.title) continue;
      if (doi && existingDois.has(doi)) continue;
      if (existingIds.has(id)) continue;
      if (doi) existingDois.add(doi);
      existingIds.add(id);

      const loc = raw.primary_location || {};
      const src = loc.source || {};
      const oa = raw.open_access || {};
      const venue = src.display_name || seriesCfg.venue;

      papers.push({
        id, title: raw.title,
        year: raw.publication_year,
        abstract: reconstructAbstract(raw.abstract_inverted_index),
        citationCount: raw.cited_by_count ?? null,
        doi,
        authors: (raw.authorships || []).map(a => a?.author?.display_name).filter(Boolean),
        publicationDate: raw.publication_date,
        isOpenAccess: oa.is_oa !== false, // working papers = open by default
        openAccessPdfUrl: oa.oa_url || loc.pdf_url || null,
        fieldsOfStudy: (raw.concepts || []).map(c => c?.display_name).filter(Boolean),
        venue,
        url: oa.oa_url || loc.landing_page_url || (doi ? `https://doi.org/${doi}` : null),
        oaType: raw.type,
        seriesKey,
        seriesVenue: seriesCfg.venue,
      });
    }

    cursor = data.meta?.next_cursor;
    if (!cursor) break;
    page++;
    process.stdout.write(`\r    [${seriesKey}] ${papers.length} new (page ${page})`);
    await sleep(120);
  }
  return papers;
}

// ---------------------------------------------------------------------------
// Tagging + insert
// ---------------------------------------------------------------------------
const SMS_PATTERNS = [
  { design: 'RCT',          level: 5, re: /\b(randomized|randomised|rct|random assignment|randomly assigned)\b/i },
  { design: 'DiD',          level: 4, re: /\b(difference[- ]in[- ]differences?|diff[- ]in[- ]diff|did estimator|double difference)\b/i },
  { design: 'IV',           level: 4, re: /\b(instrumental variables?|two[- ]stage least squares|2sls|iv estimator)\b/i },
  { design: 'RDD',          level: 4, re: /\b(regression[- ]discontinuity|rdd)\b/i },
  { design: 'Synthetic',    level: 4, re: /\b(synthetic control)\b/i },
  { design: 'PSM',          level: 3, re: /\b(propensity[- ]score|matching estimator)\b/i },
  { design: 'Observational',level: 2, re: /\b(observational|cross[- ]sectional|panel data|fixed effects)\b/i },
  { design: 'Qualitative',  level: 1, re: /\b(qualitative|case study|ethnograph|interview|focus group)\b/i },
];

function classifyMethodology(text) {
  for (const p of SMS_PATTERNS) {
    if (p.re.test(text)) {
      return {
        smsLevel: p.level,
        design: p.design,
        causalStrength: p.level >= 4 ? 'high' : p.level >= 3 ? 'moderate' : 'limited',
        smsMethod: 'keyword_scan',
        smsRationale: `matched pattern: ${p.design}`,
      };
    }
  }
  return { smsLevel: null, design: null, causalStrength: null, smsMethod: null, smsRationale: null };
}

function buildRow(paper) {
  const text = `${paper.title || ''} ${paper.abstract || ''}`;
  const sms = classifyMethodology(text);
  const sclTopics = classifyTopics(paper.title || '', paper.abstract || '');
  const repec = lookupRepecRank(paper.seriesVenue, paper.venue);

  return {
    id: paper.id,
    title: paper.title,
    canonical_doi: paper.doi || null,
    year: paper.year || null,
    abstract: paper.abstract || null,
    citation_count: paper.citationCount ?? null,
    authors: paper.authors || [],
    publication_date: paper.publicationDate || null,
    is_open_access: paper.isOpenAccess !== false,
    open_access_pdf_url: paper.openAccessPdfUrl || null,
    fields_of_study: paper.fieldsOfStudy || [],
    venue: paper.venue || paper.seriesVenue,
    journal_issn: null,
    url: paper.url || null,
    source: 'repec',
    corpus_source: 'repec_bulk',
    sms_level: sms.smsLevel,
    methodology_design: sms.design,
    causal_strength: sms.causalStrength,
    sms_method: sms.smsMethod,
    sms_rationale: sms.smsRationale,
    repec_rank: repec.rank ?? null,
    repec_percentile: repec.percentile ?? null,
    embedding: null,
    corpus_imported_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    raw_data: {
      scl_topics: sclTopics,        // copy to scl_topics[] column post-migration
      source_type: 'working_paper', // copy to source_type column post-migration
      series_key: paper.seriesKey,
      series_venue: paper.seriesVenue,
      openalex_type: paper.oaType,
    },
  };
}

async function upsertBatch(papers) {
  const BATCH = 50;
  let imported = 0, errors = 0;
  for (let i = 0; i < papers.length; i += BATCH) {
    const slice = papers.slice(i, i + BATCH);
    const rows = slice.map(buildRow);
    const { error } = await supabase
      .from('works')
      .upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
    if (error) {
      errors += rows.length;
      console.error(`\n  Upsert error: ${error.message}`);
    } else {
      imported += rows.length;
    }
    await sleep(120);
  }
  return { imported, errors };
}

// ---------------------------------------------------------------------------
// Existing-DOI loader (paginated)
// ---------------------------------------------------------------------------
async function loadExisting() {
  const dois = new Set();
  const ids = new Set();
  let from = 0;
  const PAGE = 1000; // PostgREST default max-rows
  while (true) {
    const { data, error } = await supabase
      .from('works')
      .select('id,canonical_doi')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error('Existing-load error:', error.message); break; }
    if (!data?.length) break;
    for (const r of data) {
      if (r.canonical_doi) dois.add(r.canonical_doi.toLowerCase());
      if (r.id) ids.add(r.id);
    }
    if (data.length < PAGE) break;
    from += PAGE;
    if (from % 20000 === 0) process.stdout.write(`\r  loading existing… ${ids.size}`);
  }
  console.log(`\r  existing DOIs/IDs loaded: ${ids.size} ids, ${dois.size} dois`);
  return { dois, ids };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const series = getSelectedSeries();
  console.log(`=== RePEc Working Papers Import ===`);
  console.log(`Series: ${series.map(([k]) => k).join(', ')}`);
  console.log(`Years: last ${YEARS} (from ${YEAR_FROM})`);
  console.log(`Dry run: ${DRY_RUN}\n`);

  const { dois: existingDois, ids: existingIds } = await loadExisting();
  console.log('');

  let totalNew = 0, totalImported = 0, totalErrors = 0;
  const summary = [];

  for (const [key, cfg] of series) {
    console.log(`\n→ ${key.toUpperCase()} — ${cfg.venue}`);
    let seriesNew = 0, seriesImported = 0, seriesErrors = 0;

    for (const filter of cfg.filters) {
      console.log(`  filter: ${filter}`);
      const papers = await fetchFilter(filter, existingDois, existingIds, key, cfg);
      console.log(`\r    [${key}] +${papers.length} new from this filter${' '.repeat(20)}`);
      seriesNew += papers.length;

      if (!DRY_RUN && papers.length > 0) {
        const { imported, errors } = await upsertBatch(papers);
        seriesImported += imported;
        seriesErrors += errors;
        console.log(`    inserted: ${imported}, errors: ${errors}`);
      }
    }

    totalNew += seriesNew;
    totalImported += seriesImported;
    totalErrors += seriesErrors;
    summary.push({ key, venue: cfg.venue, new: seriesNew, imported: seriesImported, errors: seriesErrors });
  }

  console.log(`\n=== Summary ===`);
  for (const s of summary) {
    console.log(`  ${s.key.padEnd(6)} ${String(s.imported).padStart(6)} imported / ${String(s.new).padStart(6)} new   (${s.venue})`);
  }
  console.log(`  ${'TOTAL'.padEnd(6)} ${String(totalImported).padStart(6)} imported / ${String(totalNew).padStart(6)} new`);
  if (totalErrors) console.log(`  errors: ${totalErrors}`);
  console.log('\nNext: run scripts/backfill-fast.mjs to embed these new papers.');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error(err); process.exit(1); });
