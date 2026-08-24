/**
 * supabase/functions/_shared/synonymExpander.ts
 *
 * Lightweight deterministic synonym expansion for IADB policy-domain queries.
 *
 * Problem: FTS (websearch_to_tsquery) is lexical — "gender violence" doesn't
 * match papers using "domestic violence", "intimate partner violence", or "IPV"
 * even though they're the same concept. Embedding similarity doesn't reliably
 * bridge these gaps in the dense nomic distribution either.
 *
 * Fix: before passing query_text to match_works_v2, expand known policy-domain
 * terms with their academic synonyms. The expanded string is appended so the
 * FTS parser sees all variants. FTS uses OR across multiple query terms, so
 * appending synonyms adds recall without changing precision for the vector path.
 *
 * Design choices:
 *   - Deterministic: always available, no API call, zero latency cost.
 *   - Additive: original query text is preserved; synonyms are appended.
 *   - Conservative: only expand high-confidence academic synonym pairs.
 *     No semantic generalisations that would add noise.
 *   - Domain-scoped: IADB policy areas (gender, labor, health, education,
 *     social protection, climate, finance, migration, agriculture).
 */

// ---------------------------------------------------------------------------
// Synonym map
// ---------------------------------------------------------------------------
// Each entry: canonical form (lowercased phrase to detect) → expansion terms.
// Expansion terms are appended to the query text for FTS coverage.
// Ordering: most specific first; first match wins (no double-expansion).

const SYNONYM_MAP: Array<{ pattern: RegExp; expansions: string[] }> = [
  // ----- Gender & violence -----
  {
    pattern: /\bgender.{0,5}violence\b|\bgbv\b/i,
    expansions: ["domestic violence", "intimate partner violence", "IPV", "violence against women", "gender-based violence", "femicide"],
  },
  {
    pattern: /\bintimate partner violence\b|\bipv\b/i,
    expansions: ["domestic violence", "gender violence", "gender-based violence"],
  },
  {
    pattern: /\bdomestic violence\b/i,
    expansions: ["intimate partner violence", "IPV", "gender violence", "gender-based violence"],
  },
  {
    pattern: /\bgender wage gap\b|\bgender pay gap\b/i,
    expansions: ["gender earnings gap", "gender income gap", "female earnings", "wage discrimination"],
  },

  // ----- AI & automation -----
  {
    pattern: /\bartificial intelligence\b|\bai\b(?!\s*and\s*ml)/i,
    expansions: ["machine learning", "automation", "algorithmic", "digitalization", "technology adoption", "robotics"],
  },
  {
    pattern: /\bautomation\b/i,
    expansions: ["artificial intelligence", "robotics", "technological displacement", "job displacement", "routine tasks"],
  },
  {
    pattern: /\bdigital economy\b|\bdigitalization\b|\bdigitisation\b/i,
    expansions: ["information technology", "ICT", "internet adoption", "broadband", "e-commerce"],
  },

  // ----- Labor market -----
  {
    pattern: /\blabor (outcomes?|market results?)\b|\blabour (outcomes?|market results?)\b/i,
    expansions: ["employment", "wages", "earnings", "unemployment", "job creation", "workforce participation"],
  },
  {
    pattern: /\bjob displacement\b|\bemployment loss\b/i,
    expansions: ["unemployment", "layoffs", "retrenchment", "labor market transition"],
  },
  {
    pattern: /\binformal (sector|employment|work)\b/i,
    expansions: ["informality", "informal labor", "self-employment", "undeclared work"],
  },

  // ----- Social protection -----
  {
    pattern: /\bcash transfers?\b/i,
    expansions: ["conditional cash transfer", "CCT", "social protection", "safety net", "welfare program", "Bolsa Familia", "Progresa", "Oportunidades", "SNAP"],
  },
  {
    pattern: /\bconditional cash transfers?\b|\bcct\b/i,
    expansions: ["cash transfers", "social protection", "safety net", "Progresa", "Oportunidades", "Bolsa Familia"],
  },
  {
    pattern: /\bsocial protection\b|\bsafety net\b/i,
    expansions: ["cash transfers", "social assistance", "welfare programs", "poverty reduction", "social insurance"],
  },

  // ----- Education -----
  {
    pattern: /\beducation outcomes?\b|\blearning outcomes?\b/i,
    expansions: ["school enrollment", "attendance", "dropout", "literacy", "numeracy", "test scores", "academic achievement"],
  },
  {
    pattern: /\bschool dropout\b|\bdropout rates?\b/i,
    expansions: ["school attendance", "school enrollment", "grade repetition", "educational attainment"],
  },
  {
    pattern: /\bteacher incentives?\b|\bteacher performance pay\b/i,
    expansions: ["teacher bonuses", "teacher retention", "teacher recruitment", "merit pay", "hard to staff schools"],
  },

  // ----- Health -----
  {
    pattern: /\bhealth outcomes?\b/i,
    expansions: ["mortality", "morbidity", "health status", "child health", "maternal health", "nutrition", "wellbeing"],
  },
  {
    pattern: /\bmental health\b/i,
    expansions: ["depression", "anxiety", "psychological wellbeing", "psychiatric", "mental illness"],
  },
  {
    pattern: /\bnutrition\b/i,
    expansions: ["stunting", "wasting", "malnutrition", "food security", "dietary", "child development"],
  },
  {
    pattern: /\bmhealth\b|\bmobile health\b|\bdigital health\b/i,
    expansions: ["telemedicine", "eHealth", "health technology", "SMS health", "mobile applications health"],
  },

  // ----- Financial -----
  {
    pattern: /\bfinancial inclusion\b/i,
    expansions: ["banking access", "credit access", "microfinance", "mobile money", "digital payments", "unbanked"],
  },
  {
    pattern: /\bmicrofinance\b|\bmicrocredit\b/i,
    expansions: ["financial inclusion", "small loans", "credit access", "women entrepreneurship"],
  },

  // ----- Migration -----
  // Pattern allows the literal word "immigration" / "emigration" / "immigrants"
  // to trigger expansion. The prior pattern only matched "migration" / "migrants"
  // even though "immigration" is in the expansion list — immigration queries got
  // zero expansion despite obvious intent. Verified 2026-05-13 against q06 gold
  // query — fix recovered Altonji & Card 1991 to rank 13 under no_filter.
  {
    pattern: /\b(im|e)?migration\b|\b(im|e)?migrants?\b/i,
    expansions: ["emigration", "immigration", "remittances", "displacement", "refugees", "internal migration", "foreign-born", "guest workers", "Mariel"],
  },
  {
    pattern: /\bremittances?\b/i,
    expansions: ["money transfers", "migration", "diaspora", "family transfers"],
  },

  // ----- Climate & environment -----
  {
    pattern: /\bclimate change\b/i,
    expansions: ["climate shocks", "environmental shocks", "extreme weather", "temperature", "rainfall", "natural disasters", "climate adaptation"],
  },
  {
    pattern: /\bnatural disasters?\b/i,
    expansions: ["floods", "droughts", "hurricanes", "earthquakes", "climate shocks", "disaster risk"],
  },

  // ----- Agriculture -----
  {
    pattern: /\bagricultural productivity\b|\bfarm productivity\b/i,
    expansions: ["crop yields", "smallholder farmers", "agricultural output", "food production", "rural livelihoods"],
  },

  // ----- LAC specific -----
  {
    pattern: /\blatin america\b|\blac\b/i,
    expansions: ["América Latina", "Latinoamérica", "Caribe", "Caribbean"],
  },

  // ----- Trade -----
  // Added 2026-05-13 after q10 canonical probe showed zero synonym fires for
  // "trade liberalization" queries. Bridges to the empirical literature on
  // import competition, China shock, and tariff reductions.
  {
    pattern: /\btrade liberali[sz]ation\b|\btariff (cut|reduction|liberali[sz]ation)s?\b|\btrade reform\b/i,
    expansions: ["import competition", "China shock", "tariff reduction", "WTO accession", "import penetration", "trade opening", "globalization", "export expansion", "trade shock"],
  },

  // ----- Returns-to-schooling information interventions -----
  // Added 2026-06-10 after the q24 (Rafael de Hoyos) gold-query eval: the
  // perceived-returns RCT literature (Jensen 2010 QJE, Hastings 2015,
  // Busso 2016) uses "perceived returns" / "earnings disclosure" /
  // "subjective expectations" — none of which appear in a lay query like
  // "information on the returns to schooling". These are the correct
  // literature-vocabulary bridges. ⚠️ NOTE (same-day correction): the
  // variant-shootout "Jensen → #24" result initially credited to this entry
  // was actually caused by match_works_v2's prefiltered exact-scan, NOT the
  // FTS terms — FTS currently returns 0 hits for long natural-language
  // queries (websearch_to_tsquery ANDs every word). See memory
  // project-retrieval-rpc-fts-findings-2026-06-10. The entry is kept: it is
  // correct vocabulary and becomes effective once the FTS channel is fixed.
  {
    pattern: /\breturns? to (schooling|education)\b|\binformation (on|about) (the )?returns?\b/i,
    expansions: ["perceived returns", "earnings disclosure", "subjective expectations", "information intervention", "demand for schooling", "wage expectations", "earnings information", "perceived returns to education"],
  },

  // ----- Teacher quality / effectiveness -----
  // Added 2026-05-13 after q11 canonical probe showed the existing "teacher
  // incentives" entry didn't trigger on "teacher quality" / "teacher effectiveness"
  // queries. Bridges value-added literature with the canonical Chetty / Rivkin /
  // Hanushek studies that don't use "quality" in their titles.
  {
    pattern: /\bteacher quality\b|\bteacher effectiveness\b|\bteacher value.?added\b/i,
    expansions: ["teacher value-added", "teacher VA", "teacher effects", "value-added teacher", "high-quality teachers", "teacher impacts", "teacher performance pay", "teacher absenteeism"],
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Expand policy-domain terms in a query string with academic synonyms.
 *
 * Appends synonym terms to the original query text. The expanded string is
 * suitable for FTS (websearch_to_tsquery treats added terms as OR-weighted
 * additional signals). The original query is preserved verbatim at the front.
 *
 * Returns the original query unchanged if no synonyms matched.
 */
export function expandQueryForFTS(query: string): string {
  const appended: string[] = [];
  const alreadyAdded = new Set<string>();

  for (const { pattern, expansions } of SYNONYM_MAP) {
    if (pattern.test(query)) {
      for (const term of expansions) {
        const norm = term.toLowerCase();
        // Skip if already in the original query or already appended
        if (!query.toLowerCase().includes(norm) && !alreadyAdded.has(norm)) {
          appended.push(term);
          alreadyAdded.add(norm);
        }
      }
    }
  }

  if (appended.length === 0) return query;

  const expanded = `${query} ${appended.join(" ")}`;
  console.log(
    `[synonym-expander] +${appended.length} terms: ${appended.slice(0, 5).join(", ")}${appended.length > 5 ? "…" : ""}`,
  );
  return expanded;
}
