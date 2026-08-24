import assert from 'node:assert';
import { normalizePopulationFocus, POPULATION_GROUPS } from '../types.ts';

assert.deepEqual(normalizePopulationFocus('Children & adolescents'), ['Children & adolescents']);
assert.deepEqual(normalizePopulationFocus(['Adolescents', 'Adolescents', '  ', 'Low-income']), ['Adolescents', 'Low-income']);
assert.deepEqual(normalizePopulationFocus(undefined), []);
const ids = POPULATION_GROUPS.map(g => g.id);
['children','adolescents','adults','women','men','low_income','middle_income','high_income','rural','urban'].forEach(id =>
  assert.ok(ids.includes(id), `missing ${id}`));
console.log('OK population-focus');
