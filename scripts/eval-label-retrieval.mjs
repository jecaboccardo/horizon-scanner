/**
 * eval-label-retrieval.mjs
 *
 * Runs match_works on unlabeled gold queries and outputs a review sheet
 * so Jess can manually label each returned paper as relevant/partial/irrelevant.
 *
 * Usage:
 *   node scripts/eval-label-retrieval.mjs                 # all unlabeled queries
 *   node scripts/eval-label-retrieval.mjs --query q04     # single query
 *   node scripts/eval-label-retrieval.mjs --all           # all queries incl. labeled
 *
 * Output: reports/label-review-YYYY-MM-DD.md (markdown) +
 *         reports/label-review-YYYY-MM-DD.json (machine-readable, for merging back)
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __dir = dirname(fileURLToPath(import.meta.url));
const EVALS_PATH = join(__dir, '../evals/queries.json');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const LLM_BASE = process.env.LLM_BASE_URL ?? 'https://llm.iotaimpact.com';
const LLM_KEY  = process.env.LLM_API_KEY;

const THRESHOLD  = 0.40;
const MATCH_COUNT = 20;

async function embedQuery(text) {
  const res = await fetch(`${LLM_BASE}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(LLM_KEY ? { Authorization: `Bearer ${LLM_KEY}` } : {}) },
    body: JSON.stringify({ model: process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:8b', input: 'search_query: ' + text }),
  });
  const json = await res.json();
  return json.data?.[0]?.embedding ?? null;
}

async function main() {
  const args = process.argv.slice(2);
  const includeAll = args.includes('--all');
  const queryFilter = args.find(a => a.startsWith('--query='))?.split('=')[1];

  const evals = JSON.parse(readFileSync(EVALS_PATH, 'utf8'));
  const queries = evals.queries.filter(q => {
    if (queryFilter) return q.id === queryFilter;
    if (includeAll) return true;
    // Default: only unlabeled queries
    return Object.keys(q.labels ?? {}).length === 0;
  });

  console.log(`\nRunning retrieval for ${queries.length} queries (threshold=${THRESHOLD}, top-${MATCH_COUNT})\n`);

  const date = new Date().toISOString().slice(0, 10);
  const mdLines = [`# Gold Eval Label Review — ${date}\n`, `**Instructions:** Label each paper as \`relevant\` / \`partial\` / \`irrelevant\` per the query intent.\n`];
  const jsonOutput = [];

  for (const query of queries) {
    console.log(`▸ ${query.id}: "${query.query.slice(0, 60)}..."`);
    const embedding = await embedQuery(query.query);
    if (!embedding) { console.error('  embed failed'); continue; }

    const { data, error } = await sb.rpc('match_works_v2', {
      query_embedding: embedding,
      query_text: query.query,
      match_threshold: THRESHOLD,
      match_count: MATCH_COUNT,
    });

    if (error) { console.error('  RPC error:', error.message); continue; }
    const papers = data ?? [];
    console.log(`  returned ${papers.length} papers`);

    mdLines.push(`---\n\n## ${query.id}\n`);
    mdLines.push(`**Query:** ${query.query}\n`);
    mdLines.push(`**Intent:** ${query.intent}\n`);
    mdLines.push('');

    const jsonPapers = [];
    papers.forEach((p, i) => {
      const sim = (p.similarity ?? 0).toFixed(3);
      const sms = p.sms_level != null ? `SMS ${p.sms_level}` : 'SMS?';
      const venue = (p.venue ?? '—').slice(0, 50);
      const abstract = (p.abstract ?? '').slice(0, 300);
      const doi = p.canonical_doi ?? '—';

      mdLines.push(`### Rank ${i + 1}: ${p.title ?? '(no title)'}`);
      mdLines.push(`- **DOI:** \`${doi}\``);
      mdLines.push(`- **Year:** ${p.year ?? '—'} | **Venue:** ${venue}`);
      mdLines.push(`- **Score:** sim=${sim} | ${sms} | cited=${p.citation_count ?? '—'}`);
      mdLines.push(`- **Abstract:** ${abstract}${abstract.length >= 300 ? '...' : ''}`);
      mdLines.push(`- **LABEL:** [ ] relevant  [ ] partial  [ ] irrelevant`);
      mdLines.push(`- **Design rank:** [ ] 1-RCT  [ ] 2-QuasiExp  [ ] 3-Obs  [ ] 4-Survey  [ ] 5-Review`);
      mdLines.push('');

      jsonPapers.push({ rank: i + 1, doi, title: p.title, year: p.year, venue: p.venue, sms_level: p.sms_level, similarity: p.similarity, citation_count: p.citation_count, abstract_snippet: abstract });
    });

    // Canary check
    const canaries = query.canary_papers ?? [];
    if (canaries.length > 0) {
      mdLines.push('### Canary check');
      const returnedDois = new Set(papers.map(p => p.canonical_doi?.toLowerCase()));
      for (const c of canaries) {
        const doi = c.doi_hint?.toLowerCase();
        const found = doi && returnedDois.has(doi);
        mdLines.push(`- ${found ? '✅' : '❌'} ${c.title?.slice(0, 80)} (${c.authors ?? '?'}, ${c.year ?? '?'})`);
        if (!found && doi) mdLines.push(`  - DOI: \`${c.doi_hint}\` — ${found ? 'IN top-20' : 'MISSING from top-20'}`);
      }
      mdLines.push('');
    }

    jsonOutput.push({ id: query.id, query: query.query, retrieved_at: new Date().toISOString(), papers: jsonPapers });
  }

  const mdPath   = join(__dir, `../reports/label-review-${date}.md`);
  const jsonPath = join(__dir, `../reports/label-review-${date}.json`);
  writeFileSync(mdPath,   mdLines.join('\n'));
  writeFileSync(jsonPath, JSON.stringify(jsonOutput, null, 2));

  console.log(`\n✓ Review sheet written:`);
  console.log(`  ${mdPath}`);
  console.log(`  ${jsonPath}`);
  console.log('\nLabel the papers in the .md file, then update evals/queries.json with the labels.');
}

main().catch(e => { console.error(e); process.exit(1); });
