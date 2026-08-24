/**
 * retrievalPopulation.ts
 *
 * Tiny standalone module — exports withPopulationTerms so unit tests can
 * import it without pulling in the full retrieval.ts dependency graph
 * (Supabase client, Deno env, etc.).
 *
 * retrieval.ts re-exports this function for production use.
 */

import { expandPopulationTerms } from "./populationExpander.ts";

/** Append population expansion terms to an (already synonym-expanded) query. Additive soft signal. */
export function withPopulationTerms(expandedQuery: string, populationFocus: string[]): string {
  const extra = expandPopulationTerms(populationFocus);
  return extra ? `${expandedQuery} ${extra}` : expandedQuery;
}
