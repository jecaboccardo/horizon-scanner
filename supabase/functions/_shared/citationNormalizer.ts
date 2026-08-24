/**
 * supabase/functions/_shared/citationNormalizer.ts
 *
 * Post-processes a Gemini-generated brief to recover canonical [workId]
 * citation tokens that Gemini reformats away.
 *
 * Known production bug (2026-05-19): Gemini drops the `10.` DOI prefix and
 * emits citations with a fabricated `ss:` prefix instead, in three flavors:
 *
 *   NBER:  10.3386/w23285        →  [ss:23285]            (bare NBER number)
 *   SSRN:  10.2139/ssrn.5169611  →  [ss:5169611]          (bare SSRN number)
 *   IADB:  10.18235/0013677      →  [ss:18235/0013677]    (strip-10. form)
 *
 * This violates CORE_RULES rule 2 (only [workId] tokens that appear in the
 * evidence list are valid). Prompt tweaks did not reliably suppress it, so we
 * fix it downstream by walking the brief's text fields and rewriting any
 * `[ss:...]` token whose body maps back to a known workId in the evidence list.
 *
 * Unresolvable or ambiguous tokens are dropped — by definition they reference
 * papers not in evidence, which CORE_RULES forbids citing. Alphabetic `[ss:foo]`
 * tokens are left alone (they may be legitimate older SS-prefixed workIds and
 * the regex doesn't match them).
 */

interface MinimalEvidenceRow {
  workId: string;
}

interface NormalizeStats {
  rewritten: number;
  dropped: number;
  ambiguous: number;
}

const NBER_PATTERN = /^10\.3386\/w(\d+)$/i;
const SSRN_PATTERN = /^10\.2139\/ssrn\.(\d+)$/i;
const DOI_PATTERN = /^10\.[^/]+\/.+/i;
// Matches [ss:NNN] and [ss:NNN/anything], not [ss:abc...] (alphabetic).
const MANGLED_CITATION = /\[ss:(\d+(?:\/[^\]\s]+)?)\]/g;

function addToIndex(
  index: Map<string, string[]>,
  key: string,
  id: string,
): void {
  const existing = index.get(key);
  if (existing) {
    if (!existing.includes(id)) existing.push(id);
  } else {
    index.set(key, [id]);
  }
}

function buildSuffixIndex(rows: MinimalEvidenceRow[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const row of rows) {
    const id = row?.workId;
    if (!id) continue;
    // Strip-10. key: 10.18235/0013677 → 18235/0013677. Catches IADB and acts
    // as a safety net for any other DOI-prefixed workId Gemini might mangle.
    if (DOI_PATTERN.test(id)) {
      addToIndex(index, id.slice(3), id);
    }
    // Bare-number key for NBER (10.3386/w23285 → 23285) and SSRN
    // (10.2139/ssrn.5169611 → 5169611).
    const nber = id.match(NBER_PATTERN);
    if (nber) addToIndex(index, nber[1], id);
    const ssrn = id.match(SSRN_PATTERN);
    if (ssrn) addToIndex(index, ssrn[1], id);
  }
  return index;
}

function rewriteText(
  text: string,
  index: Map<string, string[]>,
  stats: NormalizeStats,
): string {
  if (!text) return text;
  let droppedHere = false;
  const out = text.replace(MANGLED_CITATION, (_match, body: string) => {
    const matches = index.get(body);
    if (!matches || matches.length === 0) {
      stats.dropped++;
      droppedHere = true;
      return "";
    }
    if (matches.length > 1) {
      stats.ambiguous++;
      droppedHere = true;
      return "";
    }
    stats.rewritten++;
    return `[${matches[0]}]`;
  });
  if (!droppedHere) return out;
  // Collapse the "  " and " ." holes left by removed brackets.
  return out.replace(/\s+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ");
}

function rewriteStringField<T extends Record<string, unknown>>(
  obj: T,
  key: keyof T,
  index: Map<string, string[]>,
  stats: NormalizeStats,
): void {
  const v = obj[key];
  if (typeof v === "string") {
    (obj as Record<string, unknown>)[key as string] = rewriteText(v, index, stats);
  }
}

function rewriteStringArray<T extends Record<string, unknown>>(
  obj: T,
  key: keyof T,
  index: Map<string, string[]>,
  stats: NormalizeStats,
): void {
  const v = obj[key];
  if (Array.isArray(v)) {
    (obj as Record<string, unknown>)[key as string] = v.map((s) =>
      typeof s === "string" ? rewriteText(s, index, stats) : s,
    );
  }
}

/**
 * Walk a Gemini-generated brief and rewrite `[ss:DIGITS]` citation tokens to
 * the canonical `[workId]` form. Mutates the input in place.
 *
 * No-op when evidence has no NBER/SSRN workIds (the only patterns Gemini is
 * known to mangle this way). Returns stats for the caller to log.
 */
export function normalizeBriefCitations(
  // deno-lint-ignore no-explicit-any
  brief: any,
  evidenceRows: MinimalEvidenceRow[],
): NormalizeStats {
  const stats: NormalizeStats = { rewritten: 0, dropped: 0, ambiguous: 0 };
  if (!brief || typeof brief !== "object") return stats;
  const index = buildSuffixIndex(evidenceRows);
  if (index.size === 0) return stats;

  // Top-level string fields per BRIEF_SCHEMA (geminiClient.ts).
  rewriteStringField(brief, "abstractSummary", index, stats);
  rewriteStringField(brief, "methodologyNote", index, stats);
  rewriteStringField(brief, "strongestEvidence", index, stats);
  rewriteStringArray(brief, "summaryBullets", index, stats);
  rewriteStringArray(brief, "followUpQuestions", index, stats);
  rewriteStringArray(brief, "warnings", index, stats);

  // Coverage card narrative fields. Numeric counts are deterministic on the
  // server side and never see this path, but the prose fields can.
  const cov = brief.coverageCard;
  if (cov && typeof cov === "object") {
    rewriteStringField(cov, "gapSummary", index, stats);
    rewriteStringField(cov, "regionalGap", index, stats);
    rewriteStringField(cov, "thinEvidenceAreas", index, stats);
    rewriteStringField(cov, "methodologicalGap", index, stats);
  }

  return stats;
}
