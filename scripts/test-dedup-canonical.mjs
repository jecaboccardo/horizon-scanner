#!/usr/bin/env node
/**
 * Verification script for title+author canonical dedup.
 *
 * Run: node scripts/test-dedup-canonical.mjs
 *
 * Asserts that the Bhalotra preprint (SSRN) and ReStud published version
 * collapse to one paper, and that other distinct papers do NOT collapse.
 *
 * NOTE: this script reimplements the dedup logic locally (mirrors
 * supabase/functions/_shared/dedup.ts) to stay node-runnable without a TS
 * loader. Keep it in sync with dedup.ts — if the canonical key format
 * changes there, change it here.
 */

import { token_sort_ratio } from "fuzzball";

function normalizeDoi(raw) {
  if (!raw) return null;
  return raw.replace(/^https?:\/\/doi\.org\//i, "").toLowerCase().trim() || null;
}

function normalizeTitle(raw) {
  if (!raw) return "";
  return String(raw)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstAuthorSurname(authors) {
  if (!Array.isArray(authors) || authors.length === 0) return "";
  const first = authors[0];
  let name = "";
  if (typeof first === "string") name = first;
  else if (first && typeof first === "object" && "name" in first) name = String(first.name ?? "");
  if (!name) return "";
  name = name.trim();
  if (!name) return "";
  let surname;
  if (name.includes(",")) {
    surname = name.split(",")[0].trim();
  } else {
    const parts = name.split(/\s+/);
    surname = parts[parts.length - 1];
  }
  return surname
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .trim();
}

function canonicalKey(paper) {
  const surname = firstAuthorSurname(paper.authors);
  const title = normalizeTitle(paper.title);
  const year = paper.year;
  if (!surname || !title || year === null || year === undefined) return null;
  return `${surname}|${title}|${year}`;
}

function deduplicatePapers(sources) {
  const kept = [];
  const keptDois = new Set();
  const keptCanonical = new Set();
  for (const source of sources) {
    for (const paper of source) {
      const doi = normalizeDoi(paper.doi);
      if (doi && keptDois.has(doi)) continue;
      const canonical = canonicalKey(paper);
      if (canonical && keptCanonical.has(canonical)) continue;
      const title = (paper.title ?? "").toLowerCase().trim();
      const year = paper.year;
      let duplicate = false;
      if (title.length > 0) {
        for (const prior of kept) {
          const priorTitle = (prior.title ?? "").toLowerCase().trim();
          if (!priorTitle) continue;
          const priorYear = prior.year;
          if (year !== null && year !== undefined && priorYear !== null && priorYear !== undefined && year !== priorYear) continue;
          if (token_sort_ratio(title, priorTitle) >= 90) {
            duplicate = true;
            break;
          }
        }
      }
      if (duplicate) continue;
      kept.push(paper);
      if (doi) keptDois.add(doi);
      if (canonical) keptCanonical.add(canonical);
    }
  }
  return kept;
}

// ---------- Test cases ----------

const cases = [];

// Case 1: Bhalotra et al — SSRN preprint vs ReStud published. DIFFERENT DOIs, SAME paper.
cases.push({
  name: "Bhalotra preprint + ReStud published collapse to 1",
  inputs: [
    [{
      id: "10.2139/ssrn.3892571",
      doi: "10.2139/ssrn.3892571",
      title: "Job Displacement, Unemployment Benefits and Domestic Violence",
      authors: ["Sonia Bhalotra", "Diogo Britto", "Paolo Pinotti", "Breno Sampaio"],
      year: 2024,
    }],
    [{
      id: "10.1093/restud/rdaf004",
      doi: "10.1093/restud/rdaf004",
      title: "Job Displacement, Unemployment Benefits and Domestic Violence",
      authors: ["Bhalotra, Sonia", "Britto, Diogo", "Pinotti, Paolo", "Sampaio, Breno"],
      year: 2024,
    }],
  ],
  expectKept: 1,
});

// Case 2: Türkiye IPV centers — 3 versions (NBER + 2 SSRN), same paper
cases.push({
  name: "Türkiye IPV-centers paper collapses 3 -> 1",
  inputs: [
    [{
      id: "nber:w12345",
      doi: "10.3386/w12345",
      title: "The Impact of Violence Prevention Centers on Domestic Violence in Türkiye",
      authors: ["Selin Yilmaz", "Ahmet Demir"],
      year: 2023,
    }],
    [{
      id: "ssrn:4111111",
      doi: "10.2139/ssrn.4111111",
      title: "The Impact of Violence Prevention Centers on Domestic Violence in Turkiye",
      authors: ["Yilmaz, Selin", "Demir, Ahmet"],
      year: 2023,
    }],
    [{
      id: "ssrn:4222222",
      doi: "10.2139/ssrn.4222222",
      title: "The Impact of Violence Prevention Centers on Domestic Violence in Türkiye",
      authors: ["Selin YILMAZ", "Ahmet DEMIR"],
      year: 2023,
    }],
  ],
  expectKept: 1,
});

// Case 3: distinct papers should NOT collapse (regression guard)
cases.push({
  name: "Two distinct Bhalotra papers stay separate",
  inputs: [
    [{
      id: "10.1093/restud/rdaf004",
      doi: "10.1093/restud/rdaf004",
      title: "Job Displacement, Unemployment Benefits and Domestic Violence",
      authors: ["Sonia Bhalotra"],
      year: 2024,
    }],
    [{
      id: "10.1257/aer.20180100",
      doi: "10.1257/aer.20180100",
      title: "Maternal Depression, Women's Empowerment, and Parental Investment",
      authors: ["Sonia Bhalotra"],
      year: 2024,
    }],
  ],
  expectKept: 2,
});

// Case 4: distinct topics by same author, same year -> NOT a duplicate.
// Different titles, same first-author surname, same year. The canonical key
// differs (title differs), and the fuzzy-title fallback also rejects.
cases.push({
  name: "Same author + year, different titles -> kept separate",
  inputs: [
    [{
      id: "doi:1",
      doi: "10.1234/foo",
      title: "Cash Transfers and Education",
      authors: ["Alice Smith"],
      year: 2020,
    }],
    [{
      id: "doi:2",
      doi: "10.5678/bar",
      title: "Minimum Wage and Informality in Brazil",
      authors: ["Alice Smith"],
      year: 2020,
    }],
  ],
  expectKept: 2,
});

// Case 5: missing year -> falls through to fuzzy title (existing behavior preserved)
cases.push({
  name: "Missing year on one row still dedups via fuzzy title",
  inputs: [
    [{
      id: "p1",
      doi: null,
      title: "Effects of Conditional Cash Transfers on Schooling",
      authors: ["Alice Smith"],
      year: 2019,
    }],
    [{
      id: "p2",
      doi: null,
      title: "Effects of Conditional Cash Transfers on Schooling",
      authors: ["Alice Smith"],
      year: null,
    }],
  ],
  expectKept: 1,
});

// ---------- Runner ----------

let pass = 0;
let fail = 0;
for (const c of cases) {
  const result = deduplicatePapers(c.inputs);
  const ok = result.length === c.expectKept;
  if (ok) {
    pass++;
    console.log(`PASS  ${c.name}  (kept ${result.length})`);
  } else {
    fail++;
    console.log(`FAIL  ${c.name}  (expected ${c.expectKept}, got ${result.length})`);
    for (const p of result) console.log(`        - ${p.id} :: ${p.title}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
