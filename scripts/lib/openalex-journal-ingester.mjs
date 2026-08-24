/**
 * scripts/lib/openalex-journal-ingester.mjs
 *
 * Shared OpenAlex-by-source ingest logic for journal-list backfill scripts.
 * Extracted from import-journal-gaps.mjs + import-lac-health-policy.mjs which
 * were 95% identical (~250 lines of duplication). Differences worth preserving:
 *
 *   - Journal lists (ABS top-econ vs LAC/Iberian health-policy)
 *   - SMS regex patterns (English-only vs English + Spanish + Portuguese)
 *   - Per-paper raw_data tagging (abs_tier vs journal_tag)
 *   - Console label formatting (journal.tier vs journal.tag)
 *
 * Each calling script passes a config and calls ingestJournals(). The library
 * handles: paginated OpenAlex fetch by source ID, abstract reconstruction
 * (OpenAlex's inverted-index format), SMS keyword classification, upsert
 * batching, dedup against existing works, dry-run mode.
 */

import { createClient } from "@supabase/supabase-js";
import { classifyTopics } from "../scl-topics.mjs";
import { isDeniedVenue, loadVenueDenylist } from "./venue-denylist.mjs";
import { isRealAbstract } from "./abstract-quality.mjs";

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// OpenAlex polite pool — the anonymous pool 429s on bulk paging (same
// convention as backfill-abstracts-openalex.mjs).
const MAILTO = process.env.OPENALEX_MAILTO || process.env.CROSSREF_MAILTO || "horizon-scanner@iadb.org";
const normDoi = (doi) =>
  doi?.toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "") || null;

function reconstructAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== "object") return null;
  const max = Math.max(...Object.values(invertedIndex).flat(), 0) + 1;
  const words = Array(max).fill("");
  for (const [w, ps] of Object.entries(invertedIndex)) {
    for (const p of ps) words[p] = w;
  }
  return words.join(" ").trim() || null;
}

/** Crossref abstracts arrive as JATS XML — strip tags, drop the leading
 *  "Abstract" label, and reject stubs via the shared quality guard. */
function cleanJatsAbstract(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^abstract[:.\s]+/i, "")
    .trim();
  return isRealAbstract(s) ? s : null;
}

// ---------------------------------------------------------------------------
// Default SMS patterns (English only). Override via config.smsPatterns to add
// other languages (e.g., LAC ingests pass a list that also matches Spanish
// and Portuguese terms).
// ---------------------------------------------------------------------------

export const DEFAULT_SMS_PATTERNS = [
  { design: "RCT",           level: 5, re: /\b(randomized|randomised|rct|random assignment|randomly assigned)\b/i },
  { design: "DiD",           level: 4, re: /\b(difference[- ]in[- ]differences?|diff[- ]in[- ]diff|did estimator|double difference)\b/i },
  { design: "IV",            level: 4, re: /\b(instrumental variables?|two[- ]stage least squares|2sls|iv estimator)\b/i },
  { design: "RDD",           level: 4, re: /\b(regression[- ]discontinuity|rdd)\b/i },
  { design: "Synthetic",     level: 4, re: /\b(synthetic control)\b/i },
  { design: "PSM",           level: 3, re: /\b(propensity[- ]score|matching estimator)\b/i },
  { design: "Observational", level: 2, re: /\b(observational|cross[- ]sectional|panel data|fixed effects)\b/i },
  { design: "Qualitative",   level: 1, re: /\b(qualitative|case study|ethnograph|interview|focus group)\b/i },
];

function classifyMethodology(text, patterns) {
  for (const p of patterns) {
    if (p.re.test(text)) {
      return {
        smsLevel: p.level,
        design: p.design,
        causalStrength: p.level >= 4 ? "high" : p.level >= 3 ? "moderate" : "limited",
        smsMethod: "keyword_scan",
        smsRationale: `matched pattern: ${p.design}`,
      };
    }
  }
  return { smsLevel: null, design: null, causalStrength: null, smsMethod: null, smsRationale: null };
}

// ---------------------------------------------------------------------------
// CLI argument parser (shared shape: --dry-run, --years <N>)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const flagValue = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };
  return {
    dryRun: args.includes("--dry-run"),
    years: parseInt(flagValue("--years", "15"), 10),
    api: flagValue("--api", "openalex"), // openalex | crossref
  };
}

// ---------------------------------------------------------------------------
// OpenAlex paginated fetch by source ID
// ---------------------------------------------------------------------------

async function fetchJournal(journal, yearFrom, existingDois, existingIds, opts) {
  const OA_URL = "https://api.openalex.org/works";
  let cursor = "*";
  let page = 0;
  const papers = [];

  if (isDeniedVenue(journal.name, opts.venueDenylist)) {
    console.log(`\n→ SKIP ${journal.name} (venue denylist)`);
    return papers;
  }

  console.log(`\n→ ${opts.labelFor(journal)} ${journal.name}`);

  while (cursor) {
    const params = new URLSearchParams({
      filter: [
        `primary_location.source.id:${journal.id}`,
        `from_publication_date:${yearFrom}-01-01`,
      ].join(","),
      sort: "publication_date:desc",
      per_page: "200",
      select:
        "id,doi,title,abstract_inverted_index,publication_year,publication_date,cited_by_count,authorships,primary_location,open_access,concepts,type",
      cursor,
      mailto: MAILTO,
    });

    let data;
    try {
      const res = await fetch(`${OA_URL}?${params}`, { signal: AbortSignal.timeout(25000) });
      if (!res.ok) {
        console.error(`\n  [OA ${res.status}]`);
        if (res.status === 429) {
          await sleep(8000);
          continue;
        }
        break;
      }
      data = await res.json();
    } catch (err) {
      console.error(`\n  Fetch error: ${err.message}`);
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
      const oa = raw.open_access || {};

      papers.push({
        id,
        title: raw.title,
        year: raw.publication_year,
        abstract: reconstructAbstract(raw.abstract_inverted_index),
        citationCount: raw.cited_by_count ?? null,
        doi,
        authors: (raw.authorships || []).map((a) => a?.author?.display_name).filter(Boolean),
        publicationDate: raw.publication_date,
        isOpenAccess: oa.is_oa || false,
        openAccessPdfUrl: oa.oa_url || loc.pdf_url || null,
        fieldsOfStudy: (raw.concepts || []).map((c) => c?.display_name).filter(Boolean),
        venue: journal.name,
        url: oa.oa_url || loc.landing_page_url || (doi ? `https://doi.org/${doi}` : null),
        oaType: raw.type,
        journal, // pass through for rawDataExtras
      });
    }

    cursor = data.meta?.next_cursor;
    page++;
    process.stdout.write(`\r    ${papers.length} new (page ${page})`);
    if (!cursor) break;
    await sleep(150);
  }
  console.log(`\n    +${papers.length} new from this journal`);
  return papers;
}

// ---------------------------------------------------------------------------
// Crossref paginated fetch by ISSN (api: "crossref")
//
// No OpenAlex dependency at all — Crossref has no daily credit budget (polite
// pool via mailto + UA). Journals need `{issn, name}`; no source-id resolution
// step. Elsevier journals carry JATS abstracts in Crossref; Springer ones
// mostly don't (fill via backfill-abstracts-springer-api.mjs afterwards).
// ---------------------------------------------------------------------------

async function fetchJournalCrossref(journal, yearFrom, existingDois, existingIds, opts) {
  const CR_URL = "https://api.crossref.org/works";
  let cursor = "*";
  let page = 0;
  const papers = [];

  if (isDeniedVenue(journal.name, opts.venueDenylist)) {
    console.log(`\n→ SKIP ${journal.name} (venue denylist)`);
    return papers;
  }
  // Crossref's issn filter only matches the ISSN(s) the publisher deposits
  // (usually print) — a journal's ABS/electronic ISSN can return 0. OR the
  // full pair via repeated issn: filters when the caller provides it.
  const issnSet = (journal.issns?.length ? journal.issns : [journal.issn]).filter(Boolean);
  if (issnSet.length === 0) {
    console.error(`\n→ SKIP ${journal.name} (no ISSN for Crossref mode)`);
    return papers;
  }

  console.log(`\n→ ${opts.labelFor(journal)} ${journal.name} [crossref issn:${issnSet.join("+")}]`);

  let retries = 0;
  while (cursor) {
    const params = new URLSearchParams({
      filter: `${issnSet.map((i) => `issn:${i}`).join(",")},from-pub-date:${yearFrom}-01-01,type:journal-article`,
      rows: "500",
      cursor,
      select: "DOI,title,abstract,author,issued,is-referenced-by-count,type,URL",
      mailto: MAILTO,
    });

    let data;
    try {
      const res = await fetch(`${CR_URL}?${params}`, {
        headers: { "User-Agent": `HorizonScanner/1.0 (journal gap ingest; mailto:${MAILTO})` },
        signal: AbortSignal.timeout(40000),
      });
      if (!res.ok) {
        console.error(`\n  [CR ${res.status}]`);
        // 404 included: Crossref intermittently 404s a valid works?filter=
        // query (observed on J Legal Studies first page — same params
        // succeeded minutes before and after). Treat as transient.
        if ((res.status === 429 || res.status === 404 || res.status >= 500) && retries++ < 20) {
          await sleep(res.status === 429 ? 10000 : 4000);
          continue;
        }
        break;
      }
      data = await res.json();
      retries = 0;
    } catch (err) {
      console.error(`\n  Fetch error: ${err.message}`);
      if (retries++ >= 20) break;
      await sleep(4000);
      continue;
    }

    if (page === 0) {
      console.log(`    total in Crossref window: ${data.message?.["total-results"] ?? "?"}`);
    }

    const items = data.message?.items || [];
    if (!items.length) break;

    for (const item of items) {
      const doi = normDoi(item.DOI);
      if (!doi) continue;
      const title = Array.isArray(item.title) ? item.title[0] : item.title;
      if (!title) continue;
      if (existingDois.has(doi) || existingIds.has(doi)) continue;
      existingDois.add(doi);
      existingIds.add(doi);

      const dateParts = item.issued?.["date-parts"]?.[0] || [];
      const year = dateParts[0] ?? null;
      const publicationDate = dateParts.length >= 3
        ? `${dateParts[0]}-${String(dateParts[1]).padStart(2, "0")}-${String(dateParts[2]).padStart(2, "0")}`
        : dateParts.length === 2
        ? `${dateParts[0]}-${String(dateParts[1]).padStart(2, "0")}-01`
        : year ? `${year}-01-01` : null;

      papers.push({
        id: doi,
        title: String(title).replace(/\s+/g, " ").trim(),
        year,
        abstract: cleanJatsAbstract(item.abstract),
        citationCount: item["is-referenced-by-count"] ?? null,
        doi,
        authors: (item.author || [])
          .map((a) => [a.given, a.family].filter(Boolean).join(" "))
          .filter(Boolean),
        publicationDate,
        isOpenAccess: false, // Crossref has no reliable OA flag — leave false
        openAccessPdfUrl: null,
        fieldsOfStudy: [],
        venue: journal.name,
        url: `https://doi.org/${doi}`,
        oaType: item.type,
        journal,
      });
    }

    cursor = data.message?.["next-cursor"] || null;
    page++;
    process.stdout.write(`\r    ${papers.length} new (page ${page})`);
    if (!cursor) break;
    await sleep(250);
  }
  console.log(`\n    +${papers.length} new from this journal`);
  return papers;
}

// ---------------------------------------------------------------------------
// Existing-corpus loader (deduplication input)
// ---------------------------------------------------------------------------

async function loadExisting(supabase) {
  const dois = new Set();
  const ids = new Set();
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("works")
      .select("id,canonical_doi")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("Existing-load error:", error.message);
      break;
    }
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
// Row builder + batch upsert
// ---------------------------------------------------------------------------

function buildRow(paper, opts) {
  const text = `${paper.title || ""} ${paper.abstract || ""}`;
  const sms = classifyMethodology(text, opts.smsPatterns);
  const sclTopics = classifyTopics(paper.title || "", paper.abstract || "");

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
    venue: paper.venue,
    journal_issn: paper.journal?.issn ?? null,
    url: paper.url || null,
    source: opts.api === "crossref" ? "crossref" : "openalex",
    corpus_source: opts.corpusSource,
    sms_level: sms.smsLevel,
    methodology_design: sms.design,
    causal_strength: sms.causalStrength,
    sms_method: sms.smsMethod,
    sms_rationale: sms.smsRationale,
    embedding: null,
    corpus_imported_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    raw_data: {
      scl_topics: sclTopics,
      source_type: "journal_article",
      ...opts.rawDataExtras(paper),
      openalex_type: paper.oaType,
    },
  };
}

async function upsertBatch(supabase, papers, opts) {
  const BATCH = 50;
  let imported = 0;
  let errors = 0;
  for (let i = 0; i < papers.length; i += BATCH) {
    const slice = papers.slice(i, i + BATCH);
    const rows = slice
      .filter((p) => !isDeniedVenue(p.venue, opts.venueDenylist))
      .map((p) => buildRow(p, opts));
    if (rows.length === 0) continue;
    const { error } = await supabase
      .from("works")
      .upsert(rows, { onConflict: "id", ignoreDuplicates: true });
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
// Public entry point — wraps the full ingest flow for one journal-list ingest
// ---------------------------------------------------------------------------

/**
 * Run a full ingest pass over `config.journals`.
 *
 * @param {object} config
 * @param {Array<object>} config.journals
 *   List of journals to ingest. Each must have `{id, name}` plus any custom
 *   metadata used by `labelFor` and `rawDataExtras`.
 * @param {string} config.corpusSource
 *   Value stored in works.corpus_source (e.g. 'journal_gaps').
 * @param {string} config.bannerTitle
 *   Title printed at the start of the run.
 * @param {(journal: object) => string} config.labelFor
 *   Format a console label for a journal (e.g. j => j.tier or j => j.tag.padEnd(10)).
 * @param {(paper: object) => object} config.rawDataExtras
 *   Returns key/values merged into the raw_data column (paper.journal is in
 *   scope so the caller can extract whatever fields it needs).
 * @param {Array<object>} [config.smsPatterns]
 *   Override the default English-only SMS regex list (e.g. LAC ingests add
 *   Spanish and Portuguese patterns).
 */
export async function ingestJournals(config) {
  const opts = {
    journals: config.journals,
    corpusSource: config.corpusSource,
    bannerTitle: config.bannerTitle,
    labelFor: config.labelFor,
    rawDataExtras: config.rawDataExtras,
    smsPatterns: config.smsPatterns ?? DEFAULT_SMS_PATTERNS,
    venueDenylist: loadVenueDenylist(),
  };

  const { dryRun, years, api } = parseArgs(process.argv);
  opts.api = config.api ?? api;
  const yearFrom = new Date().getFullYear() - years;

  const supabase = createClient(
    process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );

  console.log(`\n=== ${opts.bannerTitle} ===`);
  console.log(`Journals: ${opts.journals.length}`);
  console.log(`API: ${opts.api}`);
  console.log(`Years: last ${years} (from ${yearFrom})`);
  console.log(`Dry run: ${dryRun}\n`);
  console.log(`Venue denylist: ${opts.venueDenylist.venues.length} venues (${opts.venueDenylist.path})\n`);

  const { dois: existingDois, ids: existingIds } = await loadExisting(supabase);

  let totalImported = 0;
  let totalErrors = 0;
  const results = [];

  const fetchFn = opts.api === "crossref" ? fetchJournalCrossref : fetchJournal;
  for (const journal of opts.journals) {
    const papers = await fetchFn(journal, yearFrom, existingDois, existingIds, opts);

    if (dryRun) {
      results.push({ ...journal, harvested: papers.length, imported: 0 });
      console.log(`    (dry run: would import ${papers.length})`);
    } else if (papers.length > 0) {
      const { imported, errors } = await upsertBatch(supabase, papers, opts);
      results.push({ ...journal, harvested: papers.length, imported, errors });
      console.log(`    inserted: ${imported}, errors: ${errors}`);
      totalImported += imported;
      totalErrors += errors;
    } else {
      results.push({ ...journal, harvested: 0, imported: 0 });
    }
  }

  console.log(`\n=== Summary ===`);
  for (const r of results) {
    console.log(`  ${opts.labelFor(r)} ${r.name.padEnd(50)} ${String(r.harvested).padStart(5)} new`);
  }
  console.log(`  TOTAL ${totalImported} imported / ${results.reduce((s, r) => s + r.harvested, 0)} new\n`);

  if (totalImported > 0 && !dryRun) {
    console.log(`Next: run scripts/backfill-fast.mjs to embed new papers.\n`);
  }

  return { totalImported, totalErrors, results };
}
