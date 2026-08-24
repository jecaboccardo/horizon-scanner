/**
 * supabase/functions/_shared/smsClassifier.ts
 *
 * Maryland Scientific Methods Scale (SMS) classifier.
 *
 * Hybrid approach (QUAL-04):
 *   1. Keyword scan on abstract — handles ~70% of papers
 *   2. LLM fallback for ambiguous cases — plugs in at Phase 4 (Gemini)
 *
 * SMS Levels:
 *   5 = RCT (randomized controlled trial)
 *   4 = Quasi-experimental with strong identification (DiD, IV, RDD)
 *   3 = Quasi-experimental with weaker controls (matching, fixed effects, panel)
 *   2 = Correlational with some controls (OLS, cross-section)
 *   1 = Descriptive / qualitative / no causal claim
 *
 * Cached via works table columns (QUAL-06): once classified, never re-classified
 * unless sms_method = 'keyword' and an LLM upgrade is available.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PatternGroup {
  smsLevel: number;
  design: string;
  causalStrength: string;
  patterns: RegExp[];
}

interface ClassificationResult {
  smsLevel: number | null;
  design: string | null;
  causalStrength: string | null;
  smsMethod: string;
  confidence: "high" | "medium" | "low" | "cached";
  rationale?: string;
}

interface PaperInput {
  abstract?: string | null;
  title?: string | null;
}

interface BatchPaperInput extends PaperInput {
  id: string;
  sms_level?: number | null;
  methodology_design?: string | null;
  causal_strength?: string | null;
  sms_method?: string | null;
  sms_rationale?: string | null;
}

interface BatchClassificationResult extends ClassificationResult {
  id: string;
}

// ---------------------------------------------------------------------------
// Keyword patterns — ordered by SMS level (highest first)
// ---------------------------------------------------------------------------

const PATTERNS: PatternGroup[] = [
  {
    smsLevel: 5,
    design: "RCT",
    causalStrength: "high",
    // Must match RCT-specific language, not just "random" in passing
    patterns: [
      /\brandomized\s+controlled\s+trial\b/i,
      /\brandomized\s+experiment\b/i,
      /\brandom(ly)?\s+assign(ed|ment)\b/i,
      /\brandom(ized|ised)?\s+evaluation\b/i,
      /\bRCT\b/,
      /\btreatment\s+(and\s+)?control\s+group/i,
      /\bfield\s+experiment\b/i,
      /\blab(oratory)?\s+experiment\b/i,
      /\bA\/B\s+test/i,
    ],
  },
  {
    smsLevel: 4,
    design: "DiD",
    causalStrength: "high",
    patterns: [
      /\bdifference[\s-]in[\s-]difference/i,
      /\b(D[iI]D|DD)\b/,
      /\bdiff[\s-]in[\s-]diff\b/i,
    ],
  },
  {
    smsLevel: 4,
    design: "RDD",
    causalStrength: "high",
    patterns: [
      /\bregression\s+discontinuity/i,
      /\bRDD?\b/,
      /\bsharp\s+discontinuity/i,
      /\bfuzzy\s+discontinuity/i,
    ],
  },
  {
    smsLevel: 4,
    design: "IV",
    causalStrength: "high",
    patterns: [
      /\binstrumental\s+variable/i,
      /\b(IV|2SLS|TSLS)\b/,
      /\btwo[\s-]stage\s+least\s+squares/i,
    ],
  },
  {
    smsLevel: 3,
    design: "Observational",
    causalStrength: "moderate",
    patterns: [
      /\bpropensity\s+score/i,
      /\bmatching\s+(estimat|method|approach)/i,
      /\bfixed[\s-]effects?\b/i,
      /\bpanel\s+data\b/i,
      /\bsynthetic\s+control/i,
      /\bevent\s+study/i,
      /\bcontrolled?\s+for\b/i,
      /\bcovariate\s+adjustment/i,
      /\bGMM\b/,
      /\bgeneralized\s+method\s+of\s+moments/i,
    ],
  },
  {
    smsLevel: 2,
    design: "Observational",
    causalStrength: "limited",
    patterns: [
      /\bcorrelat(ion|ed|es)\b/i,
      /\bassociat(ion|ed)\b/i,
      /\bOLS\b/,
      /\bcross[\s-]section(al)?\b/i,
      /\blogistic\s+regression/i,
      /\bmultivariate\s+(regression|analysis)/i,
      /\bregression\s+analysis/i,
    ],
  },
  {
    smsLevel: 1,
    design: "Qualitative",
    causalStrength: "signal",
    patterns: [
      /\bqualitative\b/i,
      /\bcase\s+stud(y|ies)\b/i,
      /\bdescriptive\s+(analysis|statistics|study)/i,
      /\bliterature\s+review\b/i,
      /\bsystematic\s+review\b/i,
      /\bmeta[\s-]analysis/i,
      /\bsurvey\s+(of|data|results|evidence)\b/i,
      /\bethnograph/i,
      /\binterview(s|ed)?\b/i,
      /\bnarrative\b/i,
    ],
  },
  {
    smsLevel: 1,
    design: "Simulation",
    causalStrength: "signal",
    patterns: [
      /\bsimulation\b/i,
      /\bcalibrat(ion|ed)\s+model/i,
      /\bcomput(ational|able)\s+general\s+equilibrium/i,
      /\bCGE\s+model/i,
      /\bagent[\s-]based\s+model/i,
      /\bMonte\s+Carlo/i,
    ],
  },
];

// ---------------------------------------------------------------------------
// Classify a single paper
// ---------------------------------------------------------------------------

/**
 * Classify a paper's methodology using keyword scan on abstract + title.
 */
export function classifyPaper(paper: PaperInput): ClassificationResult {
  const text = [(paper.abstract ?? ""), (paper.title ?? "")].join(" ");

  if (!text.trim()) {
    return {
      smsLevel: null,
      design: null,
      causalStrength: null,
      smsMethod: "keyword",
      confidence: "low",
    };
  }

  // Scan from highest SMS level down — first match wins
  for (const group of PATTERNS) {
    for (const regex of group.patterns) {
      const match = text.match(regex);
      if (match) {
        const matchedIn =
          paper.abstract && regex.test(paper.abstract) ? "abstract" : "title";

        // The keyword scan can SUGGEST rigor but must never ASSERT it — a single
        // phrase match is too brittle for the high tiers (2026-07-15: first-match
        // "randomized experiment" over-triggered RCT/SMS5; empty-abstract title
        // hits tagged SMS4). High tiers must come from the LLM reading the methods.
        //   • cap every keyword result at SMS 3
        //   • without an abstract, cap at SMS 2 (no rigor claim from a title alone)
        // The design LABEL is kept (a genuine keyword hit), only the level is
        // damped; confidence drops to "low" so the LLM pass re-examines it.
        let level = group.smsLevel;
        let causalStrength = group.causalStrength;
        let capped = false;
        if (level > 3) { level = 3; causalStrength = "moderate"; capped = true; }
        if (!paper.abstract && level > 2) { level = 2; causalStrength = "limited"; capped = true; }

        return {
          smsLevel: level,
          design: group.design,
          causalStrength,
          smsMethod: "keyword",
          confidence: capped ? "low" : level >= 3 ? "medium" : "medium",
          rationale: `Classified SMS ${level} (${group.design}, ${causalStrength} causal strength) because ${matchedIn} contains '${match[0]}'.`
            + (capped
              ? ` Keyword-capped from SMS ${group.smsLevel}${!paper.abstract ? " (no abstract)" : ""}; awaiting LLM confirmation.`
              : ""),
        };
      }
    }
  }

  // No match — unclassified (candidate for LLM in Phase 4)
  return {
    smsLevel: null,
    design: null,
    causalStrength: null,
    smsMethod: "keyword",
    confidence: "low",
    rationale:
      "No methodology keywords detected in title or abstract. Paper is unclassified.",
  };
}

// ---------------------------------------------------------------------------
// Batch classify
// ---------------------------------------------------------------------------

/**
 * Classify an array of papers, skipping any that already have an SMS level.
 */
export function classifyBatch(
  papers: BatchPaperInput[]
): BatchClassificationResult[] {
  return papers.map((paper) => {
    // Skip already-classified papers (QUAL-06 cache)
    if (paper.sms_level != null) {
      return {
        id: paper.id,
        smsLevel: paper.sms_level,
        design: paper.methodology_design ?? null,
        causalStrength: paper.causal_strength ?? null,
        smsMethod: paper.sms_method ?? "keyword",
        confidence: "cached" as const,
        rationale: paper.sms_rationale ?? "Previously classified (cached).",
      };
    }

    const result = classifyPaper(paper);
    return { id: paper.id, ...result };
  });
}
