/**
 * scripts/lib/abstract-quality.mjs — SINGLE SOURCE OF TRUTH for "is this a real abstract?"
 *
 * Why this exists: the per-date `fill-abstracts-from-xlsx-*.mjs` scripts each carried
 * their OWN divergent placeholder guard. The 2026-06-22 script had NONE (accepted any
 * string > 20 chars) and the 2026-06-23 script only caught "no abstract available"-style
 * text — so ~503 LINK STUBS ("Abstract available at: https://link.springer.com/…") were
 * written into `works.abstract` as if real, then embedded on the link text (corpus
 * pollution found + reverted 2026-06-24). Every fill/backfill script MUST import
 * `isRealAbstract` from here so the guard can never drift again.
 *
 * A value is a REAL abstract iff it is ≥ MIN_LEN chars AND is not a STUB pointer
 * ("see abstract at …", "abstract available at …", a bare URL, "view/read the full
 * article", "download …") AND is not a PLACEHOLDER / non-abstract apparatus string
 * ("no abstract", "book review", "editorial", "n/a", publisher boilerplate, etc.).
 */

export const MIN_ABSTRACT_LEN = 60;

// Pointer/stub text that is NOT an abstract — usually a link to where the abstract lives.
// Anchored at start (^) because a real abstract may legitimately mention "available at" mid-text.
export const STUB_RE =
  /^\s*(see abstract at|abstract available|full[- ]?text available|view (the )?(full )?(article|abstract|paper)|read (the )?(full )?(article|abstract|paper)|access (the )?(full )?(article|abstract)|download|https?:\/\/|www\.|doi:)/i;

// Non-abstract apparatus / explicit "no abstract" placeholders (can appear anywhere).
export const PLACEHOLDER_RE =
  /\b(no abstract|abstract not (available|provided)|not available|book review|acknowledg|correspondence|editorial|just accepted|springer nature remains neutral)\b|^\s*(letter|n\/?a|none|null|tbd|\.+)\s*$/i;

// Elsevier "Highlights" bullet-list format — NOT a prose abstract.
// Looks like: "•We find..." or "Highlights•First finding•Second finding" or
// a run of bullet characters with no sentence structure.
// These pass the length check but embed very poorly vs. prose (Loyalka 2013 pattern).
export const HIGHLIGHTS_RE =
  /^\s*[•·▪▸►]\s|^\s*Highlights?\s*[•·\n]/i;

// Unstripped HTML markup — publisher HTML leaked into the abstract field.
export const HTML_TAG_RE = /<[a-z][^>]*>/i;

// Publisher PAGE FURNITURE, not abstract prose — found 2026-07-17 when an OpenAlex
// abstract_inverted_index for an ACS Publications "Viewpoint" record turned out to be
// built from scraped nav/ad copy ("ADVERTISEMENT RETURN TO ISSUE...Cite this: ...
// Publication Date (Web)...Copyright (c) 2012 American Chemical Society...Request reuse
// permissions"), not the article's abstract. This is an upstream-source data bug (verified
// live against the OpenAlex API), not a fetch-script bug, so every consumer needs the guard,
// not just one script. Long enough (>60 chars) and un-anchored (not a STUB_RE prefix) to
// evade every other check here.
//
// DELIBERATELY NARROW, twice over (full-corpus scans, 2026-07-17):
//  1. "all rights reserved" / bare "copyright ©" matched ~2,300 legitimate abstracts with a
//     common trailing publisher disclaimer — dropped.
//  2. bare "advertisement" matched ~130 legitimate economics-of-advertising papers (a real
//     research topic — "TV Food Advertising", "Targeted advertising with consumer learning"
//     genuinely use that noun in real prose) — dropped as a standalone signal.
// What's left are multi-word phrases that are page-CHROME-specific and effectively never
// occur in genuine abstract prose, no matter where in the string they appear.
export const PAGE_FURNITURE_RE =
  /\b(return to issue|request reuse permissions|publication date \(web\)|cite this:|view author information)\b/i;

/** A bare URL with nothing else (after trimming) is a stub, regardless of length. */
function isBareUrl(s) {
  const t = String(s || '').trim();
  return /^https?:\/\/\S+$/.test(t) || /^www\.\S+$/.test(t);
}

/**
 * @param {unknown} text
 * @returns {boolean} true iff `text` is a usable, real abstract.
 */
export function isRealAbstract(text) {
  const s = String(text ?? '').trim();
  if (s.length < MIN_ABSTRACT_LEN) return false;
  if (isBareUrl(s)) return false;
  if (STUB_RE.test(s)) return false;
  if (PLACEHOLDER_RE.test(s)) return false;
  if (HIGHLIGHTS_RE.test(s)) return false;  // Elsevier bullet highlights (2026-06-29)
  if (HTML_TAG_RE.test(s)) return false;    // unstripped HTML markup (2026-06-29)
  if (PAGE_FURNITURE_RE.test(s)) return false; // publisher nav/ad page furniture (2026-07-17)
  return true;
}

/** Inverse helper for callers that want to count/skip stubs explicitly. */
export function isStubAbstract(text) {
  return !isRealAbstract(text);
}

// Journal apparatus / front-matter titles that legitimately have NO abstract. When an
// xlsx says such a title has an abstract, the fetcher almost always grabbed the WRONG
// paper's text (e.g. a "coal consumption" abstract stuck on "Introduction: Symposium on
// Energy Sector Convergence", a China higher-ed paper on a "Special Issue" intro —
// 4 such mismatches found 2026-06-24). Fill scripts skip filling abstracts for these.
export const APPARATUS_TITLE_RE =
  /^\s*(introduction\b|editor'?s?\b|editorial\b|foreword\b|preface\b|erratum\b|corrigendum\b|in memoriam\b|obituary\b|comment(ary)? on\b|reply to\b|book review\b|report of the editors?\b|symposium\b|special issue\b|in this issue\b|table of contents\b|masthead\b|front matter\b|back matter\b|call for papers\b|announcement\b|acknowledge?ments?\b)|\b(symposium|special issue)\b.*\bintroduction\b|\bintroduction to (the )?(symposium|special issue)\b/i;

/**
 * @param {unknown} title
 * @returns {boolean} true iff `title` is journal apparatus that should not carry an abstract.
 */
export function isApparatusTitle(title) {
  return APPARATUS_TITLE_RE.test(String(title ?? '').trim());
}
