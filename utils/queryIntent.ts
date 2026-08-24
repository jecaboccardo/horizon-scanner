/**
 * utils/queryIntent.ts
 *
 * Deterministic query-intent detectors for the pre-search clarifying card
 * (SearchIntentCard). NO LLM, NO latency — pure keyword/regex over the query
 * text. Detections drive query-aware clarifying questions whose answers
 * pre-check the channel boxes; the boxes remain the transparent final state.
 *
 * Eval grounding (reports/variant-shootout-2026-06-10*, probe-clarify-2026-06-10):
 *  - GEOGRAPHY is the only signal with proven retrieval value: +lac channel
 *    took Rafael's q24 canaries from absent → #1/#2 and q04 #67→#27, but
 *    REGRESSED q19 (global-canon query: Corak #2 → >#100). Hence a QUESTION
 *    with explicit "LAC focus vs global canon applied to LAC" options — never
 *    silent auto-enable.
 *  - RECENCY nudging tested slightly NEGATIVE (q21: A&R-2022 #16→#21 with
 *    +recent) — the recent channel dilutes foundational slots. The question
 *    only appears when the query itself signals recency, default No.
 *  - POPULATION focus has NO retrieval effect (q07/q15/q24 sub-search probe:
 *    canaries unmoved, cos flat-to-down). The population answer routes to
 *    BRIEF SYNTHESIS EMPHASIS ONLY (filters.populationFocus) — never to
 *    channels or retrieval predicates.
 *
 * 🔁 LAC_KEYWORDS is a COPY of REGION_KEYWORDS['LAC'] in rerank.ts /
 * retrieval.ts (frontend can't import Deno modules). scripts/check-invariants.mjs
 * asserts the three stay in sync — extend check #2 when editing.
 */

export const LAC_KEYWORDS: string[] = [
  "latin america", "latin american", "america latina", "américa latina", "latam", "lac",
  "caribbean", "caribe",
  "south america", "central america", "mesoamerica",
  "argentina", "bolivia", "brazil", "brasil",
  "chile", "colombia", "costa rica", "cuba",
  "dominican republic", "república dominicana", "ecuador", "el salvador",
  "guatemala", "haiti", "haití", "honduras",
  "jamaica", "mexico", "méxico", "nicaragua",
  "panama", "panamá", "paraguay", "peru", "perú",
  "uruguay", "venezuela",
  "barbados", "trinidad and tobago", "guyana", "suriname", "belize",
  "andean", "mercosur", "cono sur",
];

const RECENCY_KEYWORDS: string[] = [
  "recent", "latest", "newest", "emerging", "current",
  "since 2020", "2020s", "post-pandemic", "post-covid", "covid",
  "frontier", "state of the art", "new evidence", "last few years",
];

// Population groups the clarifying question can offer. Detection only decides
// which chips to SUGGEST; the user always sees "No specific focus" as default.
export interface PopulationGroup {
  id: string;
  label: string;
  keywords: string[];
}

export const POPULATION_GROUPS: PopulationGroup[] = [
  {
    id: "children",
    label: "Children & adolescents",
    keywords: ["children", "child", "adolescent", "youth", "students", "pupils", "school-age", "middle school", "high school", "secondary school", "early childhood", "infants", "kids", "teenagers"],
  },
  {
    id: "women",
    label: "Women & girls",
    keywords: ["women", "female", "girls", "gender", "mothers", "maternal", "wives"],
  },
  {
    id: "workers-informal",
    label: "Informal / low-income workers",
    keywords: ["informal workers", "informal sector", "low-income workers", "low-skill", "unskilled", "poor households", "poverty", "vulnerable"],
  },
  {
    id: "rural-farmers",
    label: "Rural households & farmers",
    keywords: ["farmers", "smallholder", "rural", "agricultural households", "peasant"],
  },
  {
    id: "migrants",
    label: "Migrants & refugees",
    keywords: ["migrants", "immigrants", "refugees", "displaced", "migrant workers"],
  },
  {
    id: "elderly",
    label: "Older adults",
    keywords: ["elderly", "older adults", "retirees", "pension", "aging", "ageing"],
  },
];

function buildKeywordRegex(keywords: string[]): RegExp {
  const escaped = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(${escaped.join("|")})\\b`, "i");
}

const LAC_REGEX = buildKeywordRegex(LAC_KEYWORDS);
const RECENCY_REGEX = buildKeywordRegex(RECENCY_KEYWORDS);

export interface QueryIntentSignals {
  /** Query names LAC or a LAC country → show the geography clarifying question. */
  mentionsLac: boolean;
  /** The specific term that matched, for question copy ("Your query mentions Mexico…"). */
  lacMatch: string | null;
  /** Query signals recency intent → show the recency question (default No). */
  mentionsRecency: boolean;
  /** Population groups detected in the query, most-specific first. */
  populations: PopulationGroup[];
}

export function detectQueryIntent(query: string): QueryIntentSignals {
  const q = String(query ?? "");
  const lacMatch = q.match(LAC_REGEX);
  const populations = POPULATION_GROUPS.filter((g) => buildKeywordRegex(g.keywords).test(q));
  return {
    mentionsLac: lacMatch !== null,
    lacMatch: lacMatch ? lacMatch[1] : null,
    mentionsRecency: RECENCY_REGEX.test(q),
    populations,
  };
}
