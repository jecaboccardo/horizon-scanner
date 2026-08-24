import assert from 'node:assert';
import { selectionToPills } from '../utils/selectionToPills.ts';
const pills = selectionToPills(
  { evidenceMatch: 'both', populationFocus: ['Adolescents / youth','Rural'], regions: ['LAC'] },
  new Set(['causal','foundational','lac']),
);
const labels = pills.map(p => p.label);
assert.ok(labels.includes('Causal') && labels.includes('Foundational'), 'channel pills');
assert.ok(labels.includes('Region: LAC'), 'region pill');
assert.ok(labels.some(l => l.startsWith('Focus:')), 'single Focus pill for population');
assert.ok(pills.every(p => p.source), 'every pill maps to a source field');
console.log('OK selection-to-pills');
