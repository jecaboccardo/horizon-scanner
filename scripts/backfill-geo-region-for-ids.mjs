#!/usr/bin/env node
/**
 * Targeted geography + ux_region backfill for an EXPLICIT id set (e.g. papers that
 * just gained an abstract). Mirrors the canonical corpus-wide scripts but scoped to
 * --ids-file so it only touches the rows you name:
 *   - geography: GAP-ONLY regex over title+abstract (write only if null/empty)
 *   - ux_region: recomputed from the FINAL geography (overwrite — it's derived).
 *     The shared derive-ux-region.mjs only processes ux_region IS NULL, so a row
 *     that already has a stale ['Global'] never gets re-derived after geography
 *     fills in — this script handles exactly that case.
 *
 * Region maps MIRROR scripts/backfill-geography.mjs (geography) and
 * scripts/derive-ux-region.mjs (ux_region). Keep in sync if those change.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-geo-region-for-ids.mjs --ids-file reports/newabs-session-ids.json [--dry-run]
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const IDS_FILE = (() => { const i = args.indexOf('--ids-file'); return i >= 0 ? args[i + 1] : null; })();
if (!IDS_FILE) { console.error('Provide --ids-file'); process.exit(1); }

// ---- geography map (mirror of backfill-geography.mjs) ----
const LAC = [
  ['Brazil', /\b(brazil|brasil|brazilian|brasilian)\b/i], ['Mexico', /\b(mexico|mexican)\b/i],
  ['Colombia', /\b(colombia|colombian)\b/i], ['Argentina', /\b(argentina|argentine|argentinian)\b/i],
  ['Chile', /\b(chile|chilean)\b/i], ['Peru', /\b(peru|peruvian)\b/i],
  ['Ecuador', /\b(ecuador|ecuadorian|ecuadorean)\b/i], ['Bolivia', /\b(bolivia|bolivian)\b/i],
  ['Uruguay', /\buruguay\b/i], ['Paraguay', /\bparaguay\b/i], ['Venezuela', /\b(venezuela|venezuelan)\b/i],
  ['Costa Rica', /\bcosta\s*rica\b/i], ['Panama', /\bpanama\b/i], ['Honduras', /\bhonduras\b/i],
  ['Guatemala', /\bguatemala\b/i], ['El Salvador', /\bel\s*salvador\b/i], ['Nicaragua', /\bnicaragua\b/i],
  ['Dominican Republic', /\bdominican\s*republic\b/i], ['Haiti', /\bhaiti(an)?\b/i], ['Jamaica', /\bjamaica\b/i],
  ['Trinidad and Tobago', /\btrinidad\b/i], ['Barbados', /\bbarbados\b/i], ['Guyana', /\bguyana\b/i],
  ['Suriname', /\bsuriname\b/i], ['Belize', /\bbelize\b/i],
];
const CENTRAL_AMERICA = new Set(['Honduras', 'Guatemala', 'El Salvador', 'Nicaragua', 'Costa Rica', 'Panama', 'Belize']);
const CARIBBEAN = new Set(['Dominican Republic', 'Haiti', 'Jamaica', 'Trinidad and Tobago', 'Barbados', 'Guyana', 'Suriname']);
const OTHER = [
  ['United States', /\b(united\s*states|\busa\b|\bu\.s\.a?\.?\b|american(?:s)?\b)\b/i], ['Canada', /\b(canada|canadian)\b/i],
  ['United Kingdom', /\b(united\s*kingdom|britain|british|\buk\b|england|scotland|wales)\b/i], ['Germany', /\b(germany|german)\b/i],
  ['France', /\b(france|french)\b/i], ['Italy', /\b(italy|italian)\b/i], ['Spain', /\b(spain|spanish)\b/i],
  ['Portugal', /\b(portugal|portuguese)\b/i], ['Netherlands', /\b(netherlands|dutch|holland)\b/i], ['Sweden', /\b(sweden|swedish)\b/i],
  ['Norway', /\b(norway|norwegian)\b/i], ['Denmark', /\b(denmark|danish)\b/i], ['Finland', /\b(finland|finnish)\b/i],
  ['Switzerland', /\b(switzerland|swiss)\b/i], ['Austria', /\b(austria|austrian)\b/i], ['Belgium', /\b(belgium|belgian)\b/i],
  ['Ireland', /\b(ireland|irish)\b/i], ['Greece', /\b(greece|greek)\b/i], ['Poland', /\b(poland|polish)\b/i],
  ['Turkey', /\b(turkey|t[uü]rkiye|turkish)\b/i], ['Russia', /\b(russia|russian)\b/i], ['Ukraine', /\b(ukraine|ukrainian)\b/i],
  ['China', /\b(china|chinese)\b/i], ['India', /\b(india|indian)\b/i], ['Japan', /\b(japan|japanese)\b/i],
  ['South Korea', /\b(south\s*korea|korean)\b/i], ['Indonesia', /\b(indonesia|indonesian)\b/i], ['Vietnam', /\b(vietnam|vietnamese)\b/i],
  ['Thailand', /\b(thailand|thai)\b/i], ['Philippines', /\b(philippines|filipino)\b/i], ['Malaysia', /\b(malaysia|malaysian)\b/i],
  ['Singapore', /\bsingapore\b/i], ['Pakistan', /\b(pakistan|pakistani)\b/i], ['Bangladesh', /\b(bangladesh|bangladeshi)\b/i],
  ['Sri Lanka', /\bsri\s*lanka\b/i], ['Nigeria', /\b(nigeria|nigerian)\b/i], ['Kenya', /\b(kenya|kenyan)\b/i],
  ['South Africa', /\bsouth\s*africa\b/i], ['Ethiopia', /\b(ethiopia|ethiopian)\b/i], ['Egypt', /\b(egypt|egyptian)\b/i],
  ['Morocco', /\b(morocco|moroccan)\b/i], ['Ghana', /\b(ghana|ghanaian)\b/i], ['Tanzania', /\btanzania\b/i],
  ['Uganda', /\b(uganda|ugandan)\b/i], ['Australia', /\b(australia|australian)\b/i], ['New Zealand', /\b(new\s*zealand)\b/i],
];
const OECD = new Set(['United States', 'Canada', 'United Kingdom', 'Germany', 'France', 'Italy', 'Spain', 'Portugal', 'Netherlands', 'Sweden', 'Norway', 'Denmark', 'Finland', 'Switzerland', 'Austria', 'Belgium', 'Ireland', 'Greece', 'Poland', 'Turkey', 'Japan', 'South Korea', 'Australia', 'New Zealand']);
function extractGeography(text) {
  if (!text) return [];
  const tags = new Set();
  for (const [n, re] of LAC) if (re.test(text)) tags.add(n);
  for (const [n, re] of OTHER) if (re.test(text)) tags.add(n);
  if ([...tags].some((c) => LAC.some(([n]) => n === c))) tags.add('LAC');
  if ([...tags].some((c) => CENTRAL_AMERICA.has(c))) tags.add('Central America');
  if ([...tags].some((c) => CARIBBEAN.has(c))) tags.add('Caribbean');
  if ([...tags].some((c) => OECD.has(c))) tags.add('OECD');
  if (/\b(latin\s*america|lac\b|cepal|eclac|iadb|\bidb\b)\b/i.test(text)) tags.add('LAC');
  if (/\bcaribbean\b/i.test(text)) tags.add('Caribbean');
  if (/\bcentral\s*america\b/i.test(text)) tags.add('Central America');
  if (/\b(oecd|developed\s*countries|high.income\s*countries)\b/i.test(text)) tags.add('OECD');
  if (/\b(sub.saharan\s*africa|africa)\b/i.test(text)) tags.add('Africa');
  if (/\b(southeast\s*asia|south.east\s*asia)\b/i.test(text)) tags.add('Southeast Asia');
  if (/\b(south\s*asia)\b/i.test(text)) tags.add('South Asia');
  if (/\b(east\s*asia)\b/i.test(text)) tags.add('East Asia');
  if (/\b(middle\s*east)\b/i.test(text)) tags.add('Middle East');
  if (/\b(europe(an)?)\b/i.test(text)) tags.add('Europe');
  return [...tags].sort();
}

// ---- ux_region map (mirror of derive-ux-region.mjs) ----
const REGION_OF = new Map();
const addR = (region, countries) => countries.forEach((c) => REGION_OF.set(c.toLowerCase(), region));
addR('LAC', ['Brazil', 'Mexico', 'Colombia', 'Argentina', 'Chile', 'Peru', 'Ecuador', 'Bolivia', 'Uruguay', 'Paraguay', 'Venezuela', 'Costa Rica', 'Panama', 'Honduras', 'Guatemala', 'El Salvador', 'Nicaragua', 'Dominican Republic', 'Haiti', 'Jamaica', 'Trinidad and Tobago', 'Barbados', 'Guyana', 'Suriname', 'Belize', 'LAC', 'Central America', 'Caribbean']);
addR('Sub-Saharan Africa', ['Nigeria', 'Kenya', 'South Africa', 'Ethiopia', 'Ghana', 'Tanzania', 'Uganda', 'Africa']);
addR('South & Southeast Asia', ['India', 'Pakistan', 'Bangladesh', 'Sri Lanka', 'Indonesia', 'Vietnam', 'Thailand', 'Philippines', 'Malaysia', 'Singapore', 'South Asia', 'Southeast Asia']);
addR('USA and Canada', ['United States', 'Canada']);
addR('Europe & Central Asia', ['United Kingdom', 'Germany', 'France', 'Italy', 'Spain', 'Portugal', 'Netherlands', 'Sweden', 'Norway', 'Denmark', 'Finland', 'Switzerland', 'Austria', 'Belgium', 'Ireland', 'Greece', 'Poland', 'Turkey', 'Russia', 'Ukraine', 'Europe']);
addR('MENA', ['Egypt', 'Morocco', 'Middle East']);
const uxRegion = (geo) => { const b = new Set(); for (const t of (geo || [])) { const r = REGION_OF.get(String(t).toLowerCase()); if (r) b.add(r); } return b.size ? [...b].sort() : ['Global']; };
const eqArr = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

const raw = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8'));
const ids = [...new Set(raw.ids || raw)];
console.log(`ids: ${ids.length} | dry-run: ${DRY}`);

let geoWritten = 0, geoSkipped = 0, uxWritten = 0, uxSame = 0, errs = 0;
for (let i = 0; i < ids.length; i += 100) {
  const chunk = ids.slice(i, i + 100);
  const { data, error } = await sb.from('works').select('id,title,abstract,geography,ux_region,is_noise,canonical_work_id').in('id', chunk);
  if (error) { console.error(error.message); break; }
  for (const w of data || []) {
    if (w.is_noise || w.canonical_work_id) continue;
    const hadGeo = Array.isArray(w.geography) && w.geography.length > 0;
    let finalGeo = w.geography || [];
    if (!hadGeo) {
      const geo = extractGeography(`${w.title || ''} ${w.abstract || ''}`);
      if (geo.length) {
        finalGeo = geo;
        if (!DRY) { const { error: e } = await sb.from('works').update({ geography: geo }).eq('id', w.id).or('geography.is.null,geography.eq.{}'); if (e) { errs++; continue; } }
        geoWritten++;
      } else { geoSkipped++; }
    }
    const ux = uxRegion(finalGeo);
    if (eqArr(ux, w.ux_region)) { uxSame++; }
    else { if (!DRY) { const { error: e } = await sb.from('works').update({ ux_region: ux }).eq('id', w.id); if (e) { errs++; continue; } } uxWritten++; }
  }
  process.stdout.write(`\r  ${Math.min(i + 100, ids.length)}/${ids.length} | geo+${geoWritten} (noMatch ${geoSkipped}) | ux+${uxWritten} (same ${uxSame}) | err ${errs}`);
}
console.log(`\nDone. geography written: ${geoWritten} | no country match: ${geoSkipped} | ux_region updated: ${uxWritten} (unchanged ${uxSame}) | errors: ${errs}`);
