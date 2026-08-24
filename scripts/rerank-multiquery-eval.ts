// scripts/rerank-multiquery-eval.ts
// Faithful legacy-vs-unified comparison across all dumped gold-query fixtures.
// Run: deno run --allow-read --allow-env scripts/rerank-multiquery-eval.ts
import { rerankHybrid, rerankUnified, orderByChannel, selectTopKDiverse } from "../supabase/functions/_shared/rerank.ts";
import { applyBalancedIndirectFloor, applyFoundationalCiteFloor, applyRegionFloor } from "../supabase/functions/_shared/evidenceFloors.ts";
// deno-lint-ignore no-explicit-any
type Paper = Record<string, any>;
const norm = (s: any) => String(s ?? "").toLowerCase().trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
const isLac = (p: Paper) => Array.isArray(p.geography) && p.geography.some((g: string) => /lac|latin|mexico|brazil|colombia|peru|chile|argentina|caribbean/i.test(String(g)));
const OFFTOPIC = 0.45;
// Canary→works.id map (reports/canary-id-map.json, built by _resolve-canaries.mjs):
// doi_hint doesn't match the corpus, so canaries are resolved to real works.ids.
let CANARY_MAP: Record<string, Record<string, string|null>> = {};
try { CANARY_MAP = JSON.parse(await Deno.readTextFile("reports/canary-id-map.json")); }
catch { console.warn("[warn] reports/canary-id-map.json missing — run scripts/_resolve-canaries.mjs"); }

function legacy(fx: any): Paper[] {
  const pool: Paper[] = JSON.parse(JSON.stringify(fx.pool));
  const composite = rerankHybrid(pool, { regions: fx.regions }, fx.query, fx.channels, fx.cap);
  const ev: Paper[] = selectTopKDiverse(composite.slice(0, 200), fx.cap).selected;
  if (fx.evidenceMatch === undefined || fx.evidenceMatch === "both") applyBalancedIndirectFloor(ev, composite, { floor: 8 });
  if ((fx.channels ?? []).includes("foundational")) applyFoundationalCiteFloor(ev, composite, { gateOn: false, escapeDelta: 0.10, topCos: 0, floorN: 10, minCites: 75 });
  applyRegionFloor(ev, composite, { regions: fx.regions, cap: fx.cap, gateOn: false, escapeDelta: 0.10, topCos: 0 });
  return ev;
}
function unified(fx: any): Paper[] {
  const pool: Paper[] = JSON.parse(JSON.stringify(fx.pool));
  const ranked = rerankUnified(pool, { regions: fx.regions }, fx.channels, "conservative");
  return orderByChannel(selectTopKDiverse(ranked.slice(0, 200), fx.cap).selected, fx.channels);
}
function metrics(fx: any, ev: Paper[]) {
  const cos = ev.map((p) => Number(p.realCosine ?? p.similarity ?? 0));
  // Canary recall by RESOLVED works.id, restricted to canaries present in the
  // candidate pool → measures RANKING (does the path keep an in-pool canary in
  // the top-50), not retrieval. Same denominator for legacy & unified = fair.
  const resolvedIds = Object.values(CANARY_MAP[fx.id] ?? {}).filter(Boolean).map((x) => norm(x));
  const poolIds = new Set(fx.pool.map((p: Paper) => norm(p.id)));
  const inPool = resolvedIds.filter((id) => poolIds.has(id));
  const evIds = new Set(ev.map((p) => norm(p.id)));
  const canHit = inPool.filter((id) => evIds.has(id)).length;
  return {
    offTopic: cos.filter((c) => c > 0 && c < OFFTOPIC).length,
    smsGte4: ev.filter((p) => Number(p.sms_level ?? 0) >= 4).length,
    lac: ev.filter(isLac).length,
    meanCos: Number((cos.filter((c) => c > 0).reduce((a, b) => a + b, 0) / (cos.filter((c) => c > 0).length || 1)).toFixed(3)),
    canaryHit: canHit, canaryTotal: inPool.length,
  };
}

const dir = "reports/uq-fixtures";
const rows: any[] = [];
const agg = { L: { off: 0, sms: 0, cos: 0, can: 0 }, U: { off: 0, sms: 0, cos: 0, can: 0 }, canTot: 0, n: 0 };
for await (const e of Deno.readDir(dir)) {
  if (!e.name.endsWith(".json")) continue;
  const fx = JSON.parse(await Deno.readTextFile(`${dir}/${e.name}`));
  const L = metrics(fx, legacy(fx)), U = metrics(fx, unified(fx));
  rows.push({
    query: fx.id ?? e.name, offL: L.offTopic, offU: U.offTopic,
    cosL: L.meanCos, cosU: U.meanCos, smsL: L.smsGte4, smsU: U.smsGte4,
    canL: `${L.canaryHit}/${L.canaryTotal}`, canU: `${U.canaryHit}/${U.canaryTotal}`,
  });
  agg.L.off += L.offTopic; agg.U.off += U.offTopic; agg.L.sms += L.smsGte4; agg.U.sms += U.smsGte4;
  agg.L.cos += L.meanCos; agg.U.cos += U.meanCos; agg.L.can += L.canaryHit; agg.U.can += U.canaryHit;
  agg.canTot += L.canaryTotal; agg.n++;
}
rows.sort((a, b) => String(a.query).localeCompare(String(b.query)));
console.table(rows);
const n = agg.n || 1;
console.log(`\n=== AGGREGATE over ${agg.n} queries (legacy → unified) ===`);
console.log(`off-topic (realCos<${OFFTOPIC}) total: ${agg.L.off} → ${agg.U.off}`);
console.log(`mean meanCos:                          ${(agg.L.cos/n).toFixed(3)} → ${(agg.U.cos/n).toFixed(3)}`);
console.log(`SMS>=4 total:                          ${agg.L.sms} → ${agg.U.sms}`);
console.log(`canary recall:                         ${agg.L.can}/${agg.canTot} (${(agg.L.can/(agg.canTot||1)).toFixed(3)}) → ${agg.U.can}/${agg.canTot} (${(agg.U.can/(agg.canTot||1)).toFixed(3)})`);
