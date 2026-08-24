// Dedup oa:W... NBER duplicate rows into their 10.3386/w<num> twins by setting
// canonical_work_id (making the oa: row a SHADOW). Twin = better canonical (has
// DOI + abstract). Guards: WP# exact OR (title-token Jaccard >=0.6 + year +/-2 +
// first-author surname match). Dry by default; --apply writes + a rollback file.
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import fs from 'node:fs';
config();
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const APPLY = process.argv.includes('--apply');

const normTitle = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\bnber working paper(s)?( no\.?\s*\d+)?\.?/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const surname = (a) => { const f = Array.isArray(a) ? a[0] : a; const s = typeof f === 'string' ? f : (f?.name || f?.full_name || ''); const p = String(s).trim().split(/\s+/); return (p[p.length - 1] || '').toLowerCase(); };
const tok = (s) => new Set(normTitle(s).split(' ').filter((w) => w.length > 2));
const jacc = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); };
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
// strong twin verify (dedup is destructive → stricter than the abstract-copy pass)
const verify = (t, tw) => {
  if (!tw || tw.id === t.id) return false;
  const yearOk = t.year == null || tw.year == null || Math.abs(Number(t.year) - Number(tw.year)) <= 2;
  const titleOk = normTitle(t.title).length >= 30 && jacc(tok(t.title), tok(tw.title)) >= 0.6;
  const authOk = !surname(t.authors) || !surname(tw.authors) || surname(t.authors) === surname(tw.authors);
  return yearOk && titleOk && authOk;
};

// all oa: NBER canonical (non-shadow, non-noise) rows
const targets = [];
let cur = '';
while (true) {
  let q = sb.from('works').select('id, title, year, authors, abstract').like('id', 'oa:%').ilike('venue', '%NBER%')
    .is('canonical_work_id', null).not('is_noise', 'is', true).order('id', { ascending: true }).limit(1000);
  if (cur) q = q.gt('id', cur);
  const { data, error } = await q;
  if (error) { console.error(error.message); break; }
  if (!data?.length) break;
  cur = data[data.length - 1].id; targets.push(...data);
  if (data.length < 1000) break;
}
console.log(`oa: NBER canonical rows: ${targets.length}`);

let byNum = 0, byTitle = 0, unmatched = 0; const pairs = [];
for (const t of targets) {
  const m = String(t.title || '').match(/\bno\.?\s*(\d{4,6})\b/i) || String(t.title || '').match(/\bw(\d{4,6})\b/i);
  let twin = null, how = '';
  if (m) { const { data: tw } = await sb.from('works').select('id, title, year, authors, abstract, canonical_work_id').eq('id', `10.3386/w${m[1]}`).maybeSingle(); if (tw && verify(t, tw)) { twin = tw; how = 'wp#'; byNum++; } }
  if (!twin) {
    const core = normTitle(t.title).slice(0, 45).replace(/[%_]/g, ' ').trim();
    if (core.length >= 15) {
      const { data: cands } = await sb.from('works').select('id, title, year, authors, abstract, canonical_work_id').like('id', '10.3386/w%').ilike('title', `%${core}%`).limit(8);
      const best = (cands || []).find((c) => verify(t, c));
      if (best) { twin = best; how = 'title'; byTitle++; }
    }
  }
  if (!twin) { unmatched++; continue; }
  // target canonical = the twin's ultimate canonical (twin may itself be a shadow of a journal version)
  const target = twin.canonical_work_id || twin.id;
  if (target === t.id) { unmatched++; continue; }
  pairs.push({ oa: t.id, target, twin: twin.id, how, oaHadAbstract: !!t.abstract });
}
console.log(`matched (will shadow): ${pairs.length}  [wp#: ${byNum}, title: ${byTitle}]  | unmatched (left as-is): ${unmatched}`);
console.log('\nAUDIT sample (oa -> target):');
for (const p of pairs.slice(0, 10)) console.log(`  ${p.oa}  ->  ${p.target}  (${p.how})`);
fs.writeFileSync('reports/_nber-dedup-pairs.json', JSON.stringify(pairs, null, 2));

if (APPLY && pairs.length) {
  fs.writeFileSync('reports/_nber-dedup-rollback.json', JSON.stringify(pairs.map((p) => p.oa), null, 2)); // revert: set canonical_work_id=null for these
  let done = 0;
  for (const b of chunk(pairs, 25)) {
    await Promise.all(b.map(async (p) => { const { error } = await sb.from('works').update({ canonical_work_id: p.target }).eq('id', p.oa); if (!error) done++; else console.error(p.oa, error.message); }));
  }
  console.log(`\nAPPLIED ${done} shadow links. Rollback ids: reports/_nber-dedup-rollback.json (set canonical_work_id=null).`);
} else {
  console.log('\n[dry-run] re-run with --apply to write.');
}
