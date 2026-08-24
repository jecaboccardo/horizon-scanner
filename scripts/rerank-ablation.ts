// scripts/rerank-ablation.ts
// Faithful replay of the prod ranking path (rerankHybrid + selectTopKDiverse +
// the 3 evidence floors) over a fixed pool fixture — NO embed/DB, cannot hang.
// Imports the REAL functions (no mirror — a bare-rerankMerged mirror caused a
// prior false positive). Measures toggles RB_GATE_JOINT / RB_GATE_FLOORS /
// RB_ESCAPE_TIGHT in isolation and combined.
// Run: deno run --allow-read --allow-env scripts/rerank-ablation.ts reports/rerank-fixture-dehoyos.json
import { rerankHybrid, selectTopKDiverse, backboneConfig, rerankUnified, orderByChannel } from "../supabase/functions/_shared/rerank.ts";
import { applyBalancedIndirectFloor, applyFoundationalCiteFloor, applyRegionFloor } from "../supabase/functions/_shared/evidenceFloors.ts";

// deno-lint-ignore no-explicit-any
type Paper = Record<string, any>;
const path = Deno.args[0] ?? "reports/rerank-fixture-dehoyos.json";
const fx = JSON.parse(await Deno.readTextFile(path));

// de Hoyos is identified by DOI — its title ("The heterogeneous effect of
// information on student performance") contains neither "hoyos" nor "avitabile".
const DEHOYOS_DOI = "10.1016/j.jdeveco.2018.07.008";
const isDeHoyos = (p: Paper) => String(p.id) === DEHOYOS_DOI || /hoyos|avitabile/i.test(p.title ?? "");
// Off-topic leaks are identified by title (matching scripts/_validate-gate.ts) —
// the real leaks carry SYNTHETIC channel similarities (0.45/0.55), so a cosine
// threshold cannot detect them. These are the known off-topic mega-cites.
const LEAK_PATTERNS = [/frames of mind|multiple intelligence/i, /self-?determination theory/i, /killing me softly|fetal origins/i, /bowling alone/i, /cronbach/i];
const isLeak = (p: Paper) => LEAK_PATTERNS.some((re) => re.test(String(p.title ?? "")));
const isLac = (p: Paper) => Array.isArray(p.geography) &&
  p.geography.some((g: string) => /lac|latin|mexico|brazil|colombia|peru|chile|argentina|caribbean/i.test(String(g)));

function runConfig(name: string, env: Record<string, string>) {
  for (const k of ["RELEVANCE_BACKBONE","RB_GATE_JOINT","RB_GATE_FLOORS","RB_ESCAPE_TIGHT"]) Deno.env.delete(k);
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  const cfg = backboneConfig();
  const topCos = fx.pool.reduce((m: number, p: Paper) => Math.max(m, Number(p.similarity ?? 0)), 0);
  // Deep-copy the pool: rerankMerged mutates _compositeScore; isolate configs.
  const pool: Paper[] = JSON.parse(JSON.stringify(fx.pool));
  const composite: Paper[] = rerankHybrid(pool, { regions: fx.regions }, fx.query, fx.channels, fx.cap);
  const selection = selectTopKDiverse(composite.slice(0, 200), fx.cap);
  const evidence: Paper[] = selection.selected;
  // Balanced-indirect floor only fires when evidenceMatch='both' (absent === 'both'), matching retrieval.ts.
  if (fx.evidenceMatch === undefined || fx.evidenceMatch === "both") applyBalancedIndirectFloor(evidence, composite, { floor: 8 });
  if ((fx.channels ?? []).includes("foundational")) {
    applyFoundationalCiteFloor(evidence, composite, { gateOn: cfg.gateFloors, escapeDelta: cfg.escapeDelta, topCos, floorN: 10, minCites: 75 });
  }
  applyRegionFloor(evidence, composite, { regions: fx.regions, cap: fx.cap, gateOn: cfg.gateFloors, escapeDelta: cfg.escapeDelta, topCos });
  const dhIdx = evidence.findIndex(isDeHoyos);
  const cos = evidence.map((p) => Number(p.similarity ?? 0)).filter((c) => c > 0);
  const leaks = evidence.filter(isLeak);
  return {
    config: name,
    deHoyosRank: dhIdx < 0 ? "ABSENT" : String(dhIdx + 1),
    offTopicLeaks: leaks.length,
    smsGte4: evidence.filter((p) => Number(p.sms_level ?? 0) >= 4).length,
    lac: evidence.filter(isLac).length,
    meanCos: Number((cos.length ? cos.reduce((a, b) => a + b, 0) / cos.length : 0).toFixed(3)),
    leakTitles: leaks.map((p) => String(p.title ?? "").slice(0, 28)).join(" | "),
  };
}

const configs: Array<[string, Record<string, string>]> = [
  ["0-baseline (all off)", {}],
  ["1-gateJoint only", { RB_GATE_JOINT: "1" }],
  ["2-gateFloors only", { RB_GATE_FLOORS: "1" }],
  ["3-escapeTight only", { RB_ESCAPE_TIGHT: "1" }],
  ["1+2", { RB_GATE_JOINT: "1", RB_GATE_FLOORS: "1" }],
  ["all (1+2+3)", { RELEVANCE_BACKBONE: "1", RB_ESCAPE_TIGHT: "1" }],
];
const rows = configs.map(([n, e]) => runConfig(n, e));
console.table(rows);
console.log("\nfixture:", path, "| query:", fx.query, "| channels:", (fx.channels ?? []).join("+"), "| regions:", (fx.regions ?? []).join("+"), "| pool:", fx.pool.length);

function runUnified(profile: string) {
  const pool: Paper[] = JSON.parse(JSON.stringify(fx.pool));   // deep copy (rerankUnified mutates _unifiedScore)
  const ranked = rerankUnified(pool, { regions: fx.regions }, fx.channels, profile);
  const sel = selectTopKDiverse(ranked.slice(0, 200), fx.cap);
  const evidence = orderByChannel(sel.selected, fx.channels);
  const dh = evidence.findIndex(isDeHoyos);
  const leaks = evidence.filter(isLeak);
  const cos = evidence.map((p) => Number(p.realCosine ?? p.similarity ?? 0)).filter((c) => c > 0);
  return {
    config: `unified:${profile}`,
    deHoyosRank: dh < 0 ? "ABSENT" : String(dh + 1),
    offTopicLeaks: leaks.length,
    smsGte4: evidence.filter((p) => Number(p.sms_level ?? 0) >= 4).length,
    lac: evidence.filter(isLac).length,
    meanCos: Number((cos.reduce((a, b) => a + b, 0) / (cos.length || 1)).toFixed(3)),
    leakTitles: leaks.map((p) => String(p.title ?? "").slice(0, 24)).join(" | "),
  };
}
console.log("\n=== UNIFIED reranker — boost-magnitude sweep (relevance×bounded-boosts, no floors) ===");
console.table(["conservative", "moderate", "aggressive"].map(runUnified));

// --- Region-boost RAMP sweep (2026-06-16): off (flat boost = pre-change) vs
// cosine-gated. Isolates the LAC-noise fix. lacLowCos = in-region papers with
// realCosine < 0.55 (the "adjacent LAC" noise the ramp should demote);
// lacHiCos = genuine on-topic LAC (realCosine ≥ 0.60) that MUST be retained.
function runRamp(profile: string, ramp: "off" | "on" | { lo: number; hi: number }) {
  for (const k of ["RB_REGION_RAMP_LO", "RB_REGION_RAMP_HI"]) Deno.env.delete(k);
  if (ramp === "off") Deno.env.set("RB_REGION_RAMP_HI", "0"); // hi<=lo → ramp returns 1 = flat boost
  else if (typeof ramp === "object") { Deno.env.set("RB_REGION_RAMP_LO", String(ramp.lo)); Deno.env.set("RB_REGION_RAMP_HI", String(ramp.hi)); }
  const pool: Paper[] = JSON.parse(JSON.stringify(fx.pool));
  const ranked = rerankUnified(pool, { regions: fx.regions }, fx.channels, profile);
  const sel = selectTopKDiverse(ranked.slice(0, 200), fx.cap);
  const ev = orderByChannel(sel.selected, fx.channels);
  const cosOf = (p: Paper) => Number(p.realCosine ?? p.similarity ?? 0);
  const lac = ev.filter(isLac);
  const dh = ev.findIndex(isDeHoyos);
  const cos = ev.map(cosOf).filter((c) => c > 0);
  return {
    config: `${profile}/ramp:${typeof ramp === "object" ? `${ramp.lo}-${ramp.hi}` : ramp}`,
    deHoyos: dh < 0 ? "ABS" : String(dh + 1),
    lacTotal: lac.length,
    lacLowCos: lac.filter((p) => cosOf(p) < 0.55).length,
    lacHiCos: lac.filter((p) => cosOf(p) >= 0.60).length,
    smsGte4: ev.filter((p) => Number(p.sms_level ?? 0) >= 4).length,
    meanCos: Number((cos.reduce((a, b) => a + b, 0) / (cos.length || 1)).toFixed(3)),
  };
}
console.log("\n=== REGION-BOOST RAMP: off (flat, pre-change) vs cosine-gated (conservative) ===");
console.table([
  runRamp("conservative", "off"),
  runRamp("conservative", "on"),
  runRamp("conservative", { lo: 0.50, hi: 0.70 }),
  runRamp("conservative", { lo: 0.55, hi: 0.70 }),
]);
for (const k of ["RB_REGION_RAMP_LO", "RB_REGION_RAMP_HI"]) Deno.env.delete(k);

// --- Mechanism eval: force-promotion (Change 1) + classifier geo→direct-lac rule.
// promote = re-stamp topic_geo_channel papers direct-lac (legacy ON) vs leave (Change 1 OFF).
// classfix = ADDITIONALLY drop direct-* papers whose realCosine < RELFLOOR — proxy for
//   "require topical relevance before stamping geo→direct-lac" (the gm=0.00 geo=Y rule).
const RELFLOOR = 0.50;
function simMech(label: string, opts: { promote: boolean; classfix: boolean; ramp: boolean }) {
  for (const k of ["RB_REGION_RAMP_LO", "RB_REGION_RAMP_HI"]) Deno.env.delete(k);
  if (!opts.ramp) Deno.env.set("RB_REGION_RAMP_HI", "0"); // flat boost
  let pool: Paper[] = JSON.parse(JSON.stringify(fx.pool));
  const cosOf = (p: Paper) => Number(p.realCosine ?? p.similarity ?? 0);
  if (opts.promote) for (const p of pool) if (p._retrievalSource === "topic_geo_channel") p.classification = "direct-lac";
  if (opts.classfix) pool = pool.filter((p) => !(String(p.classification ?? "").startsWith("direct") && cosOf(p) < RELFLOOR));
  const ranked = rerankUnified(pool, { regions: fx.regions }, fx.channels, "conservative");
  const ev = orderByChannel(selectTopKDiverse(ranked.slice(0, 200), fx.cap).selected, fx.channels);
  const lac = ev.filter(isLac);
  const cos = ev.map(cosOf).filter((c) => c > 0);
  return {
    config: label,
    n: ev.length,
    lacTotal: lac.length,
    lacLowCos: lac.filter((p) => cosOf(p) < 0.55).length,
    lacHiCos: lac.filter((p) => cosOf(p) >= 0.60).length,
    smsGte4: ev.filter((p) => Number(p.sms_level ?? 0) >= 4).length,
    meanCos: Number((cos.reduce((a, b) => a + b, 0) / (cos.length || 1)).toFixed(3)),
  };
}
console.log("\n=== MECHANISM eval (conservative): force-promote (Change 1) + classifier geo-rule ceiling ===");
console.table([
  simMech("promote ON,  ramp off  (≈ today)",         { promote: true,  classfix: false, ramp: false }),
  simMech("promote OFF, ramp off  (Change 1 only)",    { promote: false, classfix: false, ramp: false }),
  simMech("promote OFF, ramp on   (Change 1+2)",       { promote: false, classfix: false, ramp: true }),
  simMech("+ classfix<0.50, ramp on (all 3)",          { promote: false, classfix: true,  ramp: true }),
]);
for (const k of ["RB_REGION_RAMP_LO", "RB_REGION_RAMP_HI"]) Deno.env.delete(k);
