// supabase/functions/_shared/evidenceFloors.ts
/**
 * Pure evidence-floor functions extracted from retrieval.ts (2026-06-15).
 * Each function mutates the `evidence` array in-place, matching the verbatim
 * inline logic from retrieval.ts. The foundational and region floors accept
 * a `gateOn` parameter — when false (the default / flag-OFF path), behaviour
 * is byte-identical to the pre-extraction inline code (the old
 * RELEVANCE_GATE_RAW_COSINE block was also default-OFF, so flag-OFF parity
 * is guaranteed).
 */

import { passesGate } from "./relevanceBackbone.ts";
import { selectedUxBuckets, uxRegionsOf } from "./rerank.ts";

// deno-lint-ignore no-explicit-any
type Paper = Record<string, any>;

const SYNTH = new Set([
  "topic_geo_channel",
  "foundational_channel_sql",
  "foundational_channel_fts",
  "causal_channel",
  "recent_channel",
]);

const citOf = (p: Paper) => Number(p.citation_count ?? p.citationCount ?? 0);

// ---------------------------------------------------------------------------
// Balanced-mix indirect floor
// ---------------------------------------------------------------------------

/**
 * Balanced-mix indirect floor (verbatim logic from retrieval.ts, 2026-06-11).
 *
 * Mutates `evidence`. Swaps in up to (floor - have) indirect papers from
 * `composite`, displacing the lowest-ranked non-indirect papers. No-op when
 * floor is already met or no indirect papers are available.
 *
 * NOTE: pushes all of `toAdd` (not sliced to `removed`) — matches the live
 * inline behaviour exactly.
 *
 * @returns count of papers added
 */
export function applyBalancedIndirectFloor(
  evidence: Paper[],
  composite: Paper[],
  opts: { floor: number },
): number {
  const isIndirect = (p: Paper) => String(p.classification ?? "") === "indirect";
  const have = evidence.filter(isIndirect).length;
  if (have >= opts.floor) return 0;
  const inEvidence = new Set(evidence.map((p) => p.id));
  const topIndirect = composite.filter((p) => isIndirect(p) && !inEvidence.has(p.id));
  const toAdd = topIndirect.slice(0, opts.floor - have);
  if (toAdd.length === 0) return 0;
  let removed = 0;
  for (let i = evidence.length - 1; i >= 0 && removed < toAdd.length; i--) {
    if (!isIndirect(evidence[i])) {
      evidence.splice(i, 1);
      removed++;
    }
  }
  evidence.push(...toAdd);
  return toAdd.length;
}

// ---------------------------------------------------------------------------
// Foundational citation floor
// ---------------------------------------------------------------------------

/**
 * Foundational citation floor (verbatim logic from retrieval.ts, 2026-06-11,
 * with the inline RELEVANCE_GATE_RAW_COSINE block superseded by gateOn).
 *
 * Mutates `evidence`. Guarantees the top-`floorN` most-cited on-topic papers
 * (cit ≥ minCites) appear in the evidence set, regardless of vector cosine.
 *
 * Flag-OFF parity: gateOn=false → passes() always returns true → identical
 * behaviour to the old inline code when RELEVANCE_GATE_RAW_COSINE was unset.
 *
 * Gate semantics: when gateOn=true, injected papers must pass passesGate()
 * from relevanceBackbone.ts (adaptive cosine floor with foundational escape),
 * superseding the old fixed REL_FLOOR=0.50 / REL_ESCAPE=0.45 inline block.
 *
 * @returns count of papers added
 */
export function applyFoundationalCiteFloor(
  evidence: Paper[],
  composite: Paper[],
  opts: {
    gateOn: boolean;
    escapeDelta: number;
    topCos: number;
    floorN: number;
    minCites: number;
  },
): number {
  const passes = (p: Paper): boolean => {
    if (!opts.gateOn) return true;
    return passesGate(
      {
        cosine: Number(p.similarity ?? 0),
        citations: citOf(p),
        year: Number(p.year ?? p.publication_year ?? 0),
        topCos: opts.topCos,
        isSynthetic: SYNTH.has(String(p._retrievalSource ?? "")),
        fts: Number(p.fts_rank ?? 0),
      },
      opts.escapeDelta,
    );
  };
  const topCited = [...composite]
    .filter((p) => citOf(p) >= opts.minCites && passes(p))
    .sort((a, b) => citOf(b) - citOf(a))
    .slice(0, opts.floorN);
  const inEvidence = new Set(evidence.map((p) => p.id));
  const missing = topCited.filter((p) => !inEvidence.has(p.id));
  if (missing.length === 0) return 0;
  const protectedIds = new Set(topCited.map((p) => p.id));
  let removed = 0;
  for (let i = evidence.length - 1; i >= 0 && removed < missing.length; i--) {
    if (!protectedIds.has(evidence[i].id ?? "")) {
      evidence.splice(i, 1);
      removed++;
    }
  }
  evidence.push(...missing.slice(0, removed));
  return Math.min(missing.length, removed);
}

// ---------------------------------------------------------------------------
// Region representation floor
// ---------------------------------------------------------------------------

/**
 * Region representation floor (verbatim logic from retrieval.ts, 2026-06-12/13).
 *
 * Mutates `evidence`. When a specific region is selected, ensures
 * round(cap*0.6) evidence slots go to in-region papers, swapping out the
 * lowest-ranked out-of-region papers. NEVER evicts:
 *   - papers with cit≥75 (foundational canon escape)
 *   - papers classified "indirect" (balanced-floor additions)
 *
 * No-op when no specific region is selected or the floor is already met.
 *
 * Flag-OFF parity: gateOn=false → passes() always returns true → swapped-IN
 * papers are not filtered by the relevance backbone. This matches the
 * pre-extraction inline behaviour (no gate existed here).
 *
 * @returns count of papers added
 */
export function applyRegionFloor(
  evidence: Paper[],
  composite: Paper[],
  opts: {
    regions?: string[] | null;
    cap: number;
    gateOn: boolean;
    escapeDelta: number;
    topCos: number;
  },
): number {
  const selBuckets = selectedUxBuckets(opts.regions);
  if (selBuckets.length === 0) return 0;
  const floor = Math.round(opts.cap * 0.6);
  const inRegion = (p: Paper): boolean =>
    uxRegionsOf(p.geography as string[] | undefined).some((b) => selBuckets.includes(b));
  const passes = (p: Paper): boolean => {
    if (!opts.gateOn) return true;
    return passesGate(
      {
        cosine: Number(p.similarity ?? 0),
        citations: citOf(p),
        year: Number(p.year ?? p.publication_year ?? 0),
        topCos: opts.topCos,
        isSynthetic: SYNTH.has(String(p._retrievalSource ?? "")),
        fts: Number(p.fts_rank ?? 0),
      },
      opts.escapeDelta,
    );
  };
  const have = evidence.filter(inRegion).length;
  if (have >= floor) return 0;
  const inEvidence = new Set(evidence.map((p) => p.id));
  const toAdd = composite
    .filter((p) => inRegion(p) && !inEvidence.has(p.id) && passes(p))
    .slice(0, floor - have);
  if (toAdd.length === 0) return 0;
  let removed = 0;
  for (let i = evidence.length - 1; i >= 0 && removed < toAdd.length; i--) {
    const e = evidence[i];
    const isCanon = citOf(e) >= 75;
    const isIndirect = String(e.classification ?? "") === "indirect";
    if (!inRegion(e) && !isCanon && !isIndirect) {
      evidence.splice(i, 1);
      removed++;
    }
  }
  evidence.push(...toAdd.slice(0, removed));
  return Math.min(toAdd.length, removed);
}
