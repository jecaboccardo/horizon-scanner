import { token_sort_ratio } from "fuzzball";

// deno-lint-ignore no-explicit-any
type Paper = Record<string, any>;

function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.replace(/^https?:\/\/doi\.org\//i, "").toLowerCase().trim() || null;
}

/**
 * Normalize a title for canonical-key matching.
 * Lowercases, strips punctuation, collapses whitespace, drops common
 * stopwords-of-no-information ("the", "a", "an"), and trims.
 */
function normalizeTitle(raw: string | null | undefined): string {
  if (!raw) return "";
  return String(raw)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^\p{L}\p{N}\s]+/gu, " ") // strip punctuation
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract a normalized first-author surname.
 * Accepts authors as either string[] or {name: string}[]. Takes the first
 * entry, splits on whitespace, takes the last token (the surname for
 * "First Last" form). For "Last, First" form, takes the part before the comma.
 */
function firstAuthorSurname(authors: unknown): string {
  if (!Array.isArray(authors) || authors.length === 0) return "";
  const first = authors[0];
  let name = "";
  if (typeof first === "string") name = first;
  else if (first && typeof first === "object" && "name" in first) {
    name = String((first as { name?: unknown }).name ?? "");
  }
  if (!name) return "";
  name = name.trim();
  if (!name) return "";

  // Handle "Last, First" form
  let surname: string;
  if (name.includes(",")) {
    surname = name.split(",")[0]!.trim();
  } else {
    const parts = name.split(/\s+/);
    surname = parts[parts.length - 1]!;
  }

  return surname
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .trim();
}

/**
 * Build a canonical key for matching the same paper across preprint /
 * published / repository versions when DOIs differ.
 * Format: "<first-author-surname>|<normalized-title>|<year>"
 * Returns null if any component is missing — we never match on partial keys
 * (would create false positives, e.g. all anonymous papers from 2020 collapse).
 */
function canonicalKey(paper: Paper): string | null {
  const surname = firstAuthorSurname(paper.authors);
  const title = normalizeTitle(paper.title);
  const year = paper.year;
  if (!surname || !title || year === null || year === undefined) return null;
  return `${surname}|${title}|${year}`;
}

/**
 * Deduplicate papers across N sources in priority order.
 *
 * Each paper is expected to have its canonical `id` pre-assigned by its
 * source client (normalized DOI for DOI-bearing sources, or
 * `"<source-prefix>:<local-id>"` otherwise).
 *
 * Dedup rules (applied in priority order — sources[0] is highest priority):
 *   1. DOI exact match against any already-kept paper.
 *   2. Canonical-key match (first-author surname + normalized title + year).
 *      Catches preprint vs published-version cases where DOIs differ but the
 *      paper is identical (e.g. SSRN preprint vs ReStud published version).
 *   3. Fuzzy title + same year match (token_sort_ratio >= 90) against any
 *      already-kept paper. Catches near-identical titles where the canonical
 *      key fails (e.g. author surname formatted differently).
 *
 * Papers from a higher-priority source are always preferred.
 *
 * @param sources - Ordered list of paper arrays. First = highest priority.
 *
 * NOTE on residual gaps: this only dedupes the in-memory merged result at
 * retrieval-time. The underlying corpus (`works` table) may still contain
 * duplicate rows with different DOIs — those would need a one-shot
 * canonical_id backfill migration to fully resolve. See TODO below.
 *
 * TODO(canonical-id-migration): add a `canonical_id` column to `works` and
 * a one-shot script that groups rows by canonicalKey() and points all
 * variants at a single canonical row. Then retrieval can dedup by
 * canonical_id directly, and corpus stats stop double-counting.
 */
/**
 * Map a paper's `_retrievalSource` tag (set by the channel clients) to a
 * channel-of-origin id used by the frontend pills. Returns null for plain
 * vector/FTS corpus papers (no channel), which produce no pill override.
 *
 *   topic_geo_channel           -> "lac"           (topic+geography LAC channel)
 *   causal_channel              -> "causal"
 *   recent_channel              -> "recent"
 *   foundational_channel_*      -> "foundational"  (hyde / fts / sql variants)
 *
 * Purely additive — does not affect ranking or which papers are returned.
 */
export function sourceTagToChannelId(tag: unknown): string | null {
  if (typeof tag !== "string" || tag.length === 0) return null;
  if (tag === "topic_geo_channel") return "lac";
  if (tag === "causal_channel") return "causal";
  if (tag === "recent_channel") return "recent";
  if (tag.startsWith("foundational_channel")) return "foundational";
  return null;
}

/**
 * Options for {@link deduplicatePapers}.
 *
 * `channelMap` — when provided, the dedup walk records, for each KEPT paper id,
 * the UNION of channel-of-origin ids derived from `_retrievalSource` across the
 * kept paper AND every duplicate that was dropped in its favour. This captures
 * the case where a paper was surfaced by more than one channel (e.g. causal +
 * lac) even though dedup only keeps the single highest-priority instance.
 *
 * This is ADDITIVE bookkeeping only: it never changes which papers are kept or
 * their order — the return value is byte-identical to the no-options form.
 */
export interface DedupOptions {
  /** Mutable accumulator: kept paper id -> Set of channel ids. */
  channelMap?: Map<string, Set<string>>;
}

export function deduplicatePapers(sources: Paper[][], opts?: DedupOptions): Paper[] {
  const kept: Paper[] = [];
  const keptDois = new Set<string>();
  const keptCanonical = new Set<string>();
  const channelMap = opts?.channelMap;

  // Track, per kept paper, the keys that identify it so a later duplicate can
  // be attributed back to it for channel-union bookkeeping. Index-aligned with `kept`.
  const keptKeys: { doi: string | null; canonical: string | null }[] = [];

  // Record a paper's channel-of-origin tag against a kept paper id.
  const recordChannel = (keptPaper: Paper, fromPaper: Paper) => {
    if (!channelMap) return;
    const id = keptPaper.id ?? keptPaper.workId ?? keptPaper.canonical_doi;
    if (!id) return;
    const channel = sourceTagToChannelId(fromPaper._retrievalSource);
    if (!channel) return;
    let set = channelMap.get(String(id));
    if (!set) {
      set = new Set<string>();
      channelMap.set(String(id), set);
    }
    set.add(channel);
  };

  for (const source of sources) {
    for (const paper of source) {
      const doi = normalizeDoi(paper.doi);
      if (doi && keptDois.has(doi)) {
        // Duplicate by DOI — attribute its channel to the already-kept paper.
        if (channelMap) {
          const idx = keptKeys.findIndex((k) => k.doi === doi);
          if (idx >= 0) recordChannel(kept[idx]!, paper);
        }
        continue;
      }

      const canonical = canonicalKey(paper);
      if (canonical && keptCanonical.has(canonical)) {
        if (channelMap) {
          const idx = keptKeys.findIndex((k) => k.canonical === canonical);
          if (idx >= 0) recordChannel(kept[idx]!, paper);
        }
        continue;
      }

      const title = (paper.title ?? "").toLowerCase().trim();
      const year = paper.year;
      let duplicate = false;
      let dupIdx = -1;
      if (title.length > 0) {
        for (let i = 0; i < kept.length; i++) {
          const prior = kept[i]!;
          const priorTitle = (prior.title ?? "").toLowerCase().trim();
          if (!priorTitle) continue;
          const priorYear = prior.year;
          if (year !== null && year !== undefined && priorYear !== null && priorYear !== undefined && year !== priorYear) {
            continue;
          }
          if (token_sort_ratio(title, priorTitle) >= 90) {
            duplicate = true;
            dupIdx = i;
            break;
          }
        }
      }
      if (duplicate) {
        if (channelMap && dupIdx >= 0) recordChannel(kept[dupIdx]!, paper);
        continue;
      }

      kept.push(paper);
      keptKeys.push({ doi, canonical });
      if (doi) keptDois.add(doi);
      if (canonical) keptCanonical.add(canonical);
      // Seed the kept paper's own channel from its source tag.
      recordChannel(paper, paper);
    }
  }

  return kept;
}

// Exported for test/diagnostic scripts.
export const __testing = { normalizeTitle, firstAuthorSurname, canonicalKey };
