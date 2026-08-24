/**
 * eval-year-filter-impact.mjs
 *
 * For each of the 23 gold queries, compare retrieval with year >= 2010
 * (current prod default) vs no year floor. Both runs use the new synonym
 * map and filter_sms_min=2 to isolate the year-filter effect.
 *
 * Reports for each query:
 *   - Canary hits @50 in each config
 *   - For labeled queries, label distribution shift
 *   - The year of each top-20 paper (so we can see who the year filter drops)
 *
 * Then classifies each query into:
 *   year-floor-hurts   — canary hits drop OR labeled "relevant" count drops
 *                        when year floor is on
 *   year-floor-helps   — canary hits rise OR irrelevant count drops
 *   year-floor-neutral — no measurable difference
 *
 * Output: reports/year-filter-impact-YYYY-MM-DD.{md,json}
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
const QUERIES_PATH = join(__dir, '../evals/queries.json');

const SB = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const LLM_BASE = process.env.LLM_BASE_URL ?? 'https://llm.iotaimpact.com';
const LLM_KEY  = process.env.LLM_API_KEY;
const EMBED_MODEL = process.env.OLLAMA_EMBEDDING_MODEL ?? 'qwen3-embedding:8b';

const THRESHOLD = 0.40;
const MATCH_COUNT = 50;

// Mirrors supabase/functions/_shared/synonymExpander.ts post-2026-05-13.
const SYNONYM_MAP = [
  { pattern: /\bgender.{0,5}violence\b|\bgbv\b/i, expansions: ['domestic violence', 'intimate partner violence', 'IPV', 'violence against women', 'gender-based violence', 'femicide'] },
  { pattern: /\bintimate partner violence\b|\bipv\b/i, expansions: ['domestic violence', 'gender violence', 'gender-based violence'] },
  { pattern: /\bdomestic violence\b/i, expansions: ['intimate partner violence', 'IPV', 'gender violence', 'gender-based violence'] },
  { pattern: /\bgender wage gap\b|\bgender pay gap\b/i, expansions: ['gender earnings gap', 'gender income gap', 'female earnings', 'wage discrimination'] },
  { pattern: /\bartificial intelligence\b|\bai\b(?!\s*and\s*ml)/i, expansions: ['machine learning', 'automation', 'algorithmic', 'digitalization', 'technology adoption', 'robotics'] },
  { pattern: /\bautomation\b/i, expansions: ['artificial intelligence', 'robotics', 'technological displacement', 'job displacement', 'routine tasks'] },
  { pattern: /\bdigital economy\b|\bdigitalization\b|\bdigitisation\b/i, expansions: ['information technology', 'ICT', 'internet adoption', 'broadband', 'e-commerce'] },
  { pattern: /\blabor (outcomes?|market results?)\b|\blabour (outcomes?|market results?)\b/i, expansions: ['employment', 'wages', 'earnings', 'unemployment', 'job creation', 'workforce participation'] },
  { pattern: /\bjob displacement\b|\bemployment loss\b/i, expansions: ['unemployment', 'layoffs', 'retrenchment', 'labor market transition'] },
  { pattern: /\binformal (sector|employment|work)\b/i, expansions: ['informality', 'informal labor', 'self-employment', 'undeclared work'] },
  { pattern: /\bcash transfers?\b/i, expansions: ['conditional cash transfer', 'CCT', 'social protection', 'safety net', 'welfare program', 'Bolsa Familia', 'Progresa', 'Oportunidades', 'SNAP'] },
  { pattern: /\bconditional cash transfers?\b|\bcct\b/i, expansions: ['cash transfers', 'social protection', 'safety net', 'Progresa', 'Oportunidades', 'Bolsa Familia'] },
  { pattern: /\bsocial protection\b|\bsafety net\b/i, expansions: ['cash transfers', 'social assistance', 'welfare programs', 'poverty reduction', 'social insurance'] },
  { pattern: /\beducation outcomes?\b|\blearning outcomes?\b/i, expansions: ['school enrollment', 'attendance', 'dropout', 'literacy', 'numeracy', 'test scores', 'academic achievement'] },
  { pattern: /\bschool dropout\b|\bdropout rates?\b/i, expansions: ['school attendance', 'school enrollment', 'grade repetition', 'educational attainment'] },
  { pattern: /\bteacher incentives?\b|\bteacher performance pay\b/i, expansions: ['teacher bonuses', 'teacher retention', 'teacher recruitment', 'merit pay', 'hard to staff schools'] },
  { pattern: /\bhealth outcomes?\b/i, expansions: ['mortality', 'morbidity', 'health status', 'child health', 'maternal health', 'nutrition', 'wellbeing'] },
  { pattern: /\bmental health\b/i, expansions: ['depression', 'anxiety', 'psychological wellbeing', 'psychiatric', 'mental illness'] },
  { pattern: /\bnutrition\b/i, expansions: ['stunting', 'wasting', 'malnutrition', 'food security', 'dietary', 'child development'] },
  { pattern: /\bmhealth\b|\bmobile health\b|\bdigital health\b/i, expansions: ['telemedicine', 'eHealth', 'health technology', 'SMS health', 'mobile applications health'] },
  { pattern: /\bfinancial inclusion\b/i, expansions: ['banking access', 'credit access', 'microfinance', 'mobile money', 'digital payments', 'unbanked'] },
  { pattern: /\bmicrofinance\b|\bmicrocredit\b/i, expansions: ['financial inclusion', 'small loans', 'credit access', 'women entrepreneurship'] },
  { pattern: /\b(im|e)?migration\b|\b(im|e)?migrants?\b/i, expansions: ['emigration', 'immigration', 'remittances', 'displacement', 'refugees', 'internal migration', 'foreign-born', 'guest workers', 'Mariel'] },
  { pattern: /\bremittances?\b/i, expansions: ['money transfers', 'migration', 'diaspora', 'family transfers'] },
  { pattern: /\bclimate change\b/i, expansions: ['climate shocks', 'environmental shocks', 'extreme weather', 'temperature', 'rainfall', 'natural disasters', 'climate adaptation'] },
  { pattern: /\bnatural disasters?\b/i, expansions: ['floods', 'droughts', 'hurricanes', 'earthquakes', 'climate shocks', 'disaster risk'] },
  { pattern: /\bagricultural productivity\b|\bfarm productivity\b/i, expansions: ['crop yields', 'smallholder farmers', 'agricultural output', 'food production', 'rural livelihoods'] },
  { pattern: /\blatin america\b|\blac\b/i, expansions: ['América Latina', 'Latinoamérica', 'Caribe', 'Caribbean'] },
  { pattern: /\btrade liberali[sz]ation\b|\btariff (cut|reduction|liberali[sz]ation)s?\b|\btrade reform\b/i, expansions: ['import competition', 'China shock', 'tariff reduction', 'WTO accession', 'import penetration', 'trade opening', 'globalization', 'export expansion', 'trade shock'] },
  { pattern: /\bteacher quality\b|\bteacher effectiveness\b|\bteacher value.?added\b/i, expansions: ['teacher value-added', 'teacher VA', 'teacher effects', 'value-added teacher', 'high-quality teachers', 'teacher impacts', 'teacher performance pay', 'teacher absenteeism'] },
];

function expandQueryForFTS(query) {
  const appended = [];
  const added = new Set();
  for (const { pattern, expansions } of SYNONYM_MAP) {
    if (pattern.test(query)) {
      for (const term of expansions) {
        const norm = term.toLowerCase();
        if (!query.toLowerCase().includes(norm) && !added.has(norm)) {
          appended.push(term);
          added.add(norm);
        }
      }
    }
  }
  return appended.length === 0 ? query : `${query} ${appended.join(' ')}`;
}

async function embed(text) {
  const r = await fetch(`${LLM_BASE}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: 'search_query: ' + text }),
  });
  const j = await r.json();
  if (!j?.data?.[0]?.embedding) throw new Error('embed failed: ' + JSON.stringify(j).slice(0, 150));
  return j.data[0].embedding;
}

async function retrieve(vec, queryText, withYearFloor) {
  const params = {
    query_embedding: vec, query_text: queryText,
    match_threshold: THRESHOLD, match_count: MATCH_COUNT,
    filter_sms_min: 2,
  };
  if (withYearFloor) params.filter_min_year = 2010;
  const { data, error } = await SB.rpc('match_works_v2', params);
  if (error) return { papers: [], error: error.message };
  return { papers: data ?? [] };
}

function normDoi(d) { return (d ?? '').toLowerCase().trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, ''); }
function normTitle(t) { return (t ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); }

function scoreOne(papers, query) {
  const labels = query.labels ?? {};
  const doiToLabel = {};
  for (const e of Object.values(labels)) if (e.doi) doiToLabel[normDoi(e.doi)] = e.label;

  const top20 = papers.slice(0, 20);
  const top50 = papers.slice(0, 50);
  const hasLabels = Object.keys(labels).length > 0;
  const dist = hasLabels ? { relevant: 0, partial: 0, irrelevant: 0, unlabeled: 0 } : null;
  if (hasLabels) {
    for (const p of top20) {
      const l = doiToLabel[normDoi(p.canonical_doi)];
      if      (l === 'relevant')   dist.relevant++;
      else if (l === 'partial')    dist.partial++;
      else if (l === 'irrelevant') dist.irrelevant++;
      else                          dist.unlabeled++;
    }
  }

  const canaries = query.canary_papers ?? [];
  const byDoi   = new Map(canaries.filter(c => c.doi_hint).map(c => [normDoi(c.doi_hint), c.id]));
  const byTitle = new Map(canaries.filter(c => c.title).map(c => [normTitle(c.title), c.id]));
  const hits = new Set();
  for (const p of top50) {
    const doi = normDoi(p.canonical_doi);
    if (doi && byDoi.has(doi)) hits.add(byDoi.get(doi));
    const ttl = normTitle(p.title);
    if (ttl && byTitle.has(ttl)) hits.add(byTitle.get(ttl));
  }

  // Year span of top-20 — diagnostic for understanding what year filter drops
  const top20Years = top20.map(p => p.year).filter(y => Number.isFinite(y));
  const pre2010 = top20Years.filter(y => y < 2010).length;

  return {
    dist, canaryHits: hits.size, canaryTotal: canaries.length, hasLabels,
    top20Years, pre2010
  };
}

function classify(rawScores, floorScores, hasLabels) {
  // Compare year-floor-on vs year-floor-off
  const canDelta = floorScores.canaryHits - rawScores.canaryHits;
  let labelVerdict = null;
  if (hasLabels) {
    const relDelta = floorScores.dist.relevant - rawScores.dist.relevant;
    const irrDelta = floorScores.dist.irrelevant - rawScores.dist.irrelevant;
    labelVerdict = { relDelta, irrDelta };
  }
  // Heuristic:
  //   year-floor-hurts: canary hits drop with floor, OR relevant count drops with floor
  //   year-floor-helps: canary hits rise with floor, OR irrelevant count drops with floor
  //   year-floor-neutral: no canary delta, no label movement
  if (canDelta < 0) return 'year-floor-hurts';
  if (hasLabels && labelVerdict.relDelta < 0) return 'year-floor-hurts';
  if (canDelta > 0) return 'year-floor-helps';
  if (hasLabels && labelVerdict.irrDelta < 0) return 'year-floor-helps';
  return 'year-floor-neutral';
}

async function main() {
  if (!LLM_KEY) { console.error('LLM_API_KEY not set'); process.exit(1); }

  const evals = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  const queries = evals.queries;

  console.log(`\nYear-filter impact eval — ${queries.length} queries\n`);
  console.log(`config: match_works_v2, threshold=${THRESHOLD}, count=${MATCH_COUNT}, sms_min=2`);
  console.log(`comparing: filter_min_year=null  vs  filter_min_year=2010\n`);

  const rows = [];
  const buckets = { 'year-floor-hurts': [], 'year-floor-helps': [], 'year-floor-neutral': [] };

  for (const q of queries) {
    process.stdout.write(`▸ ${q.id.padEnd(45)} `);
    let vec;
    try { vec = await embed(q.query); } catch (e) { console.log(`embed err: ${e.message}`); continue; }
    const expanded = expandQueryForFTS(q.query);

    const noFloor = await retrieve(vec, expanded, false);
    const withFloor = await retrieve(vec, expanded, true);
    if (noFloor.error || withFloor.error) {
      console.log(`rpc err: ${noFloor.error ?? withFloor.error}`);
      continue;
    }

    const sNoFloor = scoreOne(noFloor.papers, q);
    const sWithFloor = scoreOne(withFloor.papers, q);
    const verdict = classify(sNoFloor, sWithFloor, sNoFloor.hasLabels);
    buckets[verdict].push(q.id);

    const labelTag = sNoFloor.hasLabels
      ? ` rel:${sNoFloor.dist.relevant}→${sWithFloor.dist.relevant} irr:${sNoFloor.dist.irrelevant}→${sWithFloor.dist.irrelevant}`
      : '';
    const verdictTag = verdict === 'year-floor-hurts' ? '⚠ HURTS'
                     : verdict === 'year-floor-helps' ? '✓ helps'
                     : '·neutral';
    console.log(`canary ${sNoFloor.canaryHits}→${sWithFloor.canaryHits} pre2010 ${sNoFloor.pre2010}→${sWithFloor.pre2010}${labelTag}  ${verdictTag}`);

    rows.push({
      id: q.id, class: q.retrieval_class ?? null,
      noFloor: { canaryHits: sNoFloor.canaryHits, canaryTotal: sNoFloor.canaryTotal,
                 pre2010Count: sNoFloor.pre2010, dist: sNoFloor.dist, top20Years: sNoFloor.top20Years },
      withFloor: { canaryHits: sWithFloor.canaryHits, pre2010Count: sWithFloor.pre2010,
                   dist: sWithFloor.dist, top20Years: sWithFloor.top20Years },
      verdict,
    });
  }

  console.log(`\nClassification:`);
  for (const [bucket, ids] of Object.entries(buckets)) {
    console.log(`  ${bucket}: ${ids.length}`);
    for (const id of ids) console.log(`    ${id}`);
  }

  // Markdown report
  const date = new Date().toISOString().slice(0, 10);
  const md = [];
  md.push(`# Year-filter impact — ${date}`);
  md.push('');
  md.push(`23-query sweep. For each gold query, compare \`filter_min_year=2010\` (current prod default) vs no year floor. Both runs use the post-2026-05-13 synonym map and \`filter_sms_min=2\`. Per the user policy (year is a *default*, user-overridable), we want to know which queries would benefit if a user removed the floor.`);
  md.push('');
  md.push(`## Verdict summary`);
  md.push('');
  md.push(`- **${buckets['year-floor-hurts'].length} queries:** year-floor-hurts — canary or relevant count drops with floor on (default behavior worse than no floor)`);
  md.push(`- **${buckets['year-floor-helps'].length} queries:** year-floor-helps — irrelevant drops or canary rises with floor on (default behavior better)`);
  md.push(`- **${buckets['year-floor-neutral'].length} queries:** year-floor-neutral — no measurable change`);
  md.push('');
  md.push(`## Per-query results`);
  md.push('');
  md.push('| Query | Class | Canary off→on | Pre-2010 in top-20 off→on | Labels off→on (rel / irr) | Verdict |');
  md.push('|---|---|---|---|---|---|');
  for (const r of rows) {
    const labels = r.noFloor.dist
      ? `${r.noFloor.dist.relevant}→${r.withFloor.dist.relevant} / ${r.noFloor.dist.irrelevant}→${r.withFloor.dist.irrelevant}`
      : '—';
    const verdictTag = r.verdict === 'year-floor-hurts' ? '⚠ hurts' : r.verdict === 'year-floor-helps' ? '✓ helps' : '·neutral';
    md.push(`| ${r.id} | ${r.class ?? '—'} | ${r.noFloor.canaryHits}→${r.withFloor.canaryHits} (of ${r.noFloor.canaryTotal}) | ${r.noFloor.pre2010Count}→${r.withFloor.pre2010Count} | ${labels} | ${verdictTag} |`);
  }
  md.push('');
  md.push('## Interpretation');
  md.push('');
  md.push(`Per the user's policy ("year is a default, users can change"), this isn't a question of which value is *correct*. It's about whether the default is sane for the typical query.`);
  md.push('');
  md.push(`Queries in **year-floor-hurts** are ones where users will need to manually drop the floor to get good results. If many queries land here, the default is wrong for the typical workload. If few, the default is fine.`);
  md.push('');
  md.push(`Queries in **year-floor-helps** are ones where the default is doing real work: removing it would surface more irrelevant or unlabeled papers in top-20.`);
  md.push('');
  md.push(`**Cross-check against retrieval_class**: dense_causal queries (foundational econ literatures) are predicted to be hurt by the 2010 floor; constrained/sparse_multi queries are predicted to benefit. If the data matches this prediction, the recommended product behavior is *query-class-aware* default rather than a global default.`);

  writeFileSync(join(__dir, `../reports/year-filter-impact-${date}.md`), md.join('\n') + '\n');
  writeFileSync(join(__dir, `../reports/year-filter-impact-${date}.json`),
                JSON.stringify({ runAt: new Date().toISOString(), buckets, rows }, null, 2));
  console.log(`\nWrote reports/year-filter-impact-${date}.md\n`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
