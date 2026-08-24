// Map a paper's geography[] (country-level tags) to its UX region bucket(s) for
// display in the evidence table + exports. Mirrors UX_REGION_BY_COUNTRY in
// supabase/functions/_shared/rerank.ts (and the works.ux_region column). Display-
// only; keep the two in sync if either changes.
//
// Papers with no mapped country resolve to [] (callers may show "Global"): the
// on-screen chips stay clean (only regional papers get a chip), while exports
// fill the column with "Global".

const UX_REGION_BY_COUNTRY = new Map<string, string>();
const add = (bucket: string, countries: string[]) =>
  countries.forEach((c) => UX_REGION_BY_COUNTRY.set(c.toLowerCase(), bucket));

add('LAC', ['Brazil', 'Mexico', 'Colombia', 'Argentina', 'Chile', 'Peru', 'Ecuador', 'Bolivia', 'Uruguay', 'Paraguay', 'Venezuela', 'Costa Rica', 'Panama', 'Honduras', 'Guatemala', 'El Salvador', 'Nicaragua', 'Dominican Republic', 'Haiti', 'Jamaica', 'Trinidad and Tobago', 'Barbados', 'Guyana', 'Suriname', 'Belize', 'LAC', 'Central America', 'Caribbean', 'Latin America', 'Latin America and the Caribbean', 'Latin America and Caribbean', 'South America']);
add('Sub-Saharan Africa', ['Nigeria', 'Kenya', 'South Africa', 'Ethiopia', 'Ghana', 'Tanzania', 'Uganda', 'Africa']);
add('South & Southeast Asia', ['India', 'Pakistan', 'Bangladesh', 'Sri Lanka', 'Indonesia', 'Vietnam', 'Thailand', 'Philippines', 'Malaysia', 'Singapore', 'South Asia', 'Southeast Asia']);
add('USA and Canada', ['United States', 'Canada', 'US', 'USA']);
add('Europe & Central Asia', ['United Kingdom', 'Germany', 'France', 'Italy', 'Spain', 'Portugal', 'Netherlands', 'Sweden', 'Norway', 'Denmark', 'Finland', 'Switzerland', 'Austria', 'Belgium', 'Ireland', 'Greece', 'Poland', 'Turkey', 'Russia', 'Ukraine', 'Europe', 'UK']);
add('MENA', ['Egypt', 'Morocco', 'Middle East']);

/** Region bucket(s) for a geography[] — unique, in a stable order. Empty/unmapped → []. */
export function regionsFromGeography(geography?: string[] | null): string[] {
  const out = new Set<string>();
  for (const tag of geography ?? []) {
    const b = UX_REGION_BY_COUNTRY.get(String(tag).toLowerCase());
    if (b) out.add(b);
  }
  return [...out];
}
