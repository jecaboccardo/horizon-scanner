import assert from 'node:assert';
import { expandPopulationTerms, populationMatcher } from '../supabase/functions/_shared/populationExpander.ts';

const terms = expandPopulationTerms(['Adolescents / youth', 'Low-income']);
assert.ok(/adolescents/i.test(terms) && /youth/i.test(terms), 'adolescent terms');
assert.ok(/low-income/i.test(terms) && /disadvantaged/i.test(terms), 'low-income terms');
assert.ok(/indigenous students/i.test(expandPopulationTerms(['indigenous students'])), 'free text passthrough');
assert.equal(expandPopulationTerms([]), '');
const re = populationMatcher(['Rural']);
assert.ok(re && re.test('A study of rural school enrollment'), 'matches rural');
assert.ok(re && !re.test('Urban wage premiums in cities'), 'no false match');
assert.equal(populationMatcher([]), null);
console.log('OK population-expander');
