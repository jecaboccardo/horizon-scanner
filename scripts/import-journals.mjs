#!/usr/bin/env node
/**
 * Import papers from top-tier economics and social science journals.
 * Pulls ALL papers from a curated journal whitelist (last 15 years) via OpenAlex.
 * No citation threshold — journal prestige is the filter.
 *
 * Usage:
 *   node scripts/import-journals.mjs                    # full run
 *   node scripts/import-journals.mjs --dry-run          # count only
 *   node scripts/import-journals.mjs --years 5          # last N years only
 *   node scripts/import-journals.mjs --group top5       # specific group
 *
 * Groups: top5, applied, field, lac, review, interdisciplinary, development
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { isDeniedVenue, loadVenueDenylist } from './lib/venue-denylist.mjs';

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const YEARS = parseInt(args[args.indexOf('--years') + 1] || '15');
const GROUP = args[args.indexOf('--group') + 1] || 'all';
const YEAR_FROM = new Date().getFullYear() - YEARS;
const VENUE_DENYLIST = loadVenueDenylist();

// ---------------------------------------------------------------------------
// Journal whitelist — curated for SCL/social science coverage
// ---------------------------------------------------------------------------
const JOURNALS = {
  top5: [
    { issn: '0002-8282', name: 'American Economic Review' },
    { issn: '0033-5533', name: 'Quarterly Journal of Economics' },
    { issn: '0022-3808', name: 'Journal of Political Economy' },
    { issn: '0012-9682', name: 'Econometrica' },
    { issn: '0034-6527', name: 'Review of Economic Studies' },
  ],
  applied: [
    { issn: '0034-6535', name: 'Review of Economics and Statistics' },
    { issn: '0013-0133', name: 'Economic Journal' },
    { issn: '1945-7782', name: 'AEJ: Applied Economics' },
    { issn: '1945-7731', name: 'AEJ: Economic Policy' },
    { issn: '1945-7707', name: 'AEJ: Macroeconomics' },
    { issn: '1542-4766', name: 'Journal of the European Economic Association' },
    { issn: '0266-4658', name: 'Economic Policy' },
  ],
  field: [
    { issn: '0304-3878', name: 'Journal of Development Economics' },
    { issn: '0022-166X', name: 'Journal of Human Resources' },
    { issn: '0734-306X', name: 'Journal of Labor Economics' },
    { issn: '0047-2727', name: 'Journal of Public Economics' },
    { issn: '0167-6296', name: 'Journal of Health Economics' },
    { issn: '0013-0079', name: 'Economic Development and Cultural Change' },
    { issn: '0305-750X', name: 'World Development' },
    { issn: '0927-5371', name: 'Labour Economics' },
    { issn: '0272-7757', name: 'Economics of Education Review' },
    { issn: '1057-9230', name: 'Health Economics' },
    { issn: '0168-8510', name: 'Health Policy' },
    { issn: '0070-3370', name: 'Demography' },
    { issn: '1520-6688', name: 'Journal of Human Capital' },
    { issn: '0895-3309', name: 'Journal of Economic Perspectives' },
  ],
  review: [
    { issn: '0022-0515', name: 'Journal of Economic Literature' },
    { issn: '0895-3309', name: 'Journal of Economic Perspectives' },
    { issn: '0895-3309', name: 'Annual Review of Economics' },
  ],
  lac: [
    { issn: '1529-7470', name: 'Economía (LACEA)' },
    { issn: '0023-8791', name: 'Latin American Research Review' },
    { issn: '0022-216X', name: 'Journal of Latin American Studies' },
    { issn: '0252-0257', name: 'Revista CEPAL / CEPAL Review' },
    { issn: '0258-6444', name: 'Oxford Development Studies' },
  ],
  development: [
    { issn: '0043-7956', name: 'World Bank Economic Review' },
    { issn: '1564-698X', name: 'World Bank Research Observer' },
    { issn: '0022-0388', name: 'Journal of Development Studies' },
    { issn: '0002-9092', name: 'American Journal of Agricultural Economics' },
    { issn: '2053-7778', name: 'Journal of African Economies' },
  ],
  interdisciplinary: [
    { issn: '0277-9536', name: 'Social Science & Medicine' },
    { issn: '2667-193X', name: 'The Lancet Regional Health Americas' },
    { issn: '0098-7921', name: 'Population and Development Review' },
    { issn: '0307-1022', name: 'Population Studies' },
    { issn: '1461-7021', name: 'International Migration Review' },
    { issn: '0020-7187', name: 'International Migration' },
    { issn: '0093-5301', name: 'Journal of Consumer Research' },
    { issn: '0022-3816', name: 'Journal of Politics' },
    { issn: '0003-0554', name: 'American Political Science Review' },
  ],
};

// Build deduplicated list for selected group
function getJournals() {
  const groups = GROUP === 'all' ? Object.values(JOURNALS).flat() : (JOURNALS[GROUP] || []);
  const seen = new Set();
  return groups.filter(j => {
    if (isDeniedVenue(j.name, VENUE_DENYLIST)) return false;
    if (seen.has(j.issn)) return false;
    seen.add(j.issn);
    return true;
  });
}

// ---------------------------------------------------------------------------
// OpenAlex helpers
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

async function fetchJournalPapers(journal, existingDois) {
  const papers = [];
  let cursor = '*';
  let page = 0;

  while (true) {
    const params = new URLSearchParams({
      mailto: OA_EMAIL,
      filter: [
        `primary_location.source.issn:${journal.issn}`,
        `from_publication_date:${YEAR_FROM}-01-01`,
        'type:article',
        'has_abstract:true',
      ].join(','),
      sort: 'publication_date:desc',
      per_page: '200',
      select: 'id,doi,title,abstract_inverted_index,publication_year,publication_date,cited_by_count,authorships,primary_location,open_access,concepts',
      cursor,
    });

    try {
      const res = await fetch(`${OA_URL}?${params}`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) { console.error(`  [OA] HTTP ${res.status} for ${journal.name}`); break; }
      const data = await res.json();
      const results = data.results || [];
      if (!results.length) break;

      for (const raw of results) {
        const doi = normDoi(raw.doi);
        const id = doi || `oa:${raw.id?.match(/\/(W\d+)$/)?.[1]}`;
        if (!id || !raw.title) continue;
        if (doi && existingDois.has(doi)) continue;
        if (doi) existingDois.add(doi);

        const loc = raw.primary_location || {};
        const src = loc.source || {};
        const oa = raw.open_access || {};

        papers.push({
          id, title: raw.title,
          year: raw.publication_year,
          abstract: reconstructAbstract(raw.abstract_inverted_index),
          citationCount: raw.cited_by_count ?? null,
          doi,
          authors: (raw.authorships || []).map(a => a?.author?.display_name).filter(Boolean),
          publicationDate: raw.publication_date,
          isOpenAccess: Boolean(oa.is_oa),
          openAccessPdfUrl: oa.oa_url || null,
          fieldsOfStudy: (raw.concepts || []).map(c => c?.display_name).filter(Boolean),
          venue: src.display_name || journal.name,
          journalIssn: journal.issn,
          url: oa.oa_url || loc.landing_page_url || (doi ? `https://doi.org/${doi}` : null),
          source: 'openalex',
          journalGroup: GROUP,
        });
      }

      cursor = data.meta?.next_cursor;
      if (!cursor) break;
      page++;
      process.stdout.write(`\r  ${journal.name}: ${papers.length} papers (page ${page})`);
      await sleep(150);
    } catch (err) {
      console.error(`\n  Error fetching ${journal.name}: ${err.message}`);
      break;
    }
  }

  return papers;
}

// ---------------------------------------------------------------------------
// Upsert helpers
// ---------------------------------------------------------------------------
const SMS_PATTERNS = [
  { design: 'RCT',          level: 5, re: /\b(randomized|randomised|rct|random assignment)\b/i },
  { design: 'DiD',          level: 4, re: /\b(difference.in.difference|did|double difference)\b/i },
  { design: 'IV',           level: 4, re: /\b(instrumental variable|two.stage least squares|2sls)\b/i },
  { design: 'RDD',          level: 4, re: /\b(regression discontinuity|rdd)\b/i },
  { design: 'Observational',level: 2, re: /\b(observational|cross.sectional|panel data|fixed effects)\b/i },
  { design: 'Qualitative',  level: 1, re: /\b(qualitative|case study|ethnograph|interview|focus group)\b/i },
];

function classifyPaper(paper) {
  const text = `${paper.title || ''} ${paper.abstract || ''}`;
  for (const p of SMS_PATTERNS) {
    if (p.re.test(text)) return { smsLevel: p.level, design: p.design, causalStrength: p.level >= 4 ? 'high' : p.level >= 3 ? 'moderate' : 'limited', smsMethod: 'keyword_scan' };
  }
  return { smsLevel: null, design: null, causalStrength: null, smsMethod: null };
}

async function upsertBatch(papers) {
  const BATCH = 50;
  let imported = 0;
  for (let i = 0; i < papers.length; i += BATCH) {
    const batch = papers
      .slice(i, i + BATCH)
      .filter((paper) => !isDeniedVenue(paper.venue, VENUE_DENYLIST));
    if (batch.length === 0) continue;
    const rows = batch.map(paper => {
      const sms = classifyPaper(paper);
      return {
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
        source: 'openalex',
        corpus_source: 'journal_whitelist',
        sms_level: sms.smsLevel,
        methodology_design: sms.design,
        causal_strength: sms.causalStrength,
        sms_method: sms.smsMethod,
        embedding: null,
        corpus_imported_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    });

    const { error } = await supabase.from('works').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
    if (error) console.error(`\n  Upsert error: ${error.message}`);
    else imported += rows.length;
    await sleep(100);
  }
  return imported;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const journals = getJournals();
  console.log(`=== Journal Whitelist Import ===`);
  console.log(`Group: ${GROUP} | Journals: ${journals.length} | Years: last ${YEARS} (from ${YEAR_FROM}) | Dry run: ${DRY_RUN}\n`);
  console.log(`Venue denylist: ${VENUE_DENYLIST.venues.length} venues (${VENUE_DENYLIST.path})\n`);

  // Load existing DOIs
  const existingDois = new Set();
  let from = 0;
  while (true) {
    const { data } = await supabase.from('works').select('canonical_doi').not('canonical_doi', 'is', null).range(from, from + 999);
    if (!data?.length) break;
    data.forEach(r => { if (r.canonical_doi) existingDois.add(r.canonical_doi.toLowerCase()); });
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`Existing DOIs: ${existingDois.size}\n`);

  let totalFetched = 0;
  let totalImported = 0;

  for (const journal of journals) {
    process.stdout.write(`\nFetching: ${journal.name}...`);
    const papers = await fetchJournalPapers(journal, existingDois);
    totalFetched += papers.length;
    console.log(`\r  ${journal.name}: ${papers.length} new papers`);

    if (!DRY_RUN && papers.length > 0) {
      const imported = await upsertBatch(papers);
      totalImported += imported;
      console.log(`  Imported: ${imported}`);
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`Fetched: ${totalFetched} | Imported: ${totalImported}`);
  console.log(`\nRun backfill-fast.mjs to embed the new papers.`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error(err); process.exit(1); });
