#!/usr/bin/env node
/**
 * Import J-PAL replication packages from Harvard Dataverse.
 * Indexes metadata only (title + description + intervention + geography);
 * the full datasets stay on Dataverse, linked via DOI.
 *
 * Pulls from two related Dataverse subtrees:
 *   - jpal  (Abdul Latif Jameel Poverty Action Lab) ~ 130 datasets
 *   - ipa   (Innovations for Poverty Action — sister org) ~ 600 datasets
 *
 * Tags rows with:
 *   - corpus_source = 'jpal_index'
 *   - source        = 'dataverse'
 *   - venue         = 'J-PAL Replication Data' or 'IPA Replication Data'
 *   - methodology_design = 'RCT' (default — J-PAL/IPA = RCTs)
 *   - sms_level     = 5
 *   - raw_data.geographic_coverage  (countries)
 *   - raw_data.keywords            (intervention categories)
 *   - raw_data.related_papers      (linked publication URLs)
 *   - raw_data.scl_topics          (pre-computed)
 *   - raw_data.source_type         = 'replication_dataset'
 *
 * Usage:
 *   node scripts/import-jpal.mjs              # both subtrees
 *   node scripts/import-jpal.mjs --dry-run
 *   node scripts/import-jpal.mjs --subtree jpal
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { classifyTopics } from './scl-topics.mjs';

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const args = process.argv.slice(2);
const flagValue = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const DRY_RUN = args.includes('--dry-run');
const SUBTREE_ARG = flagValue('--subtree', 'all');

const SUBTREES = {
  jpal: { name: 'J-PAL Replication Data', subtree: 'jpal' },
  ipa:  { name: 'IPA Replication Data',   subtree: 'ipa'  },
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const normDoi = (doi) => doi?.toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '').replace(/^doi:/, '') || null;

async function fetchDataverse(subtreeKey, subtreeCfg) {
  console.log(`\n→ ${subtreeCfg.name}`);
  const papers = [];
  let start = 0;
  const PAGE = 100;
  while (true) {
    const url = `https://dataverse.harvard.edu/api/search?q=*&type=dataset&subtree=${subtreeCfg.subtree}&per_page=${PAGE}&start=${start}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) {
        console.error(`\n  [DV ${res.status}]`);
        break;
      }
      const json = await res.json();
      const items = json.data?.items || [];
      if (!items.length) break;

      for (const item of items) {
        const doi = normDoi(item.global_id);
        const id = doi ? doi : `dvn:${item.versionId}`;
        if (!item.name) continue;

        papers.push({
          id, title: item.name,
          abstract: item.description || null,
          year: item.published_at ? parseInt(item.published_at.slice(0, 4)) : null,
          publicationDate: item.published_at?.slice(0, 10) || null,
          doi,
          authors: item.authors || [],
          url: item.url || null,
          keywords: item.keywords || [],
          subjects: item.subjects || [],
          countries: (item.geographicCoverage || []).map(g => g.country).filter(Boolean),
          relatedMaterial: item.relatedMaterial || [],
          publications: (item.publications || []).map(p => p.url).filter(Boolean),
          venue: subtreeCfg.name,
          subtreeKey,
        });
      }

      start += items.length;
      process.stdout.write(`\r    ${papers.length} harvested (${start}/${json.data?.total_count})`);
      if (start >= (json.data?.total_count || 0)) break;
      await sleep(300);
    } catch (err) {
      console.error(`\n  Fetch error: ${err.message}`);
      break;
    }
  }
  console.log(`\n    +${papers.length} from this subtree`);
  return papers;
}

function buildRow(paper) {
  const sclTopics = classifyTopics(paper.title, paper.abstract || '');
  return {
    id: paper.id,
    title: paper.title,
    canonical_doi: paper.doi || null,
    year: paper.year,
    abstract: paper.abstract,
    citation_count: null,
    authors: paper.authors,
    publication_date: paper.publicationDate,
    is_open_access: true,
    open_access_pdf_url: paper.url,
    fields_of_study: paper.subjects,
    venue: paper.venue,
    journal_issn: null,
    url: paper.url,
    source: 'dataverse',
    corpus_source: 'jpal_index',
    sms_level: 5,
    methodology_design: 'RCT',
    causal_strength: 'high',
    sms_method: 'curated_provenance',
    sms_rationale: `J-PAL/IPA replication package from ${paper.subtreeKey} dataverse — RCT by default`,
    embedding: null,
    corpus_imported_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    raw_data: {
      scl_topics: sclTopics,
      source_type: 'replication_dataset',
      geographic_coverage: paper.countries,
      keywords: paper.keywords,
      related_papers: [...paper.relatedMaterial, ...paper.publications],
      subtree: paper.subtreeKey,
    },
  };
}

async function upsertBatch(papers) {
  const BATCH = 50;
  let imported = 0, errors = 0;
  for (let i = 0; i < papers.length; i += BATCH) {
    const rows = papers.slice(i, i + BATCH).map(buildRow);
    const { error } = await supabase.from('works').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
    if (error) {
      errors += rows.length;
      console.error(`\n  Upsert error: ${error.message}`);
    } else {
      imported += rows.length;
    }
    await sleep(150);
  }
  return { imported, errors };
}

async function loadExisting() {
  const ids = new Set();
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('works').select('id').order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error || !data?.length) break;
    for (const r of data) if (r.id) ids.add(r.id);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`  existing: ${ids.size} ids`);
  return ids;
}

async function main() {
  console.log(`\n=== J-PAL / IPA Replication Index ===`);
  console.log(`Subtree: ${SUBTREE_ARG}`);
  console.log(`Dry run: ${DRY_RUN}\n`);

  const existingIds = await loadExisting();

  const selected = SUBTREE_ARG === 'all' ? Object.entries(SUBTREES) : [[SUBTREE_ARG, SUBTREES[SUBTREE_ARG]]];

  let totalImported = 0;
  for (const [key, cfg] of selected) {
    const papers = await fetchDataverse(key, cfg);
    const filtered = papers.filter(p => !existingIds.has(p.id));
    console.log(`    ${filtered.length} new (${papers.length - filtered.length} dedup)`);

    if (DRY_RUN) {
      console.log(`    (dry run: would import ${filtered.length})`);
    } else if (filtered.length > 0) {
      const { imported, errors } = await upsertBatch(filtered);
      console.log(`    inserted: ${imported}, errors: ${errors}`);
      totalImported += imported;
      filtered.forEach(p => existingIds.add(p.id));
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  TOTAL ${totalImported} imported\n`);
  if (totalImported > 0 && !DRY_RUN) {
    console.log(`Next: run scripts/backfill-fast.mjs to embed new replication packages.\n`);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
