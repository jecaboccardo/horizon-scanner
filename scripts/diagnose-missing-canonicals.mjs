/**
 * diagnose-missing-canonicals.mjs
 *
 * For each canonical paper that the position probe flagged as "out of pool"
 * (sim below the top-1000 vector cap, or sim null entirely), pull the
 * actual works row and answer:
 *
 *   1. Is the paper in `works` at all (DOI lookup)?
 *   2. Is `abstract` populated? How long? (truncation tells us a lot)
 *   3. Is `fts_vector` populated and non-empty?
 *   4. Is `embedding` populated and the expected 768 dims?
 *   5. What's the cosine similarity to the canonical query embedding?
 *   6. Where does this paper actually rank if we sort the ENTIRE corpus by
 *      cosine sim (= what position would it be at if we removed match_works_v2's
 *      LIMIT match_count*2)?
 *
 * Output: reports/missing-canonical-diag-YYYY-MM-DD.md — one row per paper,
 * one diagnosis tag (corpus-gap / abstract-truncated / embedding-stale /
 * sim-below-pool / pool-too-tight / unknown).
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LLM_BASE_URL,
 * LLM_API_KEY, OLLAMA_EMBEDDING_MODEL.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __dir = dirname(fileURLToPath(import.meta.url));
const SB = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const LLM_BASE = process.env.LLM_BASE_URL ?? 'https://llm.iotaimpact.com';
const LLM_KEY  = process.env.LLM_API_KEY;
const EMBED_MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:8b';

// Missing canonicals from canonical-position-probe-2026-05-12 (no_filter rank n/a)
// (query, label, doi)
const TARGETS = [
  // q05 — CCT → school attendance/learning
  ['q05', 'do cash transfer programs increase school attendance and learning outcomes',
   'Schultz 2004 PROGRESA',         '10.1016/j.jdeveco.2003.12.009'],
  ['q05', 'do cash transfer programs increase school attendance and learning outcomes',
   'Fiszbein & Schady 2009',        null /* no DOI in audit */],
  ['q05', 'do cash transfer programs increase school attendance and learning outcomes',
   'Behrman, Sengupta & Todd 2005', '10.1086/431263'],
  // q06 — immigration → native wages
  ['q06', 'impact of immigration on native worker wages in receiving countries',
   'Card 1990 (Mariel)',            '10.2307/2523702'],
  // q10 — trade lib → wage inequality
  ['q10', 'impact of trade liberalization on wage inequality in developing countries',
   'Autor, Dorn & Hanson 2013',     '10.1257/aer.103.6.2121'],
  // q11 — teacher quality → student learning
  ['q11', 'does teacher quality causally affect student learning outcomes',
   'Muralidharan & Sundararaman 2011', '10.1086/659655'],
  ['q11', 'does teacher quality causally affect student learning outcomes',
   'Duflo, Dupas & Kremer 2015',    '10.1016/j.jpubeco.2014.11.008'],
];

const POOL_CAP_PER_BRANCH = 100;   // match_works_v2 LIMIT match_count*2 in prod (count=50 → 100)
const PROD_THRESHOLD = 0.40;

function normDoi(d) {
  if (!d) return '';
  return d.toLowerCase().trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
}

async function embed(text) {
  if (!LLM_KEY) throw new Error('LLM_API_KEY not set');
  const r = await fetch(`${LLM_BASE}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: 'search_query: ' + text }),
  });
  const j = await r.json();
  if (!j?.data?.[0]?.embedding) throw new Error('embed failed: ' + JSON.stringify(j).slice(0, 150));
  return j.data[0].embedding;
}

function parseEmbedding(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  // pgvector text "[v1,v2,...]"
  return raw.replace(/^\[|\]$/g, '').split(',').map(Number);
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// Use SQL to find the paper's vector rank in the full corpus, not just top-N.
// This tells us "where would this paper sort by pure cosine if there were no limit".
async function findVectorRank(queryVec, paperId) {
  // Approach: count how many works have a HIGHER cosine similarity than this paper.
  // Cheaper than ordering 256k rows. Uses pgvector's <=> operator (distance, not sim).
  // similarity = 1 - distance, so HIGHER sim = LOWER distance.
  // Count of papers with distance LESS than ours.
  const { data, error } = await SB.rpc('rank_paper_by_similarity', {
    query_embedding: queryVec, paper_id: paperId,
  });
  if (!error && Array.isArray(data) && data.length > 0) {
    return { rank: data[0].rank, supported: true };
  }
  // Fallback: if the RPC doesn't exist, do a coarse N-percentile estimate by
  // sampling top-K and seeing if the paper made it in. Less precise but doesn't
  // need a custom RPC.
  for (const K of [100, 500, 2000, 10000]) {
    const { data: rows } = await SB.rpc('match_works_v2', {
      query_embedding: queryVec,
      query_text: '',                 // FTS branch yields nothing
      match_threshold: 0.0,
      match_count: K,
    });
    if (!rows) continue;
    const pos = rows.findIndex(r => r.id === paperId);
    if (pos !== -1) return { rank: pos + 1, supported: false, sampledAt: K };
  }
  return { rank: null, supported: false };
}

async function inspectPaper(doi, queryVec) {
  const norm = normDoi(doi);
  const { data, error } = await SB
    .from('works')
    .select('id, title, canonical_doi, year, citation_count, venue, sms_level, source, corpus_source, abstract, embedding, fts_vector, publication_date, updated_at')
    .ilike('canonical_doi', norm)
    .limit(2);
  if (error) return { error: error.message };
  if (!data || data.length === 0) return { found: false };
  const row = data[0];
  const dup = data.length > 1;
  const abstract = row.abstract ?? '';
  const emb = parseEmbedding(row.embedding);
  const sim = emb ? cosine(queryVec, emb) : null;
  const ftsPresent = !!row.fts_vector && row.fts_vector.length > 2;

  let diagnosis = '';
  if (!emb) diagnosis = 'embedding-missing';
  else if (!abstract || abstract.length < 200) diagnosis = `abstract-short (${abstract.length} chars)`;
  else if (sim != null && sim < PROD_THRESHOLD) diagnosis = `below-threshold (sim ${sim.toFixed(3)} < ${PROD_THRESHOLD})`;
  else diagnosis = 'in-corpus-need-rank-check';

  return {
    found: true, duplicate: dup,
    id: row.id, title: row.title, year: row.year, venue: row.venue,
    citations: row.citation_count, source: row.source, corpusSource: row.corpus_source,
    abstractLength: abstract.length,
    embeddingPresent: !!emb, embeddingDim: emb?.length ?? null,
    similarity: sim,
    ftsVectorPresent: ftsPresent,
    smsLevel: row.sms_level,
    publicationDate: row.publication_date, updatedAt: row.updated_at,
    diagnosis,
  };
}

async function main() {
  if (!LLM_KEY) { console.error('LLM_API_KEY not set'); process.exit(1); }

  const out = [];
  const queryEmbeds = new Map();

  for (const [queryId, queryText, label, doi] of TARGETS) {
    if (!doi) {
      out.push({ queryId, label, doi: null, found: false, reason: 'no DOI in audit — cannot diagnose without title match (skipped)' });
      continue;
    }
    if (!queryEmbeds.has(queryId)) {
      process.stdout.write(`Embedding query for ${queryId}... `);
      queryEmbeds.set(queryId, await embed(queryText));
      console.log('done');
    }
    const vec = queryEmbeds.get(queryId);

    process.stdout.write(`  ${label.padEnd(38)}`);
    const info = await inspectPaper(doi, vec);
    if (info.error) { console.log(`db error: ${info.error}`); out.push({ queryId, label, doi, error: info.error }); continue; }
    if (!info.found) { console.log(`NOT IN CORPUS`); out.push({ queryId, label, doi, found: false, diagnosis: 'corpus-gap' }); continue; }

    let rankInfo = { rank: null };
    if (info.embeddingPresent) {
      try {
        rankInfo = await findVectorRank(vec, info.id);
      } catch (e) {
        // ignore — rank probe is best-effort
      }
    }
    out.push({ queryId, label, doi, ...info, vectorRank: rankInfo.rank, vectorRankSupported: rankInfo.supported, sampledAt: rankInfo.sampledAt });
    console.log(`sim=${info.similarity != null ? info.similarity.toFixed(3) : 'n/a'} abs=${info.abstractLength}c rank=${rankInfo.rank ?? '?'} ${info.diagnosis}`);
  }

  // Build markdown report
  const date = new Date().toISOString().slice(0, 10);
  const md = [];
  md.push(`# Missing-canonical diagnosis — ${date}`);
  md.push('');
  md.push(`For each canonical paper flagged "out of pool" by canonical-position-probe-2026-05-12, fetch the actual works row and ask: is it missing from the corpus, does it have an abstract, is it embedded, and where does it actually rank against the query.`);
  md.push('');
  md.push(`Pool cap per branch in current_prod (match_count=50): ${POOL_CAP_PER_BRANCH} candidates. Threshold: ${PROD_THRESHOLD}. If a paper's vector rank in the full corpus is > ${POOL_CAP_PER_BRANCH} for the vector branch AND it has no FTS hit, it never reaches the RRF stage.`);
  md.push('');
  md.push('| Query | Paper | Found? | Year | Cites | Abstract chars | Sim | Vector rank | Diagnosis |');
  md.push('|---|---|---|---:|---:|---:|---:|---:|---|');
  for (const r of out) {
    if (!r.found) {
      md.push(`| ${r.queryId} | ${r.label} | **NO** | — | — | — | — | — | ${r.diagnosis ?? r.reason ?? 'unknown'} |`);
      continue;
    }
    const dup = r.duplicate ? ' ⚠ duplicate row' : '';
    md.push(`| ${r.queryId} | ${r.label}${dup} | yes | ${r.year ?? '—'} | ${r.citations ?? '—'} | ${r.abstractLength} | ${r.similarity != null ? r.similarity.toFixed(3) : '—'} | ${r.vectorRank ?? '—'} | ${r.diagnosis} |`);
  }
  md.push('');
  md.push('## Notes');
  md.push('');
  md.push(`- Pool cap interpretation: papers whose vector rank in the full corpus is ≤ ${POOL_CAP_PER_BRANCH} are candidates. Above that, they're invisible to current_prod unless FTS lifts them.`);
  md.push(`- "abstract-short" papers under 200 chars usually came from OpenAlex inverted-index reconstruction. Backfilling from Semantic Scholar / Crossref recovers the full abstract and usually raises cosine sim.`);
  md.push(`- "below-threshold" papers (sim < 0.40) won't enter even with infinite pool size. They need either re-embedding with a stronger model or hybrid scoring that brings citations / FTS earlier.`);

  writeFileSync(join(__dir, `../reports/missing-canonical-diag-${date}.md`), md.join('\n') + '\n');
  writeFileSync(join(__dir, `../reports/missing-canonical-diag-${date}.json`),
                JSON.stringify({ runAt: new Date().toISOString(), targets: TARGETS.length, results: out }, null, 2));
  console.log(`\nWrote reports/missing-canonical-diag-${date}.md`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
