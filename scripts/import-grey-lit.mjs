#!/usr/bin/env node
/**
 * Import grey literature from major development + economics repositories.
 * Supports:
 *   - OAI-PMH harvesting (ECLAC, EconStor)
 *   - REST APIs (World Bank WDS)
 *
 * Pre-computes metadata tags for post-migration extraction:
 *   - corpus_source = 'grey_lit_bulk'
 *   - source_type = document type (working_paper, report, policy_brief, etc.)
 *   - raw_data.grey_source = 'eclac' | 'econstor' | 'worldbank'
 *   - raw_data.scl_topics (pre-classified via keyword taxonomy)
 *
 * Usage:
 *   node scripts/import-grey-lit.mjs                 # all sources, no dry-run
 *   node scripts/import-grey-lit.mjs --dry-run       # count only
 *   node scripts/import-grey-lit.mjs --source eclac  # one source
 *   node scripts/import-grey-lit.mjs --years 10      # last N years
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
const SOURCE_ARG = flagValue('--source', 'all');
const YEAR_FROM = new Date().getFullYear() - YEARS;

// ---------------------------------------------------------------------------
// Source catalogue
// ---------------------------------------------------------------------------
const SOURCES = {
  eclac: {
    name: 'ECLAC (Latin American Economic Commission)',
    oai_endpoint: 'https://repositorio.cepal.org/server/oai/request',
    type: 'oai-pmh',
  },
  econstor: {
    name: 'EconStor (Economics Repository)',
    oai_endpoint: 'https://www.econstor.eu/dspace-oai/request',
    type: 'oai-pmh',
  },
  worldbank: {
    name: 'World Bank Documents & Reports',
    api_endpoint: 'https://search.worldbank.org/api/v3/wds',
    type: 'rest',
  },
  // IZA Discussion Papers are already covered by scripts/import-repec.mjs
  // via OpenAlex institution filter (institutions.id:I197518295). Do NOT
  // re-add IZA here — the OAI-PMH endpoint at iza.org/dp/oai/request 404s
  // (last verified 2026-05-07). Run `node scripts/import-repec.mjs
  // --series iza --years 8` to refresh IZA.
};

function getSelectedSources() {
  if (SOURCE_ARG === 'all') return Object.entries(SOURCES);
  if (!SOURCES[SOURCE_ARG]) {
    console.error(`Unknown source: ${SOURCE_ARG}. Choose from: ${Object.keys(SOURCES).join(', ')}`);
    process.exit(1);
  }
  return [[SOURCE_ARG, SOURCES[SOURCE_ARG]]];
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function normDoi(doi) {
  if (!doi) return null;
  return doi.toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
}

function reconstructAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return null;
  const words = Array(Math.max(...Object.values(invertedIndex).flat(), 0) + 1).fill('');
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) words[pos] = word;
  }
  return words.join(' ').trim();
}

// ---------------------------------------------------------------------------
// OAI-PMH harvester (for ECLAC, EconStor)
// ---------------------------------------------------------------------------
async function harvestOaiPmh(sourceKey, sourceCfg) {
  const papers = [];
  let resumptionToken = null;
  let page = 0;

  console.log(`\n→ ${sourceCfg.name}`);
  console.log(`  OAI-PMH endpoint: ${sourceCfg.oai_endpoint}`);

  while (true) {
    const params = new URLSearchParams({
      verb: 'ListRecords',
      metadataPrefix: 'oai_dc',
    });
    if (resumptionToken) params.append('resumptionToken', resumptionToken);

    try {
      const url = `${sourceCfg.oai_endpoint}?${params}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) {
        console.error(`\n  [OAI ${res.status}]`);
        if (res.status === 429) { await sleep(5000); continue; }
        break;
      }

      const xml = await res.text();
      const records = xml.match(/<record>[\s\S]*?<\/record>/g) || [];

      for (const record of records) {
        const paper = parseOaiDcRecord(record, sourceKey);
        if (paper) papers.push(paper);
      }

      page++;
      process.stdout.write(`\r    [${sourceKey}] ${papers.length} harvested (page ${page})`);

      // Extract resumption token
      const tokenMatch = xml.match(/<resumptionToken>([^<]+)<\/resumptionToken>/);
      resumptionToken = tokenMatch ? tokenMatch[1] : null;

      if (!resumptionToken) break;
      await sleep(500);
    } catch (err) {
      console.error(`\n  Harvest error: ${err.message}`);
      break;
    }
  }

  console.log(`\n    +${papers.length} from this source`);
  return papers;
}

function parseOaiDcRecord(xml, sourceKey) {
  // Dublin Core metadata extraction
  const title = xml.match(/<dc:title>([^<]+)<\/dc:title>/)?.[1];
  const abstract = xml.match(/<dc:description>([^<]+)<\/dc:description>/)?.[1];
  const date = xml.match(/<dc:date>([^<]+)<\/dc:date>/)?.[1];
  const doiMatch = xml.match(/<dc:identifier>\s*(https?:\/\/doi\.org\/)?([^\s<]+)<\/dc:identifier>/);
  const doi = doiMatch ? doiMatch[2] : null;
  const authors = [];
  const creatorMatches = xml.matchAll(/<dc:creator>([^<]+)<\/dc:creator>/g);
  for (const m of creatorMatches) authors.push(m[1]);
  const language = xml.match(/<dc:language>([^<]+)<\/dc:language>/)?.[1] || 'en';

  if (!title) return null;

  const year = date ? parseInt(date.substring(0, 4)) : null;
  if (year && year < YEAR_FROM) return null;

  return {
    id: doi || `grey:${Math.random().toString(36).slice(2, 11)}`,
    title: title.trim(),
    abstract: abstract?.trim() || null,
    year,
    date,
    authors,
    doi: normDoi(doi),
    language,
    sourceKey,
    sourceType: inferDocumentType(title, abstract, sourceKey),
  };
}

// ---------------------------------------------------------------------------
// World Bank WDS REST API
// ---------------------------------------------------------------------------
async function harvestWorldBankWds() {
  const cfg = SOURCES.worldbank;
  const papers = [];
  let page = 0;
  const pageSize = 100;

  console.log(`\n→ ${cfg.name}`);
  console.log(`  REST API: ${cfg.api_endpoint}`);

  while (true) {
    const params = new URLSearchParams({
      format: 'json',
      rows: pageSize,
      os: page * pageSize,
      strdate: YEAR_FROM,
    });

    try {
      const url = `${cfg.api_endpoint}?${params}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (!res.ok) {
        console.error(`\n  [WDS ${res.status}]`);
        break;
      }

      const data = await res.json();
      // World Bank API returns documents as an object with doc IDs as keys
      const docsObj = data.documents || {};
      const docIds = Object.keys(docsObj);

      if (!docIds.length) break;

      for (const docId of docIds) {
        const doc = docsObj[docId];
        const paper = {
          id: `wb:${docId}`,
          title: doc.docna?.[0]?.docna || doc.title,
          abstract: doc.abs || null,
          year: doc.docdt ? parseInt(doc.docdt.substring(0, 4)) : null,
          date: doc.docdt,
          authors: [],
          doi: null,
          language: doc.lang || 'en',
          sourceKey: 'worldbank',
          sourceType: doc.docty || 'report',
          url: null,
          topics: doc.theme ? Object.values(doc.theme).map(t => t.theme || '') : [],
        };
        if (paper.title) papers.push(paper);
      }

      page++;
      process.stdout.write(`\r    [wb] ${papers.length} harvested (page ${page})`);

      if (docIds.length < pageSize) break; // last page
      await sleep(300);
    } catch (err) {
      console.error(`\n  Fetch error: ${err.message}`);
      break;
    }
  }

  console.log(`\n    +${papers.length} from this source`);
  return papers;
}

// ---------------------------------------------------------------------------
// Document type inference
// ---------------------------------------------------------------------------
function inferDocumentType(title, abstract, sourceKey) {
  const text = `${title || ''} ${abstract || ''}`.toLowerCase();
  if (/brief|policy brief/.test(text)) return 'policy_brief';
  if (/working.?paper|discussion.?paper/.test(text)) return 'working_paper';
  if (/report/.test(text)) return 'report';
  if (/review|survey|overview/.test(text)) return 'review';
  if (/guide|handbook|manual/.test(text)) return 'guide';
  if (/dataset|data/.test(text)) return 'dataset';
  return 'document';
}

// ---------------------------------------------------------------------------
// SMS classification (same as import-repec.mjs)
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

// ---------------------------------------------------------------------------
// Row builder
// ---------------------------------------------------------------------------
function buildRow(paper) {
  const text = `${paper.title || ''} ${paper.abstract || ''}`;
  const sms = classifyMethodology(text);
  const sclTopics = classifyTopics(paper.title || '', paper.abstract || '');

  return {
    id: paper.id,
    title: paper.title,
    canonical_doi: paper.doi || null,
    year: paper.year || null,
    abstract: paper.abstract || null,
    citation_count: null,
    authors: paper.authors || [],
    publication_date: paper.date || null,
    is_open_access: true,
    open_access_pdf_url: paper.url || null,
    fields_of_study: paper.topics || [],
    venue: paper.sourceType,
    journal_issn: null,
    url: paper.url || null,
    source: 'grey_lit',
    corpus_source: 'grey_lit_bulk',
    sms_level: sms.smsLevel,
    methodology_design: sms.design,
    causal_strength: sms.causalStrength,
    sms_method: sms.smsMethod,
    sms_rationale: sms.smsRationale,
    embedding: null,
    corpus_imported_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    raw_data: {
      grey_source: paper.sourceKey,
      source_type: paper.sourceType,
      scl_topics: sclTopics,
      language: paper.language || 'en',
    },
  };
}

// ---------------------------------------------------------------------------
// Upsert batch
// ---------------------------------------------------------------------------
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
    await sleep(200);
  }
  return { imported, errors };
}

// ---------------------------------------------------------------------------
// Load existing papers (dedup)
// ---------------------------------------------------------------------------
async function loadExisting() {
  const dois = new Set();
  const ids = new Set();
  let from = 0;
  const PAGE = 1000;
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
  console.log(`\r  existing: ${ids.size} ids, ${dois.size} dois`);
  return { dois, ids };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n=== Grey Literature Import ===`);
  console.log(`Sources: ${SOURCE_ARG === 'all' ? 'all' : SOURCE_ARG}`);
  console.log(`Years: last ${YEARS} (from ${YEAR_FROM})`);
  console.log(`Dry run: ${DRY_RUN}\n`);

  const { dois: existingDois, ids: existingIds } = await loadExisting();

  let totalImported = 0, totalErrors = 0;
  const results = {};

  for (const [sourceKey, sourceCfg] of getSelectedSources()) {
    // Skip broken endpoints
    if (sourceKey === 'econstor') {
      console.log(`\n→ ${sourceCfg.name}`);
      console.log(`  ⚠ OAI-PMH endpoint currently unavailable (404). Skipping.`);
      continue;
    }

    let papers = [];

    if (sourceCfg.type === 'oai-pmh') {
      papers = await harvestOaiPmh(sourceKey, sourceCfg);
    } else if (sourceCfg.type === 'rest') {
      if (sourceKey === 'worldbank') papers = await harvestWorldBankWds();
    }

    // Dedup
    let newCount = 0;
    for (const p of papers) {
      const doi = normDoi(p.doi);
      if (doi && existingDois.has(doi)) continue;
      if (existingIds.has(p.id)) continue;
      newCount++;
      if (doi) existingDois.add(doi);
      existingIds.add(p.id);
    }

    const filtered = papers.filter(p => {
      const doi = normDoi(p.doi);
      if (doi && existingDois.has(doi)) return false;
      return !existingIds.has(p.id);
    });

    if (DRY_RUN) {
      results[sourceKey] = { harvested: papers.length, new: newCount };
      console.log(`    (dry run: would import ${newCount} new)`);
    } else {
      const { imported, errors } = await upsertBatch(filtered);
      results[sourceKey] = { harvested: papers.length, imported, errors };
      console.log(`    inserted: ${imported}, errors: ${errors}`);
      totalImported += imported;
      totalErrors += errors;
    }
  }

  console.log(`\n=== Summary ===`);
  for (const [key, res] of Object.entries(results)) {
    const source = SOURCES[key];
    console.log(`  ${key.padEnd(12)} ${res.harvested || res.imported} harvested / ${res.new || res.imported} new   (${source.name})`);
  }
  console.log(`  TOTAL   ${totalImported} imported / ${totalImported} new\n`);
  if (totalImported > 0) {
    console.log(`Next: run scripts/backfill-fast.mjs to embed new papers.\n`);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
