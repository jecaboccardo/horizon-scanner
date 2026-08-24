#!/usr/bin/env node
/**
 * eval-channels.mjs
 *
 * For a given query, shows exactly which papers each retrieval channel
 * surfaces — independently. Runs the SQL for each channel directly
 * against the DB (no vector/embedding needed for SQL-only channels).
 *
 * Usage:
 *   node --env-file=.env scripts/eval-channels.mjs \
 *     "What is the impact of student learning on productivity and long term growth?"
 */

import { createClient } from '@supabase/supabase-js';

const QUERY = process.argv[2] ?? 'What is the impact of student learning on productivity and long term growth?';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── FTS term extraction (mirrors toFtsTerms in topicGeoChannel.ts) ──

const STOP = new Set([
  'what','is','are','the','a','an','how','why','when','where','which','who',
  'that','this','does','do','will','would','can','could','should','may','might',
  'in','on','at','to','for','of','and','or','but','not','with','from','about',
  'between','among','impact','effect','effects','influence','role','relationship',
  'evidence','study','research','analysis','paper','review','using','use',
  'long','term','high','low','new','old','good','bad','has','have','had',
  'been','its','their','across','within','through','after','before',
]);

function toFtsTerms(query) {
  const words = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w));
  return words.slice(0, 4).join(' ');
}

// ── Geography inference (simplified) ──

const LAC_TERMS = ['latin america','caribbean','brazil','mexico','colombia','peru','chile','argentina','ecuador','bolivia','costa rica','panama','lac','south america','central america'];

function inferGeo(query) {
  const q = query.toLowerCase();
  return LAC_TERMS.filter(t => q.includes(t));
}

// ── Channel queries ──

async function runCausalChannel(fts, limit = 20) {
  if (!fts) return [];
  const { data, error } = await sb.from('works')
    .select('id, title, year, sms_level, citation_count, methodology_design, venue, geography')
    .is('canonical_work_id', null)
    .not('is_noise', 'eq', true)
    .gte('sms_level', 4)
    .not('abstract', 'is', null)
    .textSearch('fts_vector', fts, { type: 'websearch', config: 'english' })
    .order('sms_level', { ascending: false })
    .order('citation_count', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) { console.error('Causal channel error:', error.message); return []; }
  return data ?? [];
}

async function runRecentChannel(fts, limit = 15) {
  if (!fts) return [];
  const { data, error } = await sb.from('works')
    .select('id, title, year, sms_level, citation_count, methodology_design, venue, geography')
    .is('canonical_work_id', null)
    .not('is_noise', 'eq', true)
    .gte('year', 2020)
    .not('abstract', 'is', null)
    .textSearch('fts_vector', fts, { type: 'websearch', config: 'english' })
    .order('year', { ascending: false })
    .order('citation_count', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) { console.error('Recent channel error:', error.message); return []; }
  return data ?? [];
}

async function runLacChannel(fts, geos, limit = 20) {
  // LAC uses topicGeoChannel pattern: geography + FTS fallback
  let q = sb.from('works')
    .select('id, title, year, sms_level, citation_count, methodology_design, venue, geography')
    .is('canonical_work_id', null)
    .not('is_noise', 'eq', true)
    .not('abstract', 'is', null)
    .order('citation_count', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (geos.length) q = q.overlaps('geography', [...geos, 'Latin America', 'LAC', 'Brazil', 'Mexico', 'Colombia']);
  else if (fts)    q = q.textSearch('fts_vector', fts, { type: 'websearch', config: 'english' })
                       .overlaps('geography', ['Latin America','LAC','Brazil','Mexico','Colombia','Peru','Chile','Argentina']);
  const { data, error } = await q;
  if (error) { console.error('LAC channel error:', error.message); return []; }
  return data ?? [];
}

async function runFoundationalBaseline(fts, limit = 15) {
  // Foundational = weight-only in retrieval. Here we approximate with FTS + high citation
  if (!fts) return [];
  const { data, error } = await sb.from('works')
    .select('id, title, year, sms_level, citation_count, methodology_design, venue, geography')
    .is('canonical_work_id', null)
    .not('is_noise', 'eq', true)
    .not('abstract', 'is', null)
    .textSearch('fts_vector', fts, { type: 'websearch', config: 'english' })
    .lte('year', 2019)
    .gte('citation_count', 75)
    .order('citation_count', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) { console.error('Foundational baseline error:', error.message); return []; }
  return data ?? [];
}

// ── Display ──

function fmt(papers, label) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`CHANNEL: ${label} (${papers.length} papers)`);
  console.log('─'.repeat(70));
  if (!papers.length) { console.log('  (empty — no topic match or channel inactive)'); return; }
  papers.forEach((p, i) => {
    const sms = p.sms_level != null ? `SMS${p.sms_level}` : '   ';
    const cit = p.citation_count != null ? `${p.citation_count}cit` : '    ';
    const geo = (p.geography ?? []).slice(0, 2).join(', ') || '—';
    const method = p.methodology_design ?? '—';
    console.log(`  ${String(i+1).padStart(2)}. [${sms}|${String(cit).padStart(6)}|${method.slice(0,8).padEnd(8)}] ${p.year ?? '????'} · ${String(p.title ?? '').slice(0, 65)}`);
    console.log(`       venue: ${String(p.venue ?? '').slice(0,50)}   geo: ${geo}`);
  });
}

// ── Main ──

console.log(`\nQuery: "${QUERY}"`);
const fts  = toFtsTerms(QUERY);
const geos = inferGeo(QUERY);
console.log(`FTS terms:    "${fts}"`);
console.log(`Inferred geo: [${geos.join(', ')}]`);

const [causal, recent, lac, foundational] = await Promise.all([
  runCausalChannel(fts),
  runRecentChannel(fts),
  runLacChannel(fts, geos),
  runFoundationalBaseline(fts),
]);

fmt(causal,       '✅ CAUSAL    — SMS 4-5 papers matching topic');
fmt(recent,       '🆕 RECENT    — 2020+ papers matching topic');
fmt(lac,          '🌎 LAC       — topic + LAC geography');
fmt(foundational, '📚 FOUNDATIONAL (approx) — pre-2018, ≥100 citations, matching topic');

console.log('\n' + '═'.repeat(70));
console.log('OVERLAP ANALYSIS');
console.log('═'.repeat(70));
const causalIds = new Set(causal.map(p => p.id));
const recentIds = new Set(recent.map(p => p.id));
const lacIds    = new Set(lac.map(p => p.id));
const foundIds  = new Set(foundational.map(p => p.id));

const allIds = new Set([...causalIds, ...recentIds, ...lacIds, ...foundIds]);
let overlap = 0;
for (const id of allIds) {
  const inChannels = [causalIds, recentIds, lacIds, foundIds].filter(s => s.has(id)).length;
  if (inChannels > 1) overlap++;
}
console.log(`Total unique papers across all channels: ${allIds.size}`);
console.log(`Papers appearing in 2+ channels: ${overlap}`);
console.log(`Pure causal-only: ${[...causalIds].filter(id => !recentIds.has(id) && !lacIds.has(id) && !foundIds.has(id)).length}`);
console.log(`Pure recent-only: ${[...recentIds].filter(id => !causalIds.has(id) && !lacIds.has(id) && !foundIds.has(id)).length}`);
console.log(`Pure LAC-only:    ${[...lacIds].filter(id => !causalIds.has(id) && !recentIds.has(id) && !foundIds.has(id)).length}`);
console.log(`Pure found-only:  ${[...foundIds].filter(id => !causalIds.has(id) && !recentIds.has(id) && !lacIds.has(id)).length}`);
