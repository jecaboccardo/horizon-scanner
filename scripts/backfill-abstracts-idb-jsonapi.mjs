#!/usr/bin/env node
/**
 * Backfill ONLY the abstract field for IADB-family rows missing an abstract,
 * from the public IDB Publications JSON:API (publications.iadb.org).
 *
 * This is a narrower sibling of backfill-idb-publication-metadata.mjs (which
 * also repairs authors/url/pdf/doi/dates). That script prior dry-run was
 * simply never re-run to completion (not a bug) -- but its scope is broader
 * than a single abstract-recovery task, so this script re-uses the same
 * IDB JSON:API walk + title/DOI matching but writes ONLY abstract
 * (+ raw_data.abstract_backfill provenance merged, never replacing other keys)
 * and only on rows where abstract IS NULL (gap-only, re-checked immediately
 * before each write).
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-abstracts-idb-jsonapi.mjs --dry-run
 *   node --env-file=.env scripts/backfill-abstracts-idb-jsonapi.mjs
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const PAGE_LIMIT = 50;
const IDB_JSONAPI_URL = "https://publications.iadb.org/en/jsonapi/node/publication";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanText(raw) {
  if (!raw) return null;
  return String(raw).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim() || null;
}

function normalizeDoi(raw) {
  if (!raw) return null;
  const value = typeof raw === "object" ? raw.uri : raw;
  return String(value || "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim().toLowerCase() || null;
}

const DIACRITIC_RE = new RegExp("[\u0300-\u036f]", "g");

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFD").replace(DIACRITIC_RE, "")
    .toLowerCase()
    .replace(/\([a-z]{2}\)\s*$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isRealAbstract(text) {
  const t = String(text || "").trim();
  if (t.length < 60) return false;
  if (/^\s*(see abstract at|abstract available|full[- ]?text available|https?:\/\/|www\.)/i.test(t)) return false;
  if (/\b(no abstract|abstract not (available|provided))\b/i.test(t)) return false;
  return true;
}

async function loadTargets() {
  const rows = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("works")
      .select("id,title,year,canonical_doi,raw_data")
      .or("venue.eq.IDB Publication,source.eq.idb,source.eq.idb_publications,source_family.eq.IADB")
      .is("abstract", null)
      .is("canonical_work_id", null)
      .not("is_noise", "is", true)
      .range(from, from + PAGE - 1);
    if (error) throw new Error("target load failed: " + error.message);
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function fetchPage(offset) {
  const params = new URLSearchParams();
  params.set("sort", "-field_date_issued_text");
  params.set("page[limit]", String(PAGE_LIMIT));
  params.set("page[offset]", String(offset));

  let response = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      response = await fetch(IDB_JSONAPI_URL + "?" + params, {
        headers: { Accept: "application/vnd.api+json" },
        signal: AbortSignal.timeout(45000),
      });
      if (response.ok) break;
      if (![429, 500, 502, 503, 504].includes(response.status)) {
        const bodyText = await response.text();
        throw new Error("IDB HTTP " + response.status + ": " + bodyText.slice(0, 200));
      }
    } catch (err) {
      if (attempt === 4) throw err;
    }
    await sleep(1500 * attempt);
  }
  if (!response || !response.ok) throw new Error("IDB HTTP " + (response ? response.status : "unknown"));
  const json = await response.json();
  const records = (json.data || []).map((resource) => {
    const attrs = resource.attributes || {};
    const title = cleanText(attrs.title);
    if (!title) return null;
    const doi = normalizeDoi(attrs.field_doi);
    const yearNum = Number.parseInt(String(attrs.field_date_issued_text || "").slice(0, 4), 10);
    return {
      idbId: doi || ("idb:" + resource.id),
      canonical_doi: doi,
      title: title,
      titleKey: normalizeTitle(title),
      year: Number.isFinite(yearNum) ? yearNum : null,
      abstract: cleanText(attrs.field_abstract && (attrs.field_abstract.value || attrs.field_abstract)),
    };
  }).filter(Boolean);
  return {
    records: records,
    hasMore: Boolean(json.links && json.links.next) || (json.data || []).length === PAGE_LIMIT,
  };
}

async function main() {
  console.log("\n=== IDB abstract-only backfill (JSON:API) ===");
  console.log("Dry run: " + DRY_RUN + "\n");

  const targets = await loadTargets();
  console.log("Null-abstract IADB targets: " + targets.length);
  if (!targets.length) return;

  const byId = new Map(targets.map((r) => [String(r.id).toLowerCase(), r]));
  const byDoi = new Map(targets.filter((r) => r.canonical_doi).map((r) => [String(r.canonical_doi).toLowerCase(), r]));
  const byTitleYear = new Map();
  for (const r of targets) byTitleYear.set(normalizeTitle(r.title) + "|" + (r.year || ""), r);

  let offset = 0, pageNo = 0, seen = 0, matched = 0, filled = 0, noAbstract = 0, badAbstract = 0, errors = 0;
  const remaining = new Set(targets.map((r) => r.id));
  const filledIds = [];

  while (remaining.size > 0) {
    let page;
    try {
      page = await fetchPage(offset);
    } catch (e) {
      console.error("\n  page fetch error @offset " + offset + ": " + e.message);
      break;
    }
    if (!page.records.length) break;
    pageNo++;
    seen += page.records.length;

    for (const pub of page.records) {
      const row = byId.get(String(pub.idbId).toLowerCase()) ||
        (pub.canonical_doi ? byDoi.get(pub.canonical_doi) : null) ||
        byTitleYear.get(pub.titleKey + "|" + (pub.year || ""));
      if (!row) continue;
      matched++;
      if (!pub.abstract) { noAbstract++; remaining.delete(row.id); continue; }
      if (!isRealAbstract(pub.abstract)) { badAbstract++; remaining.delete(row.id); continue; }

      if (DRY_RUN) {
        filled++;
        remaining.delete(row.id);
        console.log("  [would-fill] " + row.id + " :: " + row.title.slice(0, 60));
        continue;
      }

      const liveRes = await supabase.from("works").select("abstract,raw_data").eq("id", row.id).single();
      const live = liveRes.data;
      if (live && live.abstract) { remaining.delete(row.id); continue; }
      const patch = {
        abstract: pub.abstract,
        raw_data: Object.assign(
          {},
          (live && live.raw_data && typeof live.raw_data === "object") ? live.raw_data : {},
          {
            abstract_backfill: {
              source: "idb_jsonapi",
              matched_at: new Date().toISOString(),
              matched_idb_id: pub.idbId,
              matched_title: pub.title,
            },
          }
        ),
      };
      const upd = await supabase.from("works").update(patch).eq("id", row.id);
      if (upd.error) { errors++; console.error("\n  update failed " + row.id + ": " + upd.error.message); continue; }
      filled++;
      filledIds.push(row.id);
      remaining.delete(row.id);
      console.log("  OK " + row.id + " :: " + row.title.slice(0, 60) + " (" + pub.abstract.length + "ch)");
    }

    process.stdout.write("\r  pages " + pageNo + " | IDB seen " + seen + " | matched " + matched + " | filled " + filled + " | remaining targets " + remaining.size);
    if (!page.hasMore) break;
    offset += PAGE_LIMIT;
    await sleep(150);
  }

  console.log("\n");
  const summary = {
    dry_run: DRY_RUN,
    targets: targets.length,
    idb_records_seen: seen,
    matched: matched,
    filled: filled,
    no_abstract_in_source: noAbstract,
    bad_abstract_rejected: badAbstract,
    errors: errors,
    unresolved: remaining.size,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!DRY_RUN && filledIds.length) {
    fs.mkdirSync("reports", { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    fs.writeFileSync("reports/backfill-abstracts-idb-jsonapi-" + date + "-ids.json", JSON.stringify({ ids: filledIds }, null, 2));
    console.log("Filled ids -> reports/backfill-abstracts-idb-jsonapi-" + date + "-ids.json (re-embed next)");
  }
}

main().catch((err) => {
  console.error("[idb-abstract-backfill] failed:", err.message);
  process.exit(1);
});
