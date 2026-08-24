/**
 * eval-synonym-impact.mjs
 *
 * Compare current_prod retrieval with raw query text vs synonym-expanded text
 * across the 23 gold queries. Reports canary hit deltas and (for labeled
 * queries) top-20 label-distribution shifts.
 *
 * Purpose: gate the synonym map additions (2026-05-13) — fix the migration
 * pattern + add trade-liberalization + add teacher-quality entries. Make
 * sure none of the 23 gold queries regress before the change ships.
 *
 * Run:
 *   node --env-file=/path/to/.env scripts/eval-synonym-impact.mjs
 *   # default: all 23 queries, current_prod config (year>=2010, sms>=2)
 *   # add --query=q05 or --class=dense_causal to narrow
 *
 * The synonym map below is kept in sync with
 * supabase/functions/_shared/synonymExpander.ts. If you edit one, edit both.
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

// Mirrors supabase/functions/_shared/synonymExpander.ts as of 2026-05-13.
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

async function retrieve(vec, queryText) {
  const { data, error } = await SB.rpc('match_works_v2', {
    query_embedding: vec, query_text: queryText,
    match_threshold: THRESHOLD, match_count: MATCH_COUNT,
    filter_min_year: 2010, filter_sms_min: 2,
  });
  if (error) return { papers: [], error: error.message };
  return { papers: data ?? [] };
}

function normDoi(d) { return (d ?? '').toLowerCase().trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, ''); }
function normTitle(t) { return (t ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); }

function score(papers, query) {
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

  return { dist, canaryHits: hits.size, canaryTotal: canaries.length, hasLabels };
}

async function main() {
  if (!LLM_KEY) { console.error('LLM_API_KEY not set'); process.exit(1); }

  const args = process.argv.slice(2);
  const queryFilter = args.find(a => a.startsWith('--query='))?.split('=')[1];
  const classFilter = args.find(a => a.startsWith('--class='))?.split('=')[1];

  const evals = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  const queries = evals.queries.filter(q => {
    if (queryFilter) return q.id === queryFilter;
    if (classFilter) return q.retrieval_class === classFilter;
    return true;
  });

  console.log(`\nSynonym impact eval — ${queries.length} queries\n`);
  console.log(`config: match_works_v2, threshold=${THRESHOLD}, count=${MATCH_COUNT}, filter_min_year=2010, filter_sms_min=2\n`);

  const rows = [];
  let totalCanaryRaw = 0, totalCanarySyn = 0;
  let totalRelevantRaw = 0, totalRelevantSyn = 0;
  let totalIrrRaw = 0, totalIrrSyn = 0;

  for (const q of queries) {
    process.stdout.write(`▸ ${q.id.padEnd(45)} `);
    let vec;
    try { vec = await embed(q.query); } catch (e) { console.log(`embed err: ${e.message}`); continue; }
    const expanded = expandQueryForFTS(q.query);
    const synAdded = expanded !== q.query ? expanded.slice(q.query.length).trim().split(/\s+/).filter(Boolean).length : 0;

    const rawRes = await retrieve(vec, q.query);
    const synRes = await retrieve(vec, expanded);
    if (rawRes.error || synRes.error) { console.log(`rpc err: ${rawRes.error ?? synRes.error}`); continue; }

    const sRaw = score(rawRes.papers, q);
    const sSyn = score(synRes.papers, q);

    const canDelta = sSyn.canaryHits - sRaw.canaryHits;
    const tag = canDelta > 0 ? `+${canDelta}` : (canDelta < 0 ? `${canDelta}` : '0');
    let labelTag = '';
    if (sRaw.hasLabels) {
      const relDelta = sSyn.dist.relevant - sRaw.dist.relevant;
      const irrDelta = sSyn.dist.irrelevant - sRaw.dist.irrelevant;
      labelTag = `  rel:${relDelta > 0 ? '+' : ''}${relDelta} irr:${irrDelta > 0 ? '+' : ''}${irrDelta}`;
      totalRelevantRaw += sRaw.dist.relevant; totalRelevantSyn += sSyn.dist.relevant;
      totalIrrRaw += sRaw.dist.irrelevant; totalIrrSyn += sSyn.dist.irrelevant;
    }
    console.log(`+${synAdded} syns  canary ${sRaw.canaryHits}→${sSyn.canaryHits} (${tag})${labelTag}`);

    totalCanaryRaw += sRaw.canaryHits;
    totalCanarySyn += sSyn.canaryHits;
    rows.push({ id: q.id, class: q.retrieval_class ?? null, synonymsAdded: synAdded,
                canaryRaw: sRaw.canaryHits, canarySyn: sSyn.canaryHits,
                canaryTotal: sRaw.canaryTotal,
                distRaw: sRaw.dist, distSyn: sSyn.dist });
  }

  console.log(`\nTotals:`);
  console.log(`  canary hits @50: raw ${totalCanaryRaw} → syn ${totalCanarySyn}  (Δ ${totalCanarySyn - totalCanaryRaw})`);
  if (totalRelevantRaw + totalRelevantSyn > 0) {
    console.log(`  relevant @20:    raw ${totalRelevantRaw} → syn ${totalRelevantSyn}  (Δ ${totalRelevantSyn - totalRelevantRaw})`);
    console.log(`  irrelevant @20:  raw ${totalIrrRaw} → syn ${totalIrrSyn}  (Δ ${totalIrrSyn - totalIrrRaw})`);
  }

  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(join(__dir, `../reports/synonym-impact-${date}.json`),
                JSON.stringify({ runAt: new Date().toISOString(), rows,
                                 totals: { canaryRaw: totalCanaryRaw, canarySyn: totalCanarySyn,
                                           relevantRaw: totalRelevantRaw, relevantSyn: totalRelevantSyn,
                                           irrelevantRaw: totalIrrRaw, irrelevantSyn: totalIrrSyn } }, null, 2));
  console.log(`\nWrote reports/synonym-impact-${date}.json\n`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
