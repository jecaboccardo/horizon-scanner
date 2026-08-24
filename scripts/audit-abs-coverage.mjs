// ABS 3+ coverage gap v3 (2010→now) — CLEAN. Fixes all three bugs:
//  1. throttle-safe OpenAlex (backoff + retry; a 429/5xx is retried, never counted as 0)
//  2. universe by SOURCE ID (type:article, 2010+) — no ISSN ambiguity
//  3. HAVE matched on the journal's FULL ISSN set (from OpenAlex source record),
//     so print/electronic-pair mismatch and "&"-vs-"and" name issues can't undercount.
// Run: node --env-file=.env <this>
const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAILTO = process.env.OPENALEX_EMAIL || "research@nextminder.com";
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = await import("node:fs");

async function oaGet(url) {
  for (let a = 0; a < 6; a++) {
    try {
      const r = await fetch(url + (url.includes("?") ? "&" : "?") + `mailto=${MAILTO}`);
      if (r.status === 429 || r.status >= 500) { await sleep(1000 * (a + 1)); continue; }
      if (r.status === 404) return { _notfound: true };
      const d = await r.json();
      return d;
    } catch { await sleep(1000 * (a + 1)); }
  }
  return null; // persistent failure → caller marks error
}

async function getJournals() {
  const r = await fetch(`${SB}/rest/v1/abs_rankings?abs_rating=in.(3,4,4*)&select=journal_name,abs_rating,field,issn`, { headers: H });
  const rows = await r.json();
  const seen = new Set(); const out = [];
  for (const x of rows) {
    if (!x.issn) continue;
    const key = x.journal_name.toLowerCase().trim();
    if (seen.has(key)) continue; seen.add(key);
    out.push({ name: x.journal_name, rating: x.abs_rating, field: x.field, absIssn: String(x.issn).trim() });
  }
  return out;
}

async function sourceInfo(absIssn) {
  const d = await oaGet(`https://api.openalex.org/sources/issn:${absIssn}`);
  if (!d) return { error: true };
  if (d._notfound || !d.id) return { notfound: true };
  const issns = Array.isArray(d.issn) && d.issn.length ? d.issn : [absIssn];
  return { sourceId: String(d.id).split("/").pop(), issns };
}
async function universeArticles(sourceId) {
  const d = await oaGet(`https://api.openalex.org/works?filter=primary_location.source.id:${sourceId},from_publication_date:2010-01-01,type:article&per_page=1`);
  if (!d) return -1;
  return d?.meta?.count ?? -1;
}
async function universeByIssn(absIssn) { // fallback when source lookup fails
  const d = await oaGet(`https://api.openalex.org/works?filter=primary_location.source.issn:${absIssn},from_publication_date:2010-01-01,type:article&per_page=1`);
  if (!d) return -1;
  return d?.meta?.count ?? -1;
}
async function haveByIssns(issns) {
  const list = issns.map((s) => `"${s}"`).join(",");
  const r = await fetch(`${SB}/rest/v1/works?journal_issn=in.(${encodeURIComponent(list)})&year=gte.2010&select=id`, {
    headers: { ...H, Prefer: "count=exact", Range: "0-0" },
  });
  const cr = r.headers.get("content-range") || "/0";
  return parseInt(cr.split("/")[1], 10) || 0;
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); } }));
  return out;
}

const journals = await getJournals();
console.log(`ABS 3+ journals: ${journals.length}`);
let done = 0;
const rows = await pool(journals, 4, async (j) => {
  const si = await sourceInfo(j.absIssn);
  let universe, issns;
  if (si.error) { universe = -1; issns = [j.absIssn]; }
  else if (si.notfound) { universe = await universeByIssn(j.absIssn); issns = [j.absIssn]; }
  else { universe = await universeArticles(si.sourceId); issns = si.issns; }
  const have = await haveByIssns(issns);
  if (++done % 40 === 0) console.log(`  …${done}/${journals.length}`);
  return { ...j, issns, universe, have };
});
fs.writeFileSync(process.env.OUT || "abs3-gap-v3.json", JSON.stringify(rows, null, 2));

const ok = rows.filter((r) => r.universe >= 0);
const errs = rows.filter((r) => r.universe < 0);
const report = (label, fields) => {
  const g = ok.filter((r) => fields.includes(r.field));
  const u = g.reduce((a, r) => a + r.universe, 0);
  const h = g.reduce((a, r) => a + Math.min(r.have, r.universe), 0); // cap: have>universe = OA type-filter strictness, not a real surplus
  console.log(`\n${label}  (${g.length} journals)`);
  console.log(`  universe : ${u.toLocaleString()}`);
  console.log(`  in corpus: ${h.toLocaleString()}  (~${u ? (100 * h / u).toFixed(0) : 0}%)`);
  console.log(`  MISSING  : ${(u - h).toLocaleString()}  (~${u ? (100 * (u - h) / u).toFixed(0) : 0}%)`);
  return g;
};
console.log(`\n================ ABS 3+ COVERAGE (2010→now) — CLEAN (source-id universe, full-ISSN have) ================`);
console.log(`evaluated ${ok.length}/${journals.length}  (errors ${errs.length}${errs.length ? ": " + errs.slice(0, 8).map((e) => e.name).join("; ") : ""})`);
const econ = report("ECONOMICS (ECON+FINANCE)", ["ECON", "FINANCE"]);
report("econ-adjacent (SOC SCI, ECON HIST, MDEV&EDU, PUB SEC, REGIONAL)", ["SOC SCI", "BUS HIST & ECON HIST", "MDEV&EDU", "PUB SEC", "REGIONAL STUDIES, PLANNING AND ENVIRONMENT"]);
report("ALL ABS 3+ fields", [...new Set(ok.map((r) => r.field))]);
console.log("\nEconomics tier breakdown:");
for (const t of ["4*", "4", "3"]) {
  const g = econ.filter((r) => r.rating === t);
  const u = g.reduce((a, r) => a + r.universe, 0), h = g.reduce((a, r) => a + Math.min(r.have, r.universe), 0);
  console.log(`  ABS ${t.padEnd(2)}: universe ${u.toLocaleString().padStart(8)} | have ${h.toLocaleString().padStart(8)} | missing ${(u - h).toLocaleString().padStart(8)}  (${g.length} j)`);
}
console.log("\nTop 25 ECONOMICS journals by missing count (real gaps):");
for (const r of econ.map((r) => ({ ...r, gap: Math.max(0, r.universe - Math.min(r.have, r.universe)) })).sort((a, b) => b.gap - a.gap).slice(0, 25)) {
  console.log(`  ${String(r.gap).padStart(6)} miss (have ${String(Math.min(r.have, r.universe)).padStart(6)}/${String(r.universe).padStart(6)}) ABS${r.rating.padEnd(2)} ${r.name}`);
}
