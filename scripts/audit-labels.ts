#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-sys --allow-write
// Comprehensive label audit across all gold queries.
// For each query: classification breakdown, SMS distribution in evidence,
// geography suspect papers (direct-lac with non-LAC setting in title),
// estimation-noise count (q24-specific), facet structure from decomposer.
// Writes reports/label-audit-<date>.json.
import { retrieveWorks } from "../supabase/functions/_shared/retrieval.ts";
import { adminClient } from "../supabase/functions/_shared/supabase.ts";
import { foldAccents } from "../supabase/functions/_shared/queryFacets.ts";

const DATE = "2026-06-10";
const gold = JSON.parse(await Deno.readTextFile("evals/queries.json")).queries;
const CHANNELS = ["causal", "foundational", "recent", "lac"];

// ---------- Geography suspects ----------
// Regions/countries that are clearly NOT LAC — if a paper is labeled
// direct-lac but its title strongly anchors to one of these, it's suspect.
const NON_LAC_RE = /\b(united states|u\.s\.|u\.s\b|american workers|american labor|american schools|china|india|oecd countries|europe|european union|sub.saharan africa|africa|southeast asia|south asia|bangladesh|kenya|ghana|ethiopia|tanzania|nigeria|pakistan|indonesia)\b/i;
const LAC_RE = /\b(latin america|caribbean|lac|latam|mexico|brazil|chile|colombia|peru|argentina|ecuador|bolivia|venezuela|uruguay|paraguay|costa rica|guatemala|honduras|el salvador|nicaragua|panama|dominican republic|haiti|jamaica|andean|mercosur)\b/i;

// Estimation-noise heuristic (q24-specific, generalizes to any "returns to X")
const RETURNS_RE = /\breturns? to (schooling|education)\b|\bmincer\b|\brate of return.{0,20}education\b/i;
const INFO_TREATMENT_RE = /\binformation\b|\bperceived\b|\bdisclosure\b|\bexpectation\b|\bbelief\b|\bnudge\b/i;

const results = [];

for (const q of gold) {
  console.log(`\n[audit] ${q.id}`);
  const r = await retrieveWorks(q.query, q.filters ?? {}, {
    supabaseClient: adminClient,
    channelsOverride: CHANNELS,
  });
  const evidence = r.evidence ?? [];
  const candidates = r.candidates ?? [];

  // --- SMS distribution in evidence ---
  const smsDist: Record<string, number> = {};
  let smsNull = 0;
  for (const p of evidence) {
    const s = p.sms_level ?? p.smsLevel;
    if (s == null) { smsNull++; smsDist["null"] = (smsDist["null"] ?? 0) + 1; }
    else smsDist[String(s)] = (smsDist[String(s)] ?? 0) + 1;
  }

  // --- Classification breakdown in evidence ---
  const clsDist: Record<string, number> = {};
  for (const p of evidence) clsDist[p.classification ?? "?"] = (clsDist[p.classification ?? "?"] ?? 0) + 1;

  // --- Geography suspects in evidence: direct-lac but non-LAC title ---
  const geoSuspects = evidence.filter((p) => {
    if (p.classification !== "direct-lac") return false;
    const text = foldAccents(String(p.title ?? "").toLowerCase());
    return NON_LAC_RE.test(text) && !LAC_RE.test(text);
  });

  // --- Estimation-noise in evidence (returns parameter w/o info treatment) ---
  const estimationNoise = evidence.filter((p) => {
    const text = `${p.title ?? ""} ${String(p.abstract ?? "").slice(0, 600)}`;
    return RETURNS_RE.test(text) && !INFO_TREATMENT_RE.test(text);
  });

  // --- Canary rank summary ---
  const canaryRanks: Record<string, number | null> = {};
  for (const c of q.canary_papers ?? []) {
    if (!c.doi_hint) continue;
    const doi = String(c.doi_hint).toLowerCase();
    const idx = evidence.findIndex((p) => String(p.id).toLowerCase() === doi || String(p.canonical_doi ?? "").toLowerCase() === doi);
    canaryRanks[c.id] = idx >= 0 ? idx + 1 : null;
  }

  // --- Pool classification breakdown ---
  const poolCls: Record<string, number> = {};
  for (const p of candidates) poolCls[p.classification ?? "?"] = (poolCls[p.classification ?? "?"] ?? 0) + 1;

  // --- Facet structure from decomposer (from retrieval audit data) ---
  const facets = (r as any).queryFacets?.facets?.map((f: any) => ({
    label: f.label, kind: f.kind, required: f.required, nTerms: (f.expansion ?? []).length,
  })) ?? [];

  const row = {
    queryId: q.id,
    query: q.query.slice(0, 80),
    poolSize: candidates.length,
    evidenceSize: evidence.length,
    clsDist,
    poolCls,
    smsDist,
    smsNull,
    facets,
    geoSuspects: geoSuspects.map((p) => ({ id: p.id, title: String(p.title ?? "").slice(0, 80), cls: p.classification })),
    estimationNoise: estimationNoise.map((p) => ({ id: p.id, title: String(p.title ?? "").slice(0, 80), cls: p.classification, rank: evidence.indexOf(p) + 1 })),
    canaryRanks,
    canaryHit20: Object.values(canaryRanks).filter((r) => r && r <= 20).length,
    canaryHit100: Object.values(canaryRanks).filter((r) => r && r <= 100).length,
    canaryTotal: Object.values(canaryRanks).length,
  };

  results.push(row);

  console.log(`  evidence=${evidence.length} pool=${candidates.length}`);
  console.log(`  cls: ${JSON.stringify(clsDist)}`);
  console.log(`  sms: ${JSON.stringify(smsDist)}`);
  console.log(`  facets: ${facets.map((f: any) => `${f.label}(${f.kind},req=${f.required})`).join(" | ") || "(none logged)"}`);
  if (geoSuspects.length) console.log(`  GEO SUSPECTS (${geoSuspects.length}): ${geoSuspects.map((p) => p.title.slice(0, 60)).join(" | ")}`);
  if (estimationNoise.length) console.log(`  ESTIMATION NOISE (${estimationNoise.length}): ${estimationNoise.map((p) => p.title.slice(0, 50)).join(" | ")}`);
  console.log(`  canary@20=${row.canaryHit20}/${row.canaryTotal}  @100=${row.canaryHit100}/${row.canaryTotal}`);
}

// --- Cross-query summary ---
const totalGeoSuspects = results.reduce((s, r) => s + r.geoSuspects.length, 0);
const totalNoise = results.reduce((s, r) => s + r.estimationNoise.length, 0);
const avgCanary20 = results.reduce((s, r) => s + (r.canaryTotal ? r.canaryHit20 / r.canaryTotal : 0), 0) / results.length;
const smsZeroOrNull = results.reduce((s, r) => s + (r.smsDist["0"] ?? 0) + (r.smsDist["null"] ?? 0), 0);
const totalEvidence = results.reduce((s, r) => s + r.evidenceSize, 0);

console.log("\n===== CROSS-QUERY SUMMARY =====");
console.log(`total geo suspects in evidence: ${totalGeoSuspects}`);
console.log(`total estimation-noise in evidence: ${totalNoise}`);
console.log(`avg canary hit@20 rate: ${(avgCanary20 * 100).toFixed(1)}%`);
console.log(`sms=0 or null in evidence across all queries: ${smsZeroOrNull}/${totalEvidence} (${(100 * smsZeroOrNull / totalEvidence).toFixed(1)}%)`);

const outPath = `reports/label-audit-${DATE}.json`;
await Deno.writeTextFile(outPath, JSON.stringify(results, null, 2));
console.log(`\nSaved ${outPath}`);
