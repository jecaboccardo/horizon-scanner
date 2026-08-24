/**
 * scripts/eval-rafaelde-live.mjs
 *
 * End-to-end eval against the LIVE deployed API for Rafael's query with
 * foundational + lac channels. Tests the v106 LAC soft-boost + balanced floor.
 *
 * Reports:
 *  - Jensen 2010 rank (the canonical foundational+LAC canary)
 *  - direct / indirect mix (balanced-floor check)
 *  - LAC / global mix (soft-boost check — global canon must survive)
 *  - SMS distribution (foundational should NOT be SMS-dominated)
 *  - top-20 listing
 *
 * Usage: node --env-file="D:/IADB work/Horizon-scanner-IADB/.env" scripts/eval-rafaelde-live.mjs
 */

import { createClient } from '@supabase/supabase-js';

const API = process.env.PROD_API_BASE || 'http://localhost:3002';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const QUERY = 'Can we improve student learning outcomes and school performance by providing them with information on the returns to schooling?';
const CHANNELS = ['foundational', 'lac'];
const JENSEN = '10.1162/qjec.2010.125.2.515';

const LAC_KW = ['latin america','caribbean','lac','latam','mexico','brazil','chile','colombia','peru','argentina','ecuador','bolivia','venezuela','uruguay','costa rica','panama','guatemala','honduras','el salvador','nicaragua','dominican republic','haiti','jamaica','barbados','trinidad','guyana','suriname','belize','andean','mercosur'];
const isLacGeo = (geo) => Array.isArray(geo) && geo.some(t => { const x=String(t).toLowerCase(); return LAC_KW.some(k=>x.includes(k)||k.includes(x)); });

async function getJwt() {
  const { data } = await sb.auth.admin.generateLink({ type: 'magiclink', email: 'horizon-scanner@iadb.org' });
  const token = data?.properties?.hashed_token || data?.hashed_token;
  // Verify against Kong to exchange for an access token
  const url = `${process.env.SUPABASE_URL}/auth/v1/verify?token=${token}&type=magiclink`;
  const resp = await fetch(url, { redirect: 'manual', headers: { apikey: process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY } });
  const loc = resp.headers.get('location') || '';
  const m = loc.match(/access_token=([^&]+)/);
  if (m) return m[1];
  // Fallback: parse from body if present
  throw new Error('could not get access_token from verify redirect: ' + loc.slice(0, 120));
}

async function main() {
  console.log('\n=== Rafael query eval (LIVE v106) — foundational + lac ===\n');
  console.log('Query:', QUERY, '\n');

  let jwt;
  try { jwt = await getJwt(); } catch (e) { console.error('Auth failed:', e.message); process.exit(1); }

  const resp = await fetch(`${API}/api/search-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'iadb-demo', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ query: QUERY, channels: CHANNELS, filters: { evidenceMatch: 'both', timePeriod: 'all', startDate: '', endDate: '', journalTiers: [1,2,3], channels: CHANNELS } }),
  });
  if (!resp.ok) { console.error('HTTP', resp.status, (await resp.text()).slice(0,300)); process.exit(1); }
  const run = await resp.json();

  const works = run.works ?? [];
  const byId = new Map(works.map(w => [w.id, w]));
  const evidenceIds = run.evidenceWorkIds ?? run.evidence_work_ids ?? [];
  const cls = run.evidenceClassification ?? {};

  const rows = evidenceIds.map(id => {
    const w = byId.get(id) || {};
    return {
      id,
      title: (w.title || '').slice(0, 50),
      year: w.year,
      cit: w.citationCount ?? w.citation_count ?? 0,
      sms: w.smsLevel ?? w.sms_level,
      geo: w.geography,
      lac: isLacGeo(w.geography),
      klass: cls[id]?.classification ?? cls[id]?.evidenceMatch ?? '?',
    };
  });

  // Jensen rank
  const jensenIdx = evidenceIds.indexOf(JENSEN);
  console.log('JENSEN 2010 rank:', jensenIdx === -1 ? 'NOT IN EVIDENCE ❌' : `#${jensenIdx + 1} ✓`);

  const top20 = rows.slice(0, 20);
  const top50 = rows.slice(0, 50);
  const pct = (n, d) => d ? Math.round(100*n/d)+'%' : '—';

  function report(label, set) {
    const direct = set.filter(r => String(r.klass).startsWith('direct')).length;
    const indirect = set.filter(r => r.klass === 'indirect').length;
    const lac = set.filter(r => r.lac).length;
    const smsVals = set.map(r => r.sms).filter(s => s != null);
    const avgSms = smsVals.length ? (smsVals.reduce((a,b)=>a+b,0)/smsVals.length).toFixed(1) : '—';
    const pre2020 = set.filter(r => r.year && r.year < 2020).length;
    console.log(`\n--- ${label} (n=${set.length}) ---`);
    console.log(`  direct: ${direct} (${pct(direct,set.length)})  indirect: ${indirect} (${pct(indirect,set.length)})`);
    console.log(`  LAC: ${lac} (${pct(lac,set.length)})  global: ${set.length-lac} (${pct(set.length-lac,set.length)})`);
    console.log(`  pre-2020 (foundational era): ${pre2020} (${pct(pre2020,set.length)})  avg SMS: ${avgSms}`);
  }
  report('TOP 20', top20);
  report('TOP 50', top50);

  console.log('\n--- TOP 20 listing [rank | yr | cit | sms | LAC | class | title] ---');
  top20.forEach((r,i) => console.log(`${String(i+1).padStart(2)} | ${r.year} | ${String(r.cit).padStart(4)} | sms${r.sms ?? '?'} | ${r.lac?'LAC':'glob'} | ${String(r.klass).padEnd(13)} | ${r.title}`));

  console.log('\nTotal evidence:', evidenceIds.length, '| extended available:', run.extendedEvidenceCount ?? 0);
}

main().catch(e => { console.error(e); process.exit(1); });
