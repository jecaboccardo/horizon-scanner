import assert from 'node:assert';
import { rerankMerged, DEFAULT_RERANK_WEIGHTS } from '../supabase/functions/_shared/rerank.ts';

// Paper B has a tiny edge in similarity so it would rank first WITHOUT a
// population boost. The boost should flip the ranking when 'Rural' is in focus.
const papers = [
  { id: 'A', title: 'Rural adolescents and schooling', abstract: 'rural youth', similarity: 0.70 },
  { id: 'B', title: 'Urban wage premiums', abstract: 'cities', similarity: 0.71 },
];

// --- Without populationFocus: B should rank first (higher similarity) ---
const noFocus = rerankMerged(papers, {}, { query: 'schooling', weights: DEFAULT_RERANK_WEIGHTS });
assert.equal(noFocus[0].id, 'B', 'without population focus, higher-sim paper ranks first');
assert.equal(noFocus.length, 2, 'no papers dropped (no focus)');

// --- With populationFocus Rural: A should be boosted above B ---
const filters = { populationFocus: ['Rural'] };
const ranked = rerankMerged(papers, filters, { query: 'schooling', weights: DEFAULT_RERANK_WEIGHTS });
assert.equal(ranked[0].id, 'A', 'rural paper boosted above non-match at slightly lower similarity');
assert.equal(ranked.length, 2, 'soft: non-matching paper NOT dropped');

console.log('OK rerank-population-boost');
