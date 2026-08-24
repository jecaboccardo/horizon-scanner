/**
 * supabase/functions/_shared/queryFacets.ts
 *
 * LLM-driven query facet decomposition for Direct vs Indirect evidence
 * classification. Takes a natural-language policy question and returns 2–4
 * conceptual facet groups, each with a generous synonym/related-term expansion.
 *
 * No closed vocabulary — Qwen does the conceptual decomposition fresh per
 * query. Output is cached in an in-memory LRU keyed by query hash, so repeat
 * searches pay zero LLM cost.
 *
 * Direct = paper's title+abstract matches at least one term from EVERY facet.
 * Indirect = matches some facets but not all.
 * Excluded = matches no facets.
 *
 * Falls back to a deterministic single-facet decomposition if Qwen is
 * unavailable; in that case Direct/Indirect collapses but searches still run.
 */

import { qwenGenerate } from "./qwenClient.ts";
import { adminClient } from "./supabase.ts";

// Bump whenever SYSTEM_PROMPT or SYNONYM_BOOSTS change — invalidates the
// persistent facet cache (rows are keyed by (query_key, prompt_version)).
const FACET_PROMPT_VERSION = "v2-2026-06-10";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueryFacet {
  /** Short human-readable label, e.g. "gender", "migration", "geography" */
  label: string;
  /** Lowercased, deduped synonyms + near-synonyms + sub-types + lay terms.
   *  Used both as embedding text (per-facet vector) and (for geography facets)
   *  as a literal regex to detect LAC country/region mentions. */
  expansion: string[];
  /** Topic facets are gated by per-facet semantic similarity.
   *  Geography facets are scope modifiers — they don't gate Direct, they
   *  split it into Direct-LAC vs Direct-global. */
  kind: "topic" | "geography";
  /** Whether matching this facet is required for Direct classification.
   *  Topic facets default required:true (semantic AND across topics).
   *  Geography facets are always required:false (they modify, not gate). */
  required: boolean;
}

export interface QueryFacets {
  /** Original user query (unchanged) */
  query: string;
  /** 2–4 facet groups */
  facets: QueryFacet[];
  /** Decomposition source, for diagnostics */
  method: "qwen" | "deterministic";
}

// ---------------------------------------------------------------------------
// In-memory LRU cache (process-scoped — survives across requests)
// ---------------------------------------------------------------------------

const CACHE_MAX = 500;
const cache = new Map<string, QueryFacets>();

function cacheGet(key: string): QueryFacets | null {
  const hit = cache.get(key);
  if (!hit) return null;
  // LRU touch
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key: string, value: QueryFacets): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
}

// ---------------------------------------------------------------------------
// Qwen decomposition
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You decompose policy/economics research queries into 2–4 conceptual FACETS for a faceted retrieval system.

Each facet represents one independent thing the user is asking about. For "gender and migration in LAC", the facets are: gender, migration, geography (LAC). For "AI and labor in Brazil", the facets are: AI, labor, geography (Brazil). For "evidence on conditional cash transfers", there is one facet: conditional cash transfers (program-level concept).

ORDER MATTERS. The FIRST facet must be the user's primary subject — the technology, intervention, or core topic that the question is fundamentally ABOUT. Geography is almost never the primary subject (it modifies the subject) and should appear LAST, not first. For "AI and labor in LAC", the order is: [AI, labor, geography]. For "robots and wages in Mexico", the order is: [robots, wages, geography]. The downstream classifier requires the first facet to match for a paper to count as direct evidence — getting the order wrong silently breaks classification.

For each facet, output a generous list of 10–22 synonyms, near-synonyms, sub-types, and lay terms that a paper writing about that concept might use. Be inclusive — papers use varied vocabulary (e.g. "gender" papers say "women", "female", "sex differences", "girls", "maternal", "feminist"; "migration" papers say "migrant", "immigrant", "remittance", "displacement", "refugee", "diaspora", "mobility").

CRITICAL — INCLUDE THE TERMS USED IN THE ACTUAL ACADEMIC LITERATURE, NOT JUST REPHRASINGS OF THE USER'S WORDS. Users phrase queries in lay or policy language but papers use technical terms. Bridge that gap explicitly:
  - "gender violence" → MUST include "domestic violence", "intimate partner violence", "ipv", "violence against women", "vaw", "spousal abuse", "violencia doméstica", "violencia de pareja"
  - "AI" / "artificial intelligence" → MUST include "machine learning", "ml", "automation", "robots", "algorithmic", "deep learning", "neural networks"
  - "mhealth" / "digital health" → MUST include "telemedicine", "telehealth", "ehealth", "mobile health", "sms intervention", "health app"
  - "education" → MUST include "schooling", "learning", "students", "pupils", "school enrollment", "educational attainment", "literacy"
  - "labor" → MUST include "employment", "wages", "earnings", "labor market", "jobs", "workers", "labor force participation", "unemployment"
  - "cash transfers" → MUST include "cct", "ubi", "social protection", "income support", "welfare", "transferencias monetarias"
  - "climate" → MUST include "weather shocks", "rainfall", "drought", "temperature", "extreme weather", "global warming"
  - "health" → MUST include "mortality", "morbidity", "disease", "healthcare", "health outcomes", "medical"
The synonym MUST be the term that actual papers in that subfield use as their primary vocabulary, not just a paraphrase. If you cannot think of the literature term, that is a sign the facet expansion is too narrow — go broader.

When the query is about Latin America / the Caribbean / a specific LAC country, INCLUDE the Spanish (and Portuguese for Brazil) terms in every facet's expansion. A large fraction of the LAC corpus is in Spanish — without "género" / "mujeres" / "migración" / "trabajo" / "empleo" / "salarios", we silently miss those papers. Use lowercase, no accents (matching is accent-folded).

ALWAYS extract a "geography" facet when the query mentions a region, country, or geographic scope. Expand it to include the region label AND the major countries within it. For LAC: latin america, caribbean, lac, mexico, brazil, argentina, chile, colombia, peru, venezuela, ecuador, bolivia, paraguay, uruguay, costa rica, panama, guatemala, honduras, el salvador, nicaragua, dominican republic, haiti, jamaica. CRUCIAL: geography facets must be returned with required:false. The downstream Direct/Indirect classifier treats required facets as hard gates, and many papers studying a LAC country don't put the country name or "Latin America" in their title or abstract (the country shows up only in the data section). Marking geography required:true makes Direct vanish for sparse cross-cutting queries. Topic facets are still required:true.

DO NOT include methodology terms (RCT, DiD, systematic review) as facets — those are filters, not topics.

DO NOT include filler concepts (evidence, study, research, paper) as facets.

Output strict JSON:
{
  "facets": [
    { "label": "<short label>", "expansion": ["term1", "term2", ...], "required": true }
  ]
}

All facets are required:true unless the user clearly marked one as optional. Keep labels lowercase. Keep expansion terms lowercase. No duplicates.`;

// ---------------------------------------------------------------------------
// Synonym booster — hardcoded literature-vocabulary fallback
// ---------------------------------------------------------------------------
//
// Even with the prompt enhancement above, Qwen sometimes returns a narrow
// expansion that mirrors the user's phrasing. This map adds a guaranteed
// floor of high-frequency literature terms for the most impactful query/
// concept pairs we've seen miss canary papers in retrieval evals.
//
// Triggering is by trigger-term match against the facet label OR any term
// in the facet's expansion (case-insensitive substring). All triggers union
// their bonus terms into the facet expansion (deduped).
//
// Keep this list SMALL and HIGH-CONFIDENCE — every entry is a place where
// users predictably diverge from how papers in that subfield write. Grow
// only when a new eval miss proves a new pair is needed.

interface SynonymBoost {
  /** Triggers that, if found in the facet label or any expansion term
   *  (substring match, lowercased), cause `add` to be unioned in. */
  triggers: string[];
  add: string[];
}

const SYNONYM_BOOSTS: SynonymBoost[] = [
  {
    triggers: ["gender violence", "gender-based violence", "gbv", "violence against women", "vaw"],
    add: [
      "domestic violence",
      "intimate partner violence",
      "ipv",
      "spousal abuse",
      "spousal violence",
      "violence against women",
      "vaw",
      "violencia domestica",
      "violencia de pareja",
      "violencia de genero",
      // Outcome-linked phrases: pull embedding toward causal chain (violence → labor/economic outcomes)
      // rather than general violence/crime. Papers studying this specific mechanism use these compound terms.
      "domestic violence labor",
      "domestic violence employment",
      "domestic violence wages",
      "domestic violence economic",
      "intimate partner violence labor",
      "intimate partner violence employment",
      "intimate partner violence female labor",
      "intimate partner violence wages",
      "violence against women labor supply",
      "violence against women employment",
      "violence against women economic consequences",
      "gender violence female labor",
      "abuse female labor force participation",
      "harassment labor market",
      "harassment employment women",
    ],
  },
  {
    triggers: ["domestic violence", "intimate partner violence", "ipv"],
    add: [
      "gender-based violence",
      "gbv",
      "violence against women",
      "spousal abuse",
      "violencia domestica",
      "violencia de pareja",
      "domestic violence labor",
      "domestic violence employment",
      "domestic violence economic consequences",
      "intimate partner violence female labor",
      "intimate partner violence wages",
    ],
  },
  {
    triggers: ["ai", "artificial intelligence"],
    add: [
      "machine learning",
      "ml",
      "automation",
      "robots",
      "robotics",
      "algorithmic",
      "deep learning",
      "neural networks",
      "generative ai",
      "llm",
    ],
  },
  {
    triggers: ["mhealth", "digital health", "ehealth"],
    add: [
      "telemedicine",
      "telehealth",
      "mobile health",
      "sms intervention",
      "health app",
      "remote care",
    ],
  },
  {
    triggers: ["education", "schooling"],
    add: [
      "schooling",
      "learning",
      "students",
      "pupils",
      "school enrollment",
      "educational attainment",
      "literacy",
      "test scores",
      "academic achievement",
    ],
  },
  {
    triggers: ["labor", "labour", "employment"],
    add: [
      "employment",
      "wages",
      "earnings",
      "labor market",
      "labour market",
      "jobs",
      "workers",
      "labor force participation",
      "unemployment",
      "empleo",
      "salarios",
      "trabajo",
    ],
  },
  {
    triggers: ["cash transfer", "cct"],
    add: [
      "conditional cash transfer",
      "cct",
      "ubi",
      "universal basic income",
      "social protection",
      "income support",
      "welfare",
      "transferencias monetarias",
      "bolsa familia",
      "oportunidades",
      "progresa",
    ],
  },
  {
    triggers: ["climate", "climate change"],
    add: [
      "weather shocks",
      "rainfall",
      "drought",
      "temperature",
      "extreme weather",
      "global warming",
      "heat",
      "natural disasters",
    ],
  },
  {
    triggers: ["health"],
    add: [
      "mortality",
      "morbidity",
      "disease",
      "healthcare",
      "health outcomes",
      "medical",
      "salud",
    ],
  },
  {
    // q24 (Rafael de Hoyos) eval 2026-06-10: the perceived-returns RCT
    // literature's primary vocabulary. Mirrors the synonymExpander.ts entry.
    triggers: ["returns to schooling", "returns to education", "information on returns"],
    add: [
      "perceived returns",
      "earnings disclosure",
      "subjective expectations",
      "information intervention",
      "demand for schooling",
      "wage expectations",
      "earnings information",
    ],
  },
  {
    triggers: ["migration", "migrant", "immigration"],
    add: [
      "immigrant",
      "emigrant",
      "remittance",
      "remittances",
      "displacement",
      "refugee",
      "diaspora",
      "mobility",
      "migracion",
      "migrante",
    ],
  },
];

/**
 * Apply hardcoded synonym boosts post-Qwen. Mutates expansion arrays
 * with deduplicated additions. Triggers match against label + any
 * expansion term (case-insensitive, accent-folded substring).
 */
function applySynonymBoosts(facets: QueryFacet[]): QueryFacet[] {
  return facets.map((facet) => {
    if (facet.kind === "geography") return facet;
    const haystack = [facet.label, ...facet.expansion]
      .map((s) => foldAccents(s.toLowerCase()))
      .join(" | ");
    const additions = new Set<string>();
    for (const boost of SYNONYM_BOOSTS) {
      const fired = boost.triggers.some((t) => {
        const trig = foldAccents(t.toLowerCase());
        // Match the trigger as a contiguous phrase first (word-boundary
        // around the whole phrase). This handles "domestic violence" /
        // "intimate partner violence" cleanly.
        const phraseRe = new RegExp(`(^|[^a-z0-9])${trig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
        if (phraseRe.test(haystack)) return true;
        // For multi-word triggers, also fire when ALL words appear
        // separately in the haystack (e.g. trigger "gender violence"
        // fires when deterministic fallback contains tokens "gender"
        // AND "violence" as separate expansion entries).
        const words = trig.split(/\s+/).filter((w) => w.length >= 2);
        if (words.length < 2) return false;
        return words.every((w) => {
          const wRe = new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
          return wRe.test(haystack);
        });
      });
      if (fired) {
        for (const term of boost.add) additions.add(term.toLowerCase());
      }
    }
    if (additions.size === 0) return facet;
    const merged = Array.from(new Set([...facet.expansion, ...additions]));
    return { ...facet, expansion: merged };
  });
}

interface QwenFacetOutput {
  facets?: Array<{
    label?: string;
    expansion?: string[];
    required?: boolean;
  }>;
}

/**
 * Decompose a query into facets. Cached per query string.
 * Never throws — falls back to deterministic decomposition on any failure.
 */
// Single Qwen call attempt. Returns parsed facets or null on any failure
// (HTTP error, parse error, empty result, single-facet response). Caller
// decides whether to retry or fall back.
async function tryQwenDecomposeOnce(query: string, timeoutMs: number): Promise<QueryFacet[] | null> {
  let raw: string;
  try {
    raw = await qwenGenerate(query, {
      system: SYSTEM_PROMPT,
      format: "json",
      // 0 (was 0.1): facet decomposition must be DETERMINISTIC — eval runs
      // 2026-06-10 showed run-to-run facet variance moving canary ranks by
      // 10+ positions across process restarts (probe-variant-shootout).
      temperature: 0,
      timeoutMs,
    });
  } catch (err) {
    console.error("[query-facets] Qwen call error:", (err as Error).message);
    return null;
  }
  if (!raw || raw.length === 0) {
    console.warn("[query-facets] Qwen returned empty string");
    return null;
  }
  let parsed: QwenFacetOutput;
  try {
    parsed = JSON.parse(raw) as QwenFacetOutput;
  } catch (parseErr) {
    console.error(
      `[query-facets] Qwen JSON.parse failed: ${(parseErr as Error).message}. ` +
        `Raw (first 300 chars): ${raw.slice(0, 300)}`,
    );
    return null;
  }
  const rawFacets = (parsed.facets ?? [])
    .map((f) => ({
      label: String(f.label ?? "").trim().toLowerCase(),
      expansion: Array.from(
        new Set(
          (f.expansion ?? [])
            .map((t) => String(t ?? "").trim().toLowerCase())
            .filter((t) => t.length > 0)
        )
      ),
    }))
    .filter((f) => f.label.length > 0 && f.expansion.length > 0);

  if (rawFacets.length === 0) return null;

  // Topic vs geography split (2026-05-08):
  //   - Topic facets: required:true. Gated by per-facet semantic similarity.
  //   - Geography facets: kind="geography", required:false. Scope modifier.
  const geoLike = (label: string) =>
    /^(geo|geography|region|location|country|countries|place)$/i.test(label);
  const topicFacets: QueryFacet[] = rawFacets
    .filter((f) => !geoLike(f.label))
    .map((f) => ({ ...f, kind: "topic" as const, required: true }));
  const geoFacets: QueryFacet[] = rawFacets
    .filter((f) => geoLike(f.label))
    .map((f) => ({ ...f, kind: "geography" as const, required: false }));
  return applySynonymBoosts([...topicFacets, ...geoFacets]);
}

// ---------------------------------------------------------------------------
// Persistent facet cache (DB read-through, table: query_facet_cache)
// ---------------------------------------------------------------------------
// The in-memory LRU above only lives per-process; every deno-api restart
// (every deploy) and every eval/script invocation re-pays a nondeterministic
// Qwen call. Rows are keyed by (query_key, prompt_version); soft-fail on any
// DB error (incl. table-not-yet-migrated) so this can never break retrieval.

async function dbCacheGet(key: string): Promise<QueryFacets | null> {
  try {
    const { data, error } = await adminClient
      .from("query_facet_cache")
      .select("facets")
      .eq("query_key", key)
      .eq("prompt_version", FACET_PROMPT_VERSION)
      .maybeSingle();
    if (error || !data?.facets) return null;
    const facets = data.facets as QueryFacet[];
    if (!Array.isArray(facets) || facets.length < 2) return null;
    return { query: key, facets, method: "qwen" };
  } catch {
    return null;
  }
}

function dbCacheSet(key: string, value: QueryFacets): void {
  // Fire-and-forget — never awaited on the retrieval hot path.
  adminClient
    .from("query_facet_cache")
    .upsert(
      { query_key: key, prompt_version: FACET_PROMPT_VERSION, facets: value.facets },
      { onConflict: "query_key,prompt_version" },
    )
    .then(({ error }) => {
      if (error) console.warn("[query-facets] db cache write failed:", error.message);
    });
}

export async function decomposeQuery(query: string): Promise<QueryFacets> {
  const key = query.trim().toLowerCase();
  const cached = cacheGet(key);
  // Only honor a cached result if it has 2+ facets — never serve the
  // deterministic single-facet fallback from cache. Pre-2026-05-13 bug: a
  // single transient Qwen failure poisoned the cache for the rest of the
  // process lifetime because cacheSet was called unconditionally.
  if (cached && cached.facets.length >= 2) return cached;

  // Persistent cache: survives process restarts (deploys) and script runs.
  const dbCached = await dbCacheGet(key);
  if (dbCached) {
    const result: QueryFacets = { ...dbCached, query };
    cacheSet(key, result);
    console.log(`[query-facets] persistent cache hit for "${query.slice(0, 60)}"`);
    return result;
  }

  // Retry Qwen up to 3 times with escalating timeout. Normal gated generation
  // is 3-9s; the first-attempt failures are cold model load / LiteLLM warmup,
  // which empirically completes within ~15-20s (the old 8s clipped it). First
  // attempt widened to 20s (2026-07-09) so the common cold-start case succeeds
  // on attempt 1 instead of falling through to the deterministic single-facet.
  // Past ~20s a non-response means a wedged GPU — deterministic is better UX
  // than a longer spinner, and the gate's 60s acquire ceiling already backstops
  // a dead GPU. Ladder kept monotonic (retries get >= time).
  const attempts: { timeout: number; backoffMs: number }[] = [
    { timeout: 20_000, backoffMs:    0 },
    { timeout: 25_000, backoffMs:  300 },
    { timeout: 30_000, backoffMs:  800 },
  ];
  for (let i = 0; i < attempts.length; i++) {
    if (attempts[i].backoffMs > 0) {
      await new Promise((r) => setTimeout(r, attempts[i].backoffMs));
    }
    const facets = await tryQwenDecomposeOnce(query, attempts[i].timeout);
    if (facets && facets.length >= 2) {
      const result: QueryFacets = { query, facets, method: "qwen" };
      cacheSet(key, result);
      dbCacheSet(key, result);
      console.log(
        `[query-facets] Qwen decomposed "${query.slice(0, 60)}" → ${facets.length} facets: ` +
          `${facets.map((f) => `${f.label}(${f.kind},${f.expansion.length}t)`).join(", ")}` +
          (i > 0 ? ` (succeeded on attempt ${i + 1})` : ""),
      );
      return result;
    }
    console.warn(`[query-facets] attempt ${i + 1} returned no usable facets`);
  }

  // All retries failed — fall through to deterministic. NOT cached so the
  // next request retries Qwen fresh instead of being permanently degraded.
  console.warn(
    `[query-facets] All Qwen retries failed for "${query.slice(0, 60)}" — using deterministic single-facet (not cached)`,
  );
  return deterministicDecompose(query);
}

// ---------------------------------------------------------------------------
// Deterministic fallback (no LLM)
// ---------------------------------------------------------------------------

function deterministicDecompose(query: string): QueryFacets {
  // Single-facet collapse: bag of content tokens. Direct/Indirect won't
  // discriminate well, but the system still functions and returns results.
  //
  // 2026-05-08: length filter changed from `> 2` to `>= 2` so 2-char
  // technical tokens like "ai" / "ml" / "rd" survive. Previously "ai" was
  // dropped silently, making the deterministic fallback useless for any
  // query about AI — the most important word disappeared from the facet.
  console.warn(
    `[query-facets] DETERMINISTIC FALLBACK fired for query="${query.slice(0, 80)}". ` +
      `Qwen failed or returned empty facets. Per-facet retrieval will degrade to a single-facet bag-of-tokens.`,
  );
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  const expansion = Array.from(new Set(tokens));
  const baseFacets: QueryFacet[] =
    expansion.length > 0
      ? [{ label: "query", expansion, required: true, kind: "topic" }]
      : [];
  return {
    query,
    facets: applySynonymBoosts(baseFacets),
    method: "deterministic",
  };
}

const STOPWORDS = new Set([
  "the","and","for","with","from","what","does","say","says","about",
  "high","quality","evidence","study","studies","research","recent",
  "new","paper","papers","this","that","these","those","into","over",
  "between","through","such","than","then","there","their","they",
  "have","has","had","been","being","will","would","could","should",
  "can","may","might","also","more","most","some","other","any","all",
]);

// ---------------------------------------------------------------------------
// Word-boundary matcher
// ---------------------------------------------------------------------------

/**
 * Strip diacritics from a string (NFD-decompose, drop combining marks).
 * Lets "México" match against "mexico", "región" match against "region",
 * "trabajó" match against "trabajo". Critical for the LAC corpus where
 * many abstracts are in Spanish.
 */
export function foldAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Build a single regex that matches any of the given terms with word-ish
 * boundaries. Phrase-multi-word terms are matched as substrings (case-
 * insensitive). Single-word terms get word boundaries to avoid "ai" matching
 * "trait" or "labor" matching "elaborate".
 *
 * The matcher is applied against accent-folded text (see foldAccents) so
 * Spanish abstracts match cleanly against English expansions.
 */
export function compileFacetMatcher(expansion: string[]): RegExp | null {
  if (expansion.length === 0) return null;
  const escapedSingles: string[] = [];
  const escapedPhrases: string[] = [];
  for (const term of expansion) {
    const t = foldAccents(term.trim().toLowerCase());
    if (!t) continue;
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (/\s/.test(t)) escapedPhrases.push(escaped);
    else escapedSingles.push(escaped);
  }
  const parts: string[] = [];
  if (escapedSingles.length > 0) {
    parts.push(`\\b(?:${escapedSingles.join("|")})\\b`);
  }
  if (escapedPhrases.length > 0) {
    parts.push(`(?:${escapedPhrases.join("|")})`);
  }
  if (parts.length === 0) return null;
  try {
    return new RegExp(parts.join("|"), "i");
  } catch (err) {
    console.error("[query-facets] regex compile error:", (err as Error).message);
    return null;
  }
}
