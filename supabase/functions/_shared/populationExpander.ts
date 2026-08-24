/**
 * populationExpander.ts
 *
 * Map each population chip label to query-expansion terms + a matcher.
 * SOFT signal only: terms are APPENDED to the query (recall) and used for a
 * small rerank boost (precision nudge). Never a hard filter.
 */

const TERMS: Record<string, string[]> = {
  'Children':            ['children', 'primary-school', 'pupils', 'kids'],
  'Adolescents / youth': ['adolescents', 'youth', 'teenagers', 'secondary students'],
  'Adults':              ['adults', 'working-age'],
  'Women / girls':       ['women', 'girls', 'female'],
  'Men / boys':          ['men', 'boys', 'male'],
  'Low-income':          ['low-income', 'disadvantaged', 'poor', 'low-SES'],
  'Middle-income':       ['middle-income', 'middle class'],
  'High-income':         ['high-income', 'affluent'],
  'Rural':               ['rural'],
  'Urban':               ['urban'],
};

function termsFor(label: string): string[] {
  return TERMS[label] ?? [label]; // free-text → literal term
}

/** Appended expansion string for the FTS/vector query. '' when no focus. */
export function expandPopulationTerms(focus: string[]): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const label of focus) {
    for (const t of termsFor(label)) {
      const k = t.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        out.push(t);
      }
    }
  }
  return out.join(' ');
}

/** Regex over a paper's text for the rerank boost. null when no focus. */
export function populationMatcher(focus: string[]): RegExp | null {
  const terms = expandPopulationTerms(focus)
    .split(/\s+/)
    .filter(Boolean)
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!terms.length) return null;
  return new RegExp(`\\b(${terms.join('|')})`, 'i');
}
