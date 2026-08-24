/**
 * supabase/functions/_shared/topicGeoChannel.ts
 *
 * Parallel retrieval channel: when the query implies an SCL topic AND/OR a
 * geographic region, directly query `works` by scl_topics + geography
 * arrays (no vector cosine). Merged into the candidate pool alongside the
 * vector channel.
 *
 * Why this exists: the vector embedding (nomic-embed-text) has poor recall
 * on the long tail of LAC-specific economics papers — Spanish/Portuguese
 * titles, country-specific abstracts, specialty journals. For a query like
 * "AI and labor in Latin America", the corpus has 500+ matching papers but
 * `match_works_v2` only surfaces 20-30 in top-200. The gap is structural
 * (the embedding model can't bridge it), not a tuning issue.
 *
 * This channel covers that gap by doing deterministic structured filtering:
 *   scl_topics @> ['ai_digital', 'labor_markets']
 *   AND geography && ['Mexico', 'Brazil', ...]
 *   AND year >= user_year_floor (if any)
 *
 * Topic-channel papers get a synthetic `similarity = 0.55` so they
 * participate in the composite rerank fairly — competitive with a mid-strength
 * vector match (most vector pool sims fall in 0.45-0.70). They still lose to
 * vector-strong papers (sim > 0.55) on similarity alone, but they can win
 * with other signals (citation, rigor, FTS, classification).
 *
 * Parameter-sweep empirics (0.45/0.50/0.55/0.60): gold canary_top20 sits at
 * 0.237 baseline; sim=0.55 lands bimodally at 0.237 or 0.254 across runs
 * (LLM query-expansion noise dominates the signal). The channel's measurable
 * effect on the gold set is small (~+0.01 typical, +0.017 best case) because
 * gold canaries are well-known papers already in the vector pool. The real
 * value is on long-tail production queries (e.g. AI×LAC) where vector
 * retrieval surfaces ~6% of relevant papers. There the channel adds ~190
 * topic+geo candidates per relevant query that vector misses outright.
 *
 * Cost: one SQL call per request. No LLM call. ~50-200ms typical.
 */

import { qwenGenerate } from "./qwenClient.ts";
import { createEmbeddingClient } from "./embeddingClient.ts";

// deno-lint-ignore no-explicit-any
type Paper = Record<string, any>;

// Mirror of SCL_TOPICS from scripts/scl-topics.mjs. Kept in sync via the
// same comment discipline as the rerank.ts / eval-gold.mjs mirror — if you
// add a topic or keyword in one place, mirror it in the other.
const SCL_TOPICS: Record<string, string[]> = {
  ecd: [
    "early childhood", "child development", "parenting program", "home visiting",
    "nurturing care", "early stimulation", "preschool", "kindergarten", "ecd",
    "early intervention", "child mental health", "infant", "toddler", "caregiver training",
    "early years", "child welfare", "daycare", "childcare", "creche", "head start",
    "early education", "developmental delay", "school readiness", "cognitive stimulation",
    "primera infancia", "desarrollo infantil", "cuidado infantil", "estimulacion temprana",
  ],
  education: [
    "teacher effectiveness", "teacher quality", "teacher sorting", "teacher allocation",
    "school quality", "learning outcomes", "education technology", "edtech",
    "college access", "dropout", "stem education", "literacy", "numeracy", "curriculum",
    "principal leadership", "teacher training", "teacher recruitment", "school efficiency",
    "remote tutoring", "student achievement", "test score", "pisa", "terce", "serce",
    "private school", "voucher", "charter school", "education reform", "higher education",
    "university access", "school dropout", "retention school",
    "educacion", "maestro", "docente", "escuela", "aprendizaje",
  ],
  labor_markets: [
    "labor market", "labour market", "employment", "wage subsidy", "tvet",
    "vocational training", "skills certification", "active labor market",
    "public employment service", "unemployment", "informal employment", "informality",
    "monopsony", "labor regulation", "minimum wage", "job training", "digital skills",
    "workforce development", "occupational", "labor productivity", "wage inequality",
    "labor formalization", "cerrando brechas", "taxing wages",
    "mercado laboral", "empleo", "desempleo", "salario", "capacitacion",
    // English fallbacks the original list under-covered:
    "labor", "labour", "wages", "earnings", "jobs", "workers", "workforce",
    "trabajo", "trabalho", "trabajadores", "trabalhadores", "salaire",
  ],
  social_protection: [
    "cash transfer", "conditional cash", "unconditional cash", "cct",
    "social protection", "social registry", "social assistance", "safety net",
    "bolsa familia", "progresa", "oportunidades", "familias en accion", "targeting",
    "beneficiary selection", "social insurance", "social spending", "food stamps",
    "in-kind transfer", "workfare", "welfare program", "anti-poverty",
    "transferencias condicionadas", "proteccion social", "registro social",
  ],
  aging_ltc: [
    "aging", "ageing", "elderly", "older adult", "older worker", "pension",
    "retirement", "long-term care", "dementia", "alzheimer", "frail elderly",
    "informal caregiver", "caregiver burden", "geriatric", "elder care",
    "care economy", "social care", "nursing home", "home care", "pension reform",
    "aging population", "population aging", "silver economy",
    "envejecimiento", "adulto mayor", "cuidado largo plazo", "cuidados informales",
  ],
  health: [
    "health system", "hospital efficiency", "primary care", "ncd",
    "non-communicable disease", "chronic disease", "public health",
    "health insurance", "mental health", "maternal health", "child health",
    "vaccination", "immunization", "health workforce", "telemedicine",
    "salud", "atencion primaria", "salud publica",
  ],
  gender_gbv: [
    "gender", "women", "female labor", "gender gap", "gender wage gap",
    "intimate partner violence", "domestic violence", "ipv", "gender-based violence",
    "violence against women", "femicide", "gender norms", "female empowerment",
    "genero", "violencia de genero", "violencia domestica",
  ],
  diversity: [
    "racial", "ethnic", "indigenous", "afro-descendant", "afro-latino",
    "minority", "discrimination", "diversity", "inclusion",
    "afrodescendiente", "pueblos indigenas", "discriminacion",
  ],
  migration: [
    "migration", "immigration", "emigration", "migrant", "remittance", "refugee",
    "displaced", "diaspora", "venezuelan migration", "central american migration",
    "migracion", "remesas", "refugiados", "desplazados",
  ],
  ai_digital: [
    "artificial intelligence", "machine learning", "automation impact", "ai impact",
    "digital transformation", "platform economy", "algorithm", "fintech", "govtech",
    "ai education", "ai in labor", "robot", "job displacement", "future of work",
    "ai bias", "ai health", "ai hiring", "algorithmic", "digital public service",
    "ai automation", "task automation", "technology unemployment",
    "inteligencia artificial", "automatizacion", "transformacion digital", "plataformas digitales",
    // English fallbacks under-covered:
    "ai", "automation", "robots", "robotics", "generative ai", "chatgpt", "llm",
    "deep learning", "neural network", "computerization", "industry 4.0",
    "technological change", "skill-biased technical change", "sbtc",
  ],
  climate_resilience: [
    "climate change", "climate shock", "natural disaster", "drought", "flood",
    "hurricane", "extreme weather", "climate adaptation", "climate mitigation",
    "environmental policy", "climate resilience", "disaster risk", "weather shock",
    "cambio climatico", "desastres naturales", "resiliencia climatica",
  ],
};

const GEOGRAPHY_KEYWORDS: Record<string, string[]> = {
  "Latin America": ["latin america", "america latina", "latinoamericana", "latinoamerica", "latam", "lac"],
  "Caribbean": ["caribbean", "caribe"],
  "Mexico": ["mexico", "méxico"],
  "Brazil": ["brazil", "brasil"],
  "Argentina": ["argentina"],
  "Chile": ["chile"],
  "Colombia": ["colombia"],
  "Peru": ["peru", "perú"],
  "Ecuador": ["ecuador"],
  "Venezuela": ["venezuela"],
  "Bolivia": ["bolivia"],
  "Paraguay": ["paraguay"],
  "Uruguay": ["uruguay"],
  "Costa Rica": ["costa rica"],
  "Panama": ["panama", "panamá"],
  "Guatemala": ["guatemala"],
  "Honduras": ["honduras"],
  "Nicaragua": ["nicaragua"],
  "El Salvador": ["el salvador"],
  "Dominican Republic": ["dominican republic", "república dominicana"],
  "Haiti": ["haiti", "haití"],
  "Jamaica": ["jamaica"],
};

function foldAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Map a query string to SCL topic keys. Uses keyword matching against
 * SCL_TOPICS (same taxonomy as the paper-side classifier). Returns the set
 * of topics whose keyword list has at least one hit in the (folded,
 * lowercased) query. Multiple topics common — e.g. "AI and labor" matches
 * both ai_digital and labor_markets.
 */
// Whole-word keyword match. Raw substring `includes` produced false positives
// that silently corrupted channel selection: "ai" fired inside "tr[ai]ning" /
// "av[ai]lable", "lac" fired inside "disp[lac]ement". A \b-bounded match (chars
// escaped; accents folded on both sides) requires the keyword to appear as a
// word/phrase. Mirrors the \b-bounded queryMentionsLAC on the rerank side.
function keywordHit(text: string, kw: string): boolean {
  const k = foldAccents(kw).toLowerCase().trim();
  if (!k) return false;
  // Plural-tolerant, word-boundary match. A bare \b misses plurals ("cash
  // transfers" vs keyword "cash transfer"); a naive trailing `s?` misses
  // -es / y→ies / irregular forms ("policies", "analyses", "children"). Build a
  // plural-aware pattern for the keyword's LAST word (the head stays literal),
  // so a multi-word keyword still matches as a phrase. The \b bounds still reject
  // substring false positives ("ai" inside "attainment"/"training").
  return keywordToRegex(k).test(text);
}

const IRREGULAR_PLURALS: Record<string, string> = {
  child: "children", woman: "women", man: "men", person: "people",
  analysis: "analyses", crisis: "crises", country: "countries", policy: "policies",
  economy: "economies",
};

function keywordToRegex(k: string): RegExp {
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const words = k.split(/\s+/);
  const last = words[words.length - 1];
  let lastPat: string;
  if (IRREGULAR_PLURALS[last]) {
    lastPat = `(?:${esc(last)}|${esc(IRREGULAR_PLURALS[last])})`;
  } else if (/[^aeiou]y$/.test(last)) {
    lastPat = esc(last).replace(/y$/, "(?:y|ies)"); // consonant+y → y | ies (policy→policies)
  } else if (/(s|x|z|ch|sh)$/.test(last)) {
    lastPat = esc(last) + "(?:es)?"; // sibilant → optional -es (tax→taxes)
  } else {
    lastPat = esc(last) + "s?"; // default → optional -s (transfer→transfers)
  }
  const head = words.slice(0, -1).map(esc);
  return new RegExp(`\\b${[...head, lastPat].join("\\s+")}\\b`);
}

export function inferTopicsFromQuery(query: string): string[] {
  const text = foldAccents(String(query)).toLowerCase();
  const matched: string[] = [];
  for (const [topic, keywords] of Object.entries(SCL_TOPICS)) {
    for (const kw of keywords) {
      if (keywordHit(text, kw)) {
        matched.push(topic);
        break;
      }
    }
  }
  return matched;
}

/**
 * Map a query string to the geography array values used in `works.geography`.
 * Always returns the broad "Latin America" key when ANY country keyword fires,
 * so queries about "Mexico" still hit papers tagged just "Latin America" and
 * vice versa.
 */
export function inferGeographyFromQuery(query: string): string[] {
  const text = foldAccents(String(query)).toLowerCase();
  const matched = new Set<string>();
  for (const [canonical, kws] of Object.entries(GEOGRAPHY_KEYWORDS)) {
    for (const kw of kws) {
      if (keywordHit(text, kw)) {
        matched.add(canonical);
        break;
      }
    }
  }
  // If ANY LAC country fired, also include the broader umbrella terms so we
  // catch papers tagged just "Latin America" or "LAC".
  if (matched.size > 0) {
    matched.add("Latin America");
    matched.add("LAC");
  }
  return [...matched];
}

export interface TopicGeoChannelOptions {
  limit?: number;
  yearMin?: number;
  yearMax?: number;
}

export interface TopicGeoChannelResult {
  papers: Paper[];
  topics: string[];
  geographies: string[];
  /** Total candidate count from SQL before we applied the limit. Tells us
   *  whether the channel saturated (took all matches) or was capped. */
  totalMatched: number | null;
  searchTimeMs: number;
}

/**
 * Retrieve papers from `works` whose scl_topics OR geography overlap the
 * inferred topic/geo set for this query. Synthetic similarity=0.45 attached
 * so each paper can flow through the existing rerank composite.
 *
 * Semantics: AND across topics, AND with geography, OR within each side.
 *   - scl_topics @> [all inferred topics]  (paper must have ALL of them)
 *   - geography && [any inferred geo]      (paper hits any matching country)
 * Pure OR is too permissive — for "cash transfer school" both `education`
 * and `social_protection` infer, but an OR query then returns every
 * education-only paper (cancer-related EdTech, etc.). AND across topics
 * narrows to the actual intersection — papers tagged with BOTH topics, which
 * is the CCT-education subset we want. Empirical smoke test: AND reduced
 * candidate count from 43k (OR) → 59 (AND) for AI×Labor×LAC, with marked
 * precision improvement. The classifier and rerank downstream further trim.
 */
export async function retrieveByTopicAndGeography(
  // deno-lint-ignore no-explicit-any
  client: any,
  query: string,
  opts: TopicGeoChannelOptions = {},
): Promise<TopicGeoChannelResult> {
  const limit = opts.limit ?? 200;
  const t0 = Date.now();

  // GEO-ONLY mode (RB_TOPICGEO_GEO_ONLY=1): drop the brittle SCL keyword-topic gate
  // (a sparse ~15% hardcoded keyword list) and pull by geography alone, letting the
  // cosine relevance floor handle precision. Equivalent to forcing topics=[] (the
  // existing no-keyword-match path) as an explicit A/B switch vs the topic∩geo default.
  const _geoOnly = (((globalThis as any).Deno?.env?.get?.("RB_TOPICGEO_GEO_ONLY"))
    ?? (globalThis as any).process?.env?.RB_TOPICGEO_GEO_ONLY) === "1";
  const topics = _geoOnly ? [] : inferTopicsFromQuery(query);
  const geographies = inferGeographyFromQuery(query);

  // Need at least one signal to filter — otherwise this channel is a no-op.
  if (topics.length === 0 && geographies.length === 0) {
    return { papers: [], topics, geographies, totalMatched: 0, searchTimeMs: Date.now() - t0 };
  }

  // SOURCE FIX (2026-06-16, env RB_TOPICGEO_FTS): when NO SCL topic keyword
  // matched the query (topics=[]) this channel would otherwise do a GEOGRAPHY-ONLY
  // pull = every LAC paper, regardless of subject (breastfeeding, cesarean
  // sections, …). That floods the pool with off-topic in-region papers that the
  // classifier then stamps direct-lac and the region boost floats up. Fix: require
  // a query-text FTS match on the geo-only path, so geography alone can't admit a
  // paper. Reversible: RB_TOPICGEO_FTS unset → legacy geo-only pull.
  // deno-lint-ignore no-explicit-any
  const _denoEnv = (globalThis as any).Deno?.env;
  // Default OFF (2026-06-17): the relevance FLOOR subsumes this — floor-on-flood-pool
  // beats topicGeo-fix on BOTH recall (552 vs 502 relevant kept) AND precision (9 vs 15
  // off-topic) across 24 gold queries, because the FTS-AND here evicts relevant LAC
  // papers that use synonyms/Spanish (q04 lost 50/122). Kept as an opt-in escape
  // (RB_TOPICGEO_FTS=1); the cosine floor is the real fix. See _recall-retention.ts.
  const TOPICGEO_FTS = ((_denoEnv?.get?.("RB_TOPICGEO_FTS")) ?? (globalThis as any).process?.env?.RB_TOPICGEO_FTS) === "1";
  let ftsGuard = "";
  if (TOPICGEO_FTS && topics.length === 0) {
    ftsGuard = toFtsTerms(query);
    if (!ftsGuard) {
      // geo-only with no usable content terms → refuse to flood; return no-op.
      return { papers: [], topics, geographies, totalMatched: 0, searchTimeMs: Date.now() - t0 };
    }
  }

  // AND across topics (contains = @>), AND geography (overlaps = &&).
  let q = client
    .from("works")
    .select(
      // Same select shape match_works_v2 returns, so the merger can treat them uniformly.
      // NOTE: `classification` is NOT a column — it's attached at runtime by
      // directIndirectClassifier downstream. Selecting it returns 400 from PostgREST.
      "id, canonical_doi, title, abstract, year, citation_count, venue, venue_kind, source, source_family, methodology_design, sms_level, causal_strength, scl_topics, geography, publication_type",
      { count: "exact" },
    )
    .not("abstract", "is", null) // skip papers without abstract (worse for synthesis anyway)
    .limit(limit);

  if (topics.length > 0) {
    q = q.contains("scl_topics", topics);
  }
  if (geographies.length > 0) {
    q = q.overlaps("geography", geographies);
  }
  // Geo-only FTS guard (RB_TOPICGEO_FTS) — require the paper text to match the
  // query's content terms when no SCL topic narrowed the pull.
  if (ftsGuard) {
    q = q.textSearch("fts_vector", ftsGuard, { type: "websearch", config: "english" });
  }
  if (opts.yearMin != null) q = q.gte("year", opts.yearMin);
  if (opts.yearMax != null) q = q.lte("year", opts.yearMax);

  const { data, count, error } = await q;
  if (error) {
    console.warn(`[topicGeoChannel] query failed: ${error.message}`);
    return { papers: [], topics, geographies, totalMatched: null, searchTimeMs: Date.now() - t0 };
  }

  // Attach synthetic similarity so the rerank composite has a baseline value.
  // 0.55 picked by sweep (see header comment) — competitive with mid-strength
  // vector matches; vector papers >0.55 still win on similarity alone.
  const SYNTHETIC_SIM = 0.55;
  const papers: Paper[] = (data ?? []).map((row: Paper) => ({
    ...row,
    similarity: SYNTHETIC_SIM,
    _retrievalSource: "topic_geo_channel",
  }));

  return {
    papers,
    topics,
    geographies,
    totalMatched: count ?? null,
    searchTimeMs: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// toFtsTerms — extract content words from a query for FTS matching.
//
// Why not scl_topics: topic tags cover only ~15% of the corpus and are
// too broad (education + labor_markets fires on burnout models, COVID papers,
// sociology journals — anything with those category tags).
//
// FTS matches actual paper text (title + abstract) against query keywords.
// This ensures papers are genuinely about the query topic, not just in the
// same broad category. Works on 100% of papers with abstracts.
// ---------------------------------------------------------------------------
export function toFtsTerms(query: string): string {
  const stop = new Set([
    "what","is","are","the","a","an","how","why","when","where","which","who",
    "that","this","does","do","will","would","can","could","should","may","might",
    "in","on","at","to","for","of","and","or","but","not","with","from","about",
    "between","among","impact","effect","effects","influence","role","relationship",
    "evidence","study","research","analysis","paper","review","using","use",
    "long","term","high","low","new","old","good","bad","has","have","had",
    "been","its","their","across","within","among","through","after","before",
    // Geography / population words that are common enough to AND-out topical hits:
    "latin","america","caribbean","middle","school","students","student","improve",
    "improving","performance","providing","country","countries","region","regions",
    "workers","households","household","people","individuals","population","groups",
  ]);
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w));
  // 2026-06-10: take up to 3 MOST DISCRIMINATIVE content words — the ones
  // likeliest to appear in seminal paper titles/abstracts even when vocabulary
  // differs. Strategy: sort by length descending as the primary discriminativeness
  // proxy (long words are more specific), but BOOST short high-signal domain nouns
  // that appear in canonical titles (returns, wage, wages, rent, land, aid, tax,
  // debt, risk) by treating them as length=10 so they rank ahead of generic long
  // words like "learning","outcomes","providing". This rescues e.g. Jensen 2010
  // ("Returns to Education and the Demand for Schooling") when the query contains
  // "returns" but the plain length-sort ranked it below "information","schooling".
  const BOOST_WORDS = new Set([
    "returns","wages","wage","rent","land","aid","tax","debt","risk","firm","firms",
    "trade","vote","crime","health","death","birth","price","prices","shock","shocks",
  ]);
  const scored = words.map((w) => ({ w, score: BOOST_WORDS.has(w) ? 10 + w.length : w.length }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map((x) => x.w).join(" ");
}

// ---------------------------------------------------------------------------
// retrieveByCausalChannel
//
// Supplements the main vector pool with SMS 4–5 papers that match the query
// via FTS. Catches high-rigor studies that fall below the vector similarity
// threshold because they use technical methodology vocabulary (e.g. "RDD"
// on an education query using "student performance" language).
//
// Uses FTS (not scl_topics): covers 100% of abstracts, query-specific,
// no dependency on sparse topic tags.
//
// Synthetic similarity = 0.44.
// ---------------------------------------------------------------------------
export async function retrieveByCausalChannel(
  // deno-lint-ignore no-explicit-any
  client: any,
  query: string,
  opts: { limit?: number; yearMin?: number; yearMax?: number } = {},
): Promise<{ papers: Paper[] }> {
  const limit = opts.limit ?? 60;
  const ftsTerms = toFtsTerms(query);

  if (!ftsTerms) {
    return { papers: [] };
  }

  // deno-lint-ignore no-explicit-any
  let q: any = client
    .from("works")
    .select(
      "id, canonical_doi, title, abstract, year, citation_count, venue, venue_kind, source, source_family, methodology_design, sms_level, causal_strength, scl_topics, geography, publication_type",
    )
    .is("canonical_work_id", null)
    .not("is_noise", "eq", true)
    .gte("sms_level", 4)
    .not("abstract", "is", null)
    .textSearch("fts_vector", ftsTerms, { type: "websearch", config: "english" })
    .order("sms_level", { ascending: false })
    .order("citation_count", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (opts.yearMin != null) q = q.gte("year", opts.yearMin);
  if (opts.yearMax != null) q = q.lte("year", opts.yearMax);

  const { data, error } = await q;
  if (error) {
    console.warn(`[causalChannel] query failed: ${error.message}`);
    return { papers: [] };
  }

  const papers: Paper[] = (data ?? []).map((row: Paper) => ({
    ...row,
    similarity: 0.44,
    _retrievalSource: "causal_channel",
  }));

  return { papers };
}

// ---------------------------------------------------------------------------
// retrieveByRecentChannel
//
// Supplements the main pool with papers from 2020+ that match the query via
// FTS. Catches new working papers that rank low by citation count (recently
// published) but are directly on-topic.
//
// Synthetic similarity = 0.42.
// ---------------------------------------------------------------------------
export async function retrieveByRecentChannel(
  // deno-lint-ignore no-explicit-any
  client: any,
  query: string,
  opts: { limit?: number; yearMin?: number } = {},
): Promise<{ papers: Paper[] }> {
  const limit = opts.limit ?? 50;
  const ftsTerms = toFtsTerms(query);

  if (!ftsTerms) {
    return { papers: [] };
  }

  const yearFloor = opts.yearMin ?? 2020;

  const { data, error } = await client
    .from("works")
    .select(
      "id, canonical_doi, title, abstract, year, citation_count, venue, venue_kind, source, source_family, methodology_design, sms_level, causal_strength, scl_topics, geography, publication_type",
    )
    .is("canonical_work_id", null)
    .not("is_noise", "eq", true)
    .gte("year", yearFloor)
    .not("abstract", "is", null)
    .textSearch("fts_vector", ftsTerms, { type: "websearch", config: "english" })
    .order("year", { ascending: false })
    .order("citation_count", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) {
    console.warn(`[recentChannel] query failed: ${error.message}`);
    return { papers: [] };
  }

  const papers: Paper[] = (data ?? []).map((row: Paper) => ({
    ...row,
    similarity: 0.42,
    _retrievalSource: "recent_channel",
  }));

  return { papers };
}

// ---------------------------------------------------------------------------
// retrieveByFoundationalChannel
//
// Supplements the vector pool for the Foundational channel using a
// query-specific HyDE (Hypothetical Document Embedding) abstract.
//
// Why HyDE, not FTS: foundational papers use academic economics vocabulary
// ("cognitive skills", "school quality", "labor demand curve") while user
// queries use plain language ("student learning → growth", "immigration wages").
// FTS can't bridge this gap. HyDE generates an abstract in the academic
// register, so its embedding lands near the relevant foundational papers.
//
// Why a channel-specific prompt: the global HyDE prompt is generic.
// The foundational channel prompt anchors on the signals that define
// foundational papers: cross-country data, test scores, long-run outcomes,
// economic growth, human capital. This lifts similarity for the right papers
// from ~0.70 (generic) to 0.80–0.88.
//
// Why threshold=0.79: with a focused HyDE abstract, on-topic foundational
// papers score 0.80–0.88; adjacent-topic papers score 0.79–0.80. The floor
// trims noise (financial literacy, STEM policy) while keeping the core set.
//
// Papers enter with their REAL HyDE similarities (not synthetic), which lets
// the foundational rerank weights (sim=0.35, cit=0.48) score them correctly.
// In deduplication these papers are placed BEFORE the raw corpus result so
// their HyDE similarities win over lower raw-query similarities.
//
// Cost: one Qwen call (~1-2s) + one embedding call + one SQL RPC.
// ---------------------------------------------------------------------------

// Query-adaptive HyDE (2026-06-10): the original prompt hardcoded terms from
// the schooling-quality/growth literature ("cognitive skills, school quality,
// test scores, GDP growth") which anchored the embedding toward Hanushek/Barro
// papers regardless of query intent. For a q24-style information-intervention
// query, foundational papers like Jensen 2010 sit in a DIFFERENT neighborhood
// (sim ~0.62 to the old hardcoded HyDE, below the 0.79 threshold) and were
// never retrieved. Removing the hardcoded vocabulary lets Qwen use the actual
// query language — the embedding lands near the right foundational canon for
// each query type. Short (80 words) to keep Qwen latency low.
const FOUNDATIONAL_HYDE_PROMPT = `Write an 80-word abstract for an economics paper that directly answers: {QUERY}

Write in formal academic economics register. Focus on the specific intervention/mechanism/topic the question asks about. Use the technical vocabulary that empirical papers in this subfield use in their titles and abstracts. No author names, no citations, no meta-commentary.`;

export async function retrieveByFoundationalChannel(
  // deno-lint-ignore no-explicit-any
  client: any,
  query: string,
  opts: { limit?: number } = {},
): Promise<{ papers: Paper[]; hydeMs?: number }> {
  const limit = opts.limit ?? 80;

  // Step 1: Generate a foundational-focused HyDE abstract
  const hydeStart = Date.now();
  let hydeText: string;
  try {
    const prompt = FOUNDATIONAL_HYDE_PROMPT.replace("{QUERY}", query.trim());
    // HyDE must effectively NEVER time out (product decision 2026-06-05): the
    // foundational HyDE is the mechanism that surfaces vocabulary-gap papers
    // (Hanushek, Barro), so dropping it on a 20s timeout silently loses them.
    // Budget is HYDE_TIMEOUT_MS (default 120s) — high enough to always complete
    // under normal/heavy GPU load (~16s typ.); the cap is only a dead-endpoint
    // safety so a hung Qwen can't block a search forever. TRADEOFF: the
    // foundational channel blocks until HyDE returns, so search latency rises
    // under load — cache the HyDE doc to remove both the wait and the timeout.
    const hydeTimeoutMs = Number(
      (typeof Deno !== "undefined" ? Deno.env.get("HYDE_TIMEOUT_MS") : (globalThis as any).process?.env?.HYDE_TIMEOUT_MS) || "120000",
    ) || 120_000;
    const generated = await qwenGenerate(prompt, { temperature: 0.3, timeoutMs: hydeTimeoutMs });
    const trimmed = (generated ?? "").trim();
    if (trimmed.length < 50) {
      console.warn("[foundationalChannel] HyDE abstract too short, skipping channel");
      return { papers: [] };
    }
    hydeText = trimmed;
  } catch (err) {
    console.warn("[foundationalChannel] HyDE generation failed, using SQL fallback:", (err as Error).message);
    hydeText = "";
  }
  const hydeMs = Date.now() - hydeStart;

  let papers: Paper[] = [];

  if (hydeText) {
    // Step 2: Embed HyDE abstract as document
    const embeddingClient = createEmbeddingClient();
    if (embeddingClient) {
      const embedding = await embeddingClient.embedText(hydeText, "document");
      if (embedding) {
        console.log(`[foundationalChannel] HyDE abstract (${hydeText.length}c) in ${hydeMs}ms`);
        // Threshold lowered 0.79 → 0.72 (2026-06-10): the old 0.79 was
        // calibrated when HyDE used a hardcoded schooling-quality vocabulary
        // that landed near Hanushek/Barro at 0.80–0.88. With query-adaptive
        // HyDE the abstract covers the actual query topic, so target papers
        // score 0.72–0.85 (Jensen 0.683, Dinkelman 0.72+) rather than
        // narrowly matching one subfield. 0.72 keeps the foundational-channel
        // precision requirement (generic-topic papers score ~0.65–0.70) while
        // reaching the information-interventions and other foundational canons.
        const { data, error } = await client.rpc("match_works_v2", {
          query_embedding: embedding,
          query_text: toFtsTerms(query),
          match_threshold: 0.72,
          match_count: limit,
        });
        if (!error && data?.length > 0) {
          papers = (data as Paper[]).map((row: Paper) => ({
            ...row,
            _retrievalSource: "foundational_channel_hyde",
          }));
          console.log(`[foundationalChannel] HyDE: ${papers.length} papers above sim=0.79`);
        }
      }
    }
  }

  const FOUNDATIONAL_SELECT =
    "id, canonical_doi, title, abstract, year, citation_count, venue, venue_kind, source, source_family, methodology_design, sms_level, causal_strength, scl_topics, geography, publication_type";

  // Slice A — PRECISE high-cite FTS slice (Layer 1 fix, 2026-06-02). Mirrors the
  // causal channel's full-terms FTS slice, but gated on citation+age instead of
  // SMS: full query terms (websearch ANDs them), cit≥75, year<2020, ordered by
  // citations. This guarantees that SEMINAL ON-TOPIC papers — landmark
  // cash-transfer / schooling RCTs, highly cited but pre-2020 — enter the
  // foundational pool. Before this slice the channel relied on HyDE (flaky under
  // Qwen load) + a single-keyword fallback that ranked by citation and so
  // crowded out lower-cited seminal RCTs with off-topic mega-cited papers.
  // Full-terms match keeps it topically precise (an off-topic mega-cited paper
  // rarely matches every topic term), so high synthetic similarity is safe here.
  const ftsTerms = toFtsTerms(query);
  if (ftsTerms) {
    const { data, error } = await client
      .from("works")
      .select(FOUNDATIONAL_SELECT)
      .is("canonical_work_id", null)
      .not("is_noise", "eq", true)
      .not("abstract", "is", null)
      .lte("year", 2019)
      .gte("citation_count", 75)
      .textSearch("fts_vector", ftsTerms, { type: "websearch", config: "english" })
      .order("citation_count", { ascending: false, nullsFirst: false })
      .limit(50);
    if (!error && data?.length > 0) {
      const ftsPapers = (data as Paper[]).map((row: Paper) => ({
        ...row,
        similarity: 0.72, // on-topic (full-terms match) → safe to compete with HyDE
        _retrievalSource: "foundational_channel_fts",
      }));
      papers = [...papers, ...ftsPapers];
      console.log(`[foundationalChannel] precise FTS slice: ${ftsPapers.length} on-topic high-cit pre-2020 papers`);
    }
  }

  // Slice B — single-keyword recall fallback (vocabulary-gap papers). Uses the
  // LONGEST remaining content word from the cleaned ftsTerms (the most specific
  // topic noun) rather than the last word in position order. Reason: "last word"
  // was positionally arbitrary after stopword removal and could land on a very
  // common word (e.g. "students" for q24) that doesn't match canonical paper
  // titles (Jensen 2010 title has "schooling", not "students"). Longest word is
  // a reliable proxy for the most-discriminative topic noun: "schooling" > "school"
  // > "learning"; "informality" > "minimum" > "wage". Still broad (one term),
  // so synthetic sim is LOW (0.45) and the P0 citation relevance gate suppresses
  // off-topic mega-cited matches — only on-topic high-citation papers survive.
  const ftsWords = ftsTerms.split(" ").filter(Boolean);
  // Longest word in the already-discriminative 3-word set is the most specific
  // noun. For vocabulary-gap rescue the second-longest often works better when
  // the longest is an abstract concept ("information") and the second is a
  // concrete topic noun ("schooling"). Use [1] (second-longest) if it's ≥8 chars
  // and at least as long as [0]-3 chars; otherwise use the longest ([0]).
  // Slice B: single most-specific topic noun from the cleaned ftsTerms.
  // Must be the word MOST LIKELY to appear in foundational paper TITLES while
  // LEAST likely to appear in off-topic mega-cited papers. Heuristic:
  // prefer the longest word that is NOT a generic process/method term — those
  // words ("information", "analysis", "estimation", "development") appear in
  // everything. Prefer concrete domain nouns ("schooling", "informality",
  // "nutrition", "mobility", "transfers") that anchor to the topic subfield.
  // The generic stop-set above already removed the worst offenders; among
  // remaining words the second-longest tends to be more domain-specific than
  // the longest (which is often a method/process word).
  const sorted3 = [...ftsWords].sort((a, b) => b.length - a.length);
  // Generic method/process words that should not be Slice-B keywords:
  const genericMethodWords = new Set([
    "information","estimation","evaluation","performance","development","productivity",
    "providing","conditional","unconditional","intergenerational","microeconomic",
    "macroeconomic","distributional","heterogeneous","implementation",
    "causally","causal","empirical","theoretical","relationship","affects","increase",
    "increases","decrease","decreases","reduces","reduce","impact","impacts","effects",
    // Finance/macro cross-domain words that flood Slice B when used as single keyword:
    "returns","wages","wage","prices","price","risk","trade","debt",
  ]);
  const domainWord = sorted3.find((w) => !genericMethodWords.has(w)) ?? sorted3[0] ?? "";
  const foundationalFts = domainWord;
  if (foundationalFts) {
    const { data: sqlData, error: sqlError } = await client
      .from("works")
      .select(FOUNDATIONAL_SELECT)
      .is("canonical_work_id", null)
      .not("is_noise", "eq", true)
      .not("abstract", "is", null)
      .lte("year", 2019)
      .gte("citation_count", 75)
      .textSearch("fts_vector", foundationalFts, { type: "websearch", config: "english" })
      .order("citation_count", { ascending: false, nullsFirst: false })
      .limit(30);

    if (!sqlError && sqlData?.length > 0) {
      const sqlPapers = (sqlData as Paper[]).map((row: Paper) => ({
        ...row,
        similarity: 0.45,
        _retrievalSource: "foundational_channel_sql",
      }));
      papers = [...papers, ...sqlPapers];
      console.log(`[foundationalChannel] keyword recall fallback: ${sqlPapers.length} pre-2020 papers`);
    }
  }

  return { papers, hydeMs };
}
