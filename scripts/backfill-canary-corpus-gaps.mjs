#!/usr/bin/env node
/**
 * Backfill canonical/canary papers that eval diagnostics classify as
 * NOT_IN_CORPUS. Fetches metadata by DOI when possible; for known DOI-version
 * aliases, clones the existing corpus row into the canary DOI and records the
 * source DOI in raw_data.alias_source_doi.
 *
 * Usage:
 *   node scripts/backfill-canary-corpus-gaps.mjs --dry-run
 *   node scripts/backfill-canary-corpus-gaps.mjs
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config();

const DRY_RUN = process.argv.includes('--dry-run');

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://llm.iotaimpact.com').replace(/\/+$/, '');
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
const EMBED_MODEL = process.env.OLLAMA_EMBEDDING_MODEL || 'qwen3-embedding:8b';
const EMBED_URL = `${LLM_BASE_URL}/v1/embeddings`;

const TARGETS = [
  { queryId: 'q01-teacher-incentives-hard-staff', id: 'peru-altruism-money-jle-2024', doi: '10.1086/730483', title: 'Altruism or Money? Reducing Teacher Sorting Using Behavioural Strategies', year: 2024, aliasSourceDoi: '10.18235/0002625' },
  { queryId: 'q04-minwage-informality-lac', id: 'comola-mello-2011', doi: '10.1111/j.1475-4991.2011.00455.x', title: 'How Does Decentralized Minimum Wage Setting Affect Employment and Informality? Evidence from Indonesia', year: 2011 },
  { queryId: 'q05-cct-school-attendance-learning', id: 'behrman-sengupta-todd-2005', doi: '10.1596/1813-9450-3402', title: 'Progressing through PROGRESA: An Impact Assessment of a School Subsidy Experiment in Rural Mexico', year: 2005, aliasSourceDoi: '10.1086/431263' },
  { queryId: 'q06-migration-native-wages', id: 'altonji-card-1991', doi: '10.7208/9780226117799-007', title: 'The Effects of Immigration on the Labor Market Outcomes of Less-Skilled Natives', year: 1991 },
  { queryId: 'q06-migration-native-wages', id: 'ottaviano-peri-2012', doi: '10.1093/jeea/jvs019', title: 'Rethinking the Effect of Immigration on Wages', year: 2012, aliasSourceDoi: '10.1111/j.1542-4774.2011.01052.x' },
  { queryId: 'q07-childcare-female-labor-participation', id: 'baker-gruber-milligan-2008-canada', doi: '10.1086/528898', title: 'Universal Child Care, Maternal Labor Supply, and Family Well-Being', year: 2008 },
  { queryId: 'q07-childcare-female-labor-participation', id: 'havnes-mogstad-2011-norway', doi: '10.1257/app.3.2.97', title: "No Child Left Behind: Subsidized Child Care and Children's Long-Run Outcomes", year: 2011, aliasSourceDoi: '10.1257/pol.3.2.97' },
  { queryId: 'q09-early-nutrition-adult-earnings', id: 'hoddinott-2008-guatemala', doi: '10.1016/s0140-6736(08)60205-6', title: 'Effect of a Nutrition Intervention during Early Childhood on Economic Productivity in Guatemalan Adults', year: 2008 },
  { queryId: 'q11-teacher-quality-student-learning', id: 'rockoff-2004', doi: '10.1257/0002828041302244', title: 'The Impact of Individual Teachers on Student Achievement: Evidence from Panel Data', year: 2004 },
  { queryId: 'q12-climate-shocks-poverty-food', id: 'schlenker-roberts-2009', doi: '10.1073/pnas.0906865106', title: 'Nonlinear Temperature Effects Indicate Severe Damages to U.S. Crop Yields under Climate Change', year: 2009 },
  { queryId: 'q17-migration-remittances-children-education', id: 'yang-2008-philippines', doi: '10.1111/j.1468-0297.2008.02134.x', title: "International Migration, Remittances and Household Investment: Evidence from Philippine Migrants' Exchange Rate Shocks", year: 2008 },
  { queryId: 'q19-inequality-social-mobility-lac', id: 'neidhoefer-serrano-2018-lac-mobility', doi: '10.1257/mac.20150212', title: 'Intergenerational Earnings Persistence and the Provision of Public Goods: Evidence from Latin America', year: 2018 },
  { queryId: 'q20-school-vs-household-learning', id: 'hanushek-woessmann-2011', doi: '10.1016/b978-0-444-53429-3.00002-8', title: 'The Economics of International Differences in Educational Achievement', year: 2011 },
  { queryId: 'q21-ai-adoption-wage-inequality', id: 'frey-osborne-2017', doi: '10.1016/j.techfore.2016.08.019', title: 'The Future of Employment: How Susceptible Are Jobs to Computerisation?', year: 2017 },
  { queryId: 'q22-chronic-poverty-interventions', id: 'banerjee-etal-2015-graduation-six-countries', doi: '10.1126/science.1260799', title: 'A Multifaceted Program Causes Lasting Progress for the Very Poor: Evidence from Six Countries', year: 2015 },
  { queryId: 'q23-informality-productivity-bidirectional', id: 'de-paula-scheinkman-2011-informal-formal', doi: '10.1257/mac.3.4.195', title: 'Value-Added Taxes, Chain Effects, and Informality', year: 2011, aliasSourceDoi: '10.1257/mac.2.4.195' },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normDoi(value) {
  return String(value || '').toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim();
}

function stripJats(value) {
  return String(value || '')
    .replace(/<jats:[^>]+>/g, '')
    .replace(/<\/jats:[^>]+>/g, '')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/^\s*abstract[\s:.\-—]*/i, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

function reconstructAbstract(inverted) {
  if (!inverted || typeof inverted !== 'object') return null;
  const positions = [];
  for (const [word, posList] of Object.entries(inverted)) {
    if (!Array.isArray(posList)) continue;
    for (const pos of posList) positions.push([pos, word]);
  }
  if (!positions.length) return null;
  return positions.sort((a, b) => a[0] - b[0]).map(([, word]) => word).join(' ');
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function yearFromDateParts(parts) {
  return parts?.['date-parts']?.[0]?.[0] ?? null;
}

function dateFromParts(parts) {
  const p = parts?.['date-parts']?.[0];
  if (!p?.[0]) return null;
  const [y, m = 1, d = 1] = p;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function publicationTypeFrom(type, venue) {
  const t = String(type || '').toLowerCase();
  const v = String(venue || '').toLowerCase();
  if (t.includes('journal') || t === 'article' || t === 'journal-article') return 'journal_article';
  if (t.includes('book-chapter') || t.includes('book')) return 'other';
  if (v.includes('working paper')) return 'working_paper';
  return 'journal_article';
}

function titleScore(expected, actual) {
  const stop = new Set('the of and in to a an for from with on are is do does how evidence using during under by into or'.split(' '));
  const tokens = (value) => new Set(String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 3 && !stop.has(t)));
  const a = tokens(expected);
  const b = tokens(actual);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const t of a) if (b.has(t)) overlap += 1;
  return overlap / Math.min(a.size, b.size);
}

function acceptFetchedRow(target, row) {
  const score = titleScore(target.title, row.title);
  if (score < 0.6) {
    console.warn(`  [skip] ${target.id}: fetched title mismatch score=${score.toFixed(2)} "${String(row.title || '').slice(0, 90)}"`);
    return false;
  }
  return true;
}

function venueKind(publicationType, venue) {
  if (publicationType === 'journal_article') return 'journal';
  if (publicationType === 'working_paper') return 'working_paper_series';
  if (String(venue || '').toLowerCase().includes('book')) return 'book_series';
  return 'other';
}

function rowFromOpenAlex(target, oa) {
  const doi = normDoi(oa.doi || target.doi);
  const loc = oa.primary_location || {};
  const source = loc.source || oa.host_venue || {};
  const abstract = reconstructAbstract(oa.abstract_inverted_index);
  const venue = source.display_name || oa.primary_location?.source?.display_name || null;
  const publicationType = publicationTypeFrom(oa.type, venue);
  return {
    id: doi,
    title: oa.title || target.title,
    canonical_doi: doi,
    year: oa.publication_year || target.year || null,
    abstract,
    citation_count: oa.cited_by_count ?? null,
    authors: (oa.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
    publication_date: oa.publication_date || null,
    is_open_access: Boolean(oa.open_access?.is_oa),
    open_access_pdf_url: oa.open_access?.oa_url || loc.pdf_url || null,
    fields_of_study: (oa.concepts || []).slice(0, 8).map((c) => c.display_name).filter(Boolean),
    venue,
    journal_issn: first(source.issn) || source.issn_l || null,
    url: oa.open_access?.oa_url || loc.landing_page_url || `https://doi.org/${doi}`,
    source: 'openalex',
    corpus_source: 'canary_gap_backfill',
    publication_type: publicationType,
    publication_type_method: 'canary_openalex',
    publication_type_confidence: 0.9,
    venue_kind: venueKind(publicationType, venue),
    raw_data: { canary_id: target.id, query_id: target.queryId, backfill_source: 'openalex' },
  };
}

function rowFromCrossref(target, item) {
  const doi = normDoi(item.DOI || target.doi);
  const venue = first(item['container-title']) || null;
  const publicationType = publicationTypeFrom(item.type, venue);
  const abstract = stripJats(item.abstract);
  return {
    id: doi,
    title: first(item.title) || target.title,
    canonical_doi: doi,
    year: yearFromDateParts(item.published || item['published-print'] || item['published-online']) || target.year || null,
    abstract,
    citation_count: item['is-referenced-by-count'] ?? null,
    authors: (item.author || []).map((a) => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean),
    publication_date: dateFromParts(item.published || item['published-print'] || item['published-online']),
    is_open_access: false,
    open_access_pdf_url: null,
    fields_of_study: [],
    venue,
    journal_issn: first(item.ISSN) || null,
    url: item.URL || `https://doi.org/${doi}`,
    source: 'crossref',
    corpus_source: 'canary_gap_backfill',
    publication_type: publicationType,
    publication_type_method: 'canary_crossref',
    publication_type_confidence: 0.85,
    venue_kind: venueKind(publicationType, venue),
    raw_data: { canary_id: target.id, query_id: target.queryId, backfill_source: 'crossref' },
  };
}

function rowFromSemanticScholar(target, item) {
  const doi = normDoi(item.externalIds?.DOI || target.doi);
  const venue = item.venue || null;
  const publicationType = publicationTypeFrom(item.publicationTypes?.[0], venue);
  return {
    id: doi,
    title: item.title || target.title,
    canonical_doi: doi,
    year: item.year || target.year || null,
    abstract: item.abstract || null,
    citation_count: item.citationCount ?? null,
    authors: (item.authors || []).map((a) => a.name).filter(Boolean),
    publication_date: item.publicationDate || null,
    is_open_access: Boolean(item.openAccessPdf?.url),
    open_access_pdf_url: item.openAccessPdf?.url || null,
    fields_of_study: item.fieldsOfStudy || [],
    venue,
    journal_issn: null,
    url: item.url || `https://doi.org/${doi}`,
    source: 'semantic_scholar',
    corpus_source: 'canary_gap_backfill',
    publication_type: publicationType,
    publication_type_method: 'canary_semantic_scholar',
    publication_type_confidence: 0.8,
    venue_kind: venueKind(publicationType, venue),
    raw_data: { canary_id: target.id, query_id: target.queryId, backfill_source: 'semantic_scholar' },
  };
}

function fallbackRow(target) {
  const publicationType = target.doi.includes('978') || target.doi.includes('b978') ? 'other' : 'journal_article';
  return {
    id: normDoi(target.doi),
    title: target.title,
    canonical_doi: normDoi(target.doi),
    year: target.year || null,
    abstract: null,
    citation_count: null,
    authors: [],
    publication_date: target.year ? `${target.year}-01-01` : null,
    is_open_access: false,
    open_access_pdf_url: null,
    fields_of_study: [],
    venue: null,
    journal_issn: null,
    url: `https://doi.org/${normDoi(target.doi)}`,
    source: 'canary_manual',
    corpus_source: 'canary_gap_backfill',
    publication_type: publicationType,
    publication_type_method: 'canary_manual_fallback',
    publication_type_confidence: 0.55,
    venue_kind: venueKind(publicationType, null),
    raw_data: { canary_id: target.id, query_id: target.queryId, backfill_source: 'manual_fallback' },
  };
}

async function fetchOpenAlex(target) {
  const url = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(normDoi(target.doi))}?mailto=horizon-scanner@iadb.org`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) return null;
  return rowFromOpenAlex(target, await res.json());
}

async function searchOpenAlexTitle(target) {
  const params = new URLSearchParams({
    search: target.title,
    per_page: '5',
    mailto: 'horizon-scanner@iadb.org',
  });
  const res = await fetch(`https://api.openalex.org/works?${params}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) return null;
  const json = await res.json();
  for (const candidate of json.results || []) {
    const row = rowFromOpenAlex(target, candidate);
    if (acceptFetchedRow(target, row)) {
      row.id = normDoi(target.doi);
      row.canonical_doi = normDoi(target.doi);
      row.raw_data = {
        ...(row.raw_data || {}),
        title_search_source_doi: normDoi(candidate.doi || ''),
      };
      return row;
    }
  }
  return null;
}

async function fetchCrossref(target) {
  const url = `https://api.crossref.org/works/${encodeURIComponent(normDoi(target.doi))}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'HorizonScanner/1.0 (mailto:horizon-scanner@iadb.org)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.message ? rowFromCrossref(target, json.message) : null;
}

async function searchCrossrefTitle(target) {
  const params = new URLSearchParams({
    'query.title': target.title,
    rows: '5',
  });
  const res = await fetch(`https://api.crossref.org/works?${params}`, {
    headers: { 'User-Agent': 'HorizonScanner/1.0 (mailto:horizon-scanner@iadb.org)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return null;
  const json = await res.json();
  for (const item of json.message?.items || []) {
    const row = rowFromCrossref(target, item);
    if (acceptFetchedRow(target, row)) {
      row.id = normDoi(target.doi);
      row.canonical_doi = normDoi(target.doi);
      row.raw_data = {
        ...(row.raw_data || {}),
        title_search_source_doi: normDoi(item.DOI || ''),
      };
      return row;
    }
  }
  return null;
}

async function fetchSemanticScholar(target) {
  const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(normDoi(target.doi))}?fields=title,abstract,year,venue,publicationDate,citationCount,externalIds,authors,fieldsOfStudy,publicationTypes,openAccessPdf,url`;
  const headers = {};
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) headers['x-api-key'] = process.env.SEMANTIC_SCHOLAR_API_KEY;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) return null;
  return rowFromSemanticScholar(target, await res.json());
}

async function findExistingByDoi(doi) {
  const { data, error } = await supabase
    .from('works')
    .select('*')
    .eq('canonical_doi', normDoi(doi))
    .limit(1);
  if (error) throw new Error(`existing DOI lookup failed: ${error.message}`);
  return data?.[0] || null;
}

function cloneAliasRow(target, existing) {
  const doi = normDoi(target.doi);
  return {
    ...existing,
    id: doi,
    canonical_doi: doi,
    title: existing.title || target.title,
    year: existing.year || target.year || null,
    source: existing.source || 'canary_alias',
    corpus_source: 'canary_gap_backfill',
    raw_data: {
      ...(existing.raw_data || {}),
      canary_id: target.id,
      query_id: target.queryId,
      backfill_source: 'doi_alias_clone',
      alias_source_doi: normDoi(target.aliasSourceDoi),
    },
    updated_at: new Date().toISOString(),
    corpus_imported_at: new Date().toISOString(),
  };
}

async function embedRow(row) {
  if (row.embedding) return row;
  if (!LLM_API_KEY) throw new Error('LLM_API_KEY missing; cannot embed');
  const text = `${row.title || ''}\n\n${row.abstract || ''}`.trim().slice(0, 3000);
  const res = await fetch(EMBED_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`embed HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const vec = json.data?.[0]?.embedding;
  if (!Array.isArray(vec) || vec.length === 0) throw new Error(`embed returned no vector: ${JSON.stringify(json).slice(0, 200)}`);
  return { ...row, embedding: `[${vec.join(',')}]` };
}

function cleanForUpsert(row) {
  const allowed = [
    'id', 'title', 'abstract', 'year', 'citation_count', 'canonical_doi',
    'authors', 'publication_date', 'is_open_access', 'open_access_pdf_url',
    'fields_of_study', 'venue', 'journal_issn', 'url', 'source',
    'sms_level', 'methodology_design', 'causal_strength', 'sms_method',
    'embedding', 'corpus_source', 'corpus_imported_at', 'updated_at',
    'publication_type', 'publication_type_method', 'publication_type_confidence',
    'source_family', 'venue_kind', 'raw_data',
  ];
  const out = {};
  for (const key of allowed) {
    if (row[key] !== undefined) out[key] = row[key];
  }
  out.updated_at = new Date().toISOString();
  out.corpus_imported_at = row.corpus_imported_at || new Date().toISOString();
  return out;
}

async function buildRow(target) {
  const existing = await findExistingByDoi(target.doi);
  if (existing) return { status: 'already_present', row: existing };

  let row = await fetchOpenAlex(target);
  let source = 'openalex';
  if (row && !acceptFetchedRow(target, row)) row = null;
  if (!row) {
    row = await fetchCrossref(target);
    source = 'crossref';
    if (row && !acceptFetchedRow(target, row)) row = null;
  }
  if (!row) {
    row = await fetchSemanticScholar(target);
    source = 'semantic_scholar';
    if (row && !acceptFetchedRow(target, row)) row = null;
  }
  if (!row && target.aliasSourceDoi) {
    const alias = await findExistingByDoi(target.aliasSourceDoi);
    if (alias) {
      row = cloneAliasRow(target, alias);
      source = 'alias_clone';
    }
  }
  if (!row) {
    row = await searchOpenAlexTitle(target);
    source = 'openalex_title_search';
  }
  if (!row) {
    row = await searchCrossrefTitle(target);
    source = 'crossref_title_search';
  }
  if (!row) {
    row = fallbackRow(target);
    source = 'manual_fallback';
  }

  row.raw_data = {
    ...(row.raw_data || {}),
    canary_expected_title: target.title,
    canary_expected_year: target.year,
  };

  return { status: source, row: await embedRow(row) };
}

async function main() {
  console.log(`Canary corpus-gap backfill; dry_run=${DRY_RUN}`);
  const summary = {};
  for (const target of TARGETS) {
    try {
      const { status, row } = await buildRow(target);
      summary[status] = (summary[status] || 0) + 1;
      const abstractLen = String(row.abstract || '').length;
      const hasEmbedding = Boolean(row.embedding);
      console.log(`- ${target.id}: ${status} doi=${row.canonical_doi} year=${row.year || 'n/a'} venue=${row.venue || 'n/a'} abstract=${abstractLen} embedding=${hasEmbedding}`);
      if (!DRY_RUN && status !== 'already_present') {
        const { error } = await supabase.from('works').upsert(cleanForUpsert(row), { onConflict: 'id' });
        if (error) throw new Error(`upsert failed: ${error.message}`);
        await sleep(500);
      }
    } catch (error) {
      summary.error = (summary.error || 0) + 1;
      console.error(`- ${target.id}: ERROR ${error.message}`);
    }
  }
  console.log('\nSummary');
  for (const [key, value] of Object.entries(summary).sort()) console.log(`  ${key}: ${value}`);
}

main().catch((error) => {
  console.error('[backfill-canary-corpus-gaps] failed:', error.stack || error.message);
  process.exit(1);
});
