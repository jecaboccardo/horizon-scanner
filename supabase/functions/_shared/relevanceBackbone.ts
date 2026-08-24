// supabase/functions/_shared/relevanceBackbone.ts
/**
 * Relevance backbone — pure primitives. query·paper cosine (not the RF label)
 * is the topicality decision. Dependency-free; importable by rerank.ts,
 * evidenceFloors.ts, retrieval.ts, and the offline rig. All thresholds are
 * PROVISIONAL until the embedding distribution is settled.
 */
export const ABS_FLOOR = 0.50;
export const MIN_FLOOR = 0.32;
export const REL_DELTA = 0.18;
export const DEFAULT_ESCAPE_DELTA = 0.10;
export const INDIRECT_BAND = 0.08; // label-only band width (deriveLabel); NOT a passesGate input
export const FOUND_MIN_CITES = 75;

export function gateThreshold(topCos: number): number {
  const adaptive = (Number.isFinite(topCos) ? topCos : ABS_FLOOR) - REL_DELTA;
  return Math.max(MIN_FLOOR, Math.min(ABS_FLOOR, adaptive));
}

export interface GateInput {
  cosine: number; citations: number; year: number;
  topCos: number; isSynthetic: boolean; fts: number;
}

function foundationalEscape(cosine: number, citations: number, year: number, gate: number, escapeDelta: number): boolean {
  // year >= 1900 also rejects null/0/NaN year serialisations
  return citations >= FOUND_MIN_CITES && year >= 1900 && year < 2020 && cosine >= gate - escapeDelta;
}

/** escapeDelta lets the caller TIGHTEN the foundational escape (toggle 3). */
export function passesGate(input: GateInput, escapeDelta: number = DEFAULT_ESCAPE_DELTA): boolean {
  if (input.isSynthetic) return true;
  if (!(input.cosine > 0)) return true;
  const gate = gateThreshold(input.topCos);
  if (input.cosine >= gate) return true;
  return foundationalEscape(input.cosine, input.citations, input.year, gate, escapeDelta);
}

export interface LabelInput { cosine: number; topCos: number; citations: number; year: number; lac: boolean; }
export type BackboneLabel = "direct-lac" | "direct-global" | "indirect" | "excluded";

/**
 * Derive a topicality label from cosine + geography. ONLY defined for REAL
 * vector hits (cosine > 0, non-synthetic): callers MUST guard with `rawCos > 0`
 * before calling. fts-only (cosine<=0) and synthetic/channel papers are NOT
 * passed here — they keep their channel-assigned label. (passesGate short-
 * circuits those to true; deriveLabel deliberately does not handle them.)
 */
export function deriveLabel(input: LabelInput, escapeDelta: number = DEFAULT_ESCAPE_DELTA): BackboneLabel {
  const gate = gateThreshold(input.topCos);
  if (input.cosine >= gate) return input.lac ? "direct-lac" : "direct-global";
  if (foundationalEscape(input.cosine, input.citations, input.year, gate, escapeDelta)) return "direct-global";
  if (input.cosine >= gate - INDIRECT_BAND) return "indirect";
  return "excluded";
}

const LAC_GEO = new Set([
  "lac", "latin america", "caribbean", "central america", "south america",
  "argentina", "bolivia", "brazil", "brasil", "chile", "colombia", "costa rica",
  "cuba", "dominican republic", "ecuador", "el salvador", "guatemala", "haiti",
  "honduras", "jamaica", "mexico", "méxico", "nicaragua", "panama", "paraguay",
  "peru", "perú", "uruguay", "venezuela", "barbados", "trinidad and tobago",
  "guyana", "suriname", "belize",
]);
export function lacFromGeography(geography?: string[] | null): boolean {
  for (const g of geography ?? []) if (LAC_GEO.has(String(g).trim().toLowerCase())) return true;
  return false;
}
