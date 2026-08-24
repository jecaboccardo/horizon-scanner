import assert from 'node:assert';
// retrieval.ts pulls in the Supabase client (requires env vars) and Deno
// specifiers — not importable under Node/tsx. withPopulationTerms lives in
// the standalone retrievalPopulation.ts and is re-exported by retrieval.ts.
import { withPopulationTerms } from '../supabase/functions/_shared/retrievalPopulation.ts';
const base = 'returns to schooling information';
const out = withPopulationTerms(base, ['Adolescents / youth']);
assert.ok(out.startsWith(base), 'original query preserved (additive)');
assert.ok(/adolescents/i.test(out), 'population terms appended');
assert.equal(withPopulationTerms(base, []), base, 'no focus → unchanged');
console.log('OK retrieval-population-query');
