#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-sys --allow-write
/**
 * eval-channel-relevance.mjs — per-(query, channel) relevance scorecard (label-free).
 *
 * Built 2026-06-22 for the relevance-first era (no classifier, no relevant/partial/
 * irrelevant labels). Relevance = TRUE query·paper cosine (the system's own oracle,
 * attached by retrieveWorks via cosine_for_ids). Each channel is graded on TWO axes:
 *
 *   1. INTEGRITY (structural, deterministic) — is the channel pulling its intended
 *      population?  causal→SMS≥4 · region→ux_region⊇LAC · foundational→cit≥75 &
 *      year<2020 · recent→year≥2020.   Reported as a fraction of the top-K table.
 *   2. RELEVANCE of that population — meanCos of the INTEGRITY-PASSING papers
 *      (rigorous AND on-topic, LAC AND on-topic, …). Integrity alone is a trap:
 *      a channel could return 90% SMS≥4 that are all off-topic and "pass".
 *
 * Plus a table-wide cosine backbone (meanCos@K, offTopic@K = cos<0.45) for full
 * coverage, and a RANDOM JUDGED SUBSAMPLE (Qwen 0-3) each run as an INDEPENDENT
 * anchor that catches cases where the embedding itself is wrong. The judge is
 * random each run → a rolling audit (noisy run-to-run BY DESIGN): the deterministic
 * integrity+cosine numbers are the regression gate, the judge is the sanity check.
 *
 * Runs REAL retrieveWorks (RB_UNIFIED=1, conservative) sequentially — prod-faithful,
 * GPU-safe. Read-only (RB_SKIP_CORPUS_GROWTH=1; never writes works).
 *
 * Flags: --channels causal,foundational,recent,region  --only q01,q05  --topk 20
 *        --judge-n 3   --no-judge   --judge-conc 2
 *
 * Output: reports/channel-relevance-scorecard.json (per-query rows + per-channel
 *         summary incl. the integrity% distribution to CALIBRATE per-channel bars).
 */
Deno.env.set("RB_UNIFIED", "1");
if (!Deno.env.get("RB_BOOST_PROFILE")) Deno.env.set("RB_BOOST_PROFILE", "conservative");
Deno.env.set("RB_SKIP_CORPUS_GROWTH", "1");
if (!Deno.env.get("USE_PREFILTERED_MATCH_WORKS")) Deno.env.set("USE_PREFILTERED_MATCH_WORKS", "true");

import { retrieveWorks } from "../supabase/functions/_shared/retrieval.ts";
import { adminClient as sb } from "../supabase/functions/_shared/supabase.ts";
import { uxRegionsOf } from "../supabase/functions/_shared/rerank.ts";

// ---- args -----------------------------------------------------------------
const args = Deno.args;
const argVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const TOP_K = Number(argVal("--topk") ?? 20);
const OFFTOPIC_TAU = 0.45;            // mirrors RB_REL_FLOOR abs-min
const onlyIds = (argVal("--only") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const chanArg = (argVal("--channels") ?? "causal,foundational,recent,region").split(",").map((s) => s.trim()).filter(Boolean);
const JUDGE = !args.includes("--no-judge");
const JUDGE_N = Number(argVal("--judge-n") ?? 3);
const JUDGE_CONC = Number(argVal("--judge-conc") ?? 2);

// ---- channels: definition + integrity predicate ---------------------------
const yr = (p) => Number(p.year ?? p.publication_year ?? 0);
const sms = (p) => Number(p.sms_level ?? p.smsLevel ?? 0);
const cit = (p) => Number(p.citation_count ?? p.citationCount ?? 0);
const isLac = (p) => uxRegionsOf(p.geography ?? []).includes("LAC");
const CHANNELS = {
  causal:       { channelsOverride: ["causal"],       extraFilters: {},                 integrity: (p) => sms(p) >= 4,                  label: "SMS≥4" },
  foundational: { channelsOverride: ["foundational"], extraFilters: {},                 integrity: (p) => cit(p) >= 75 && yr(p) < 2020, label: "cit≥75 & <2020" },
  recent:       { channelsOverride: ["recent"],       extraFilters: {},                 integrity: (p) => yr(p) >= 2020,                label: "year≥2020" },
  region:       { channelsOverride: [],               extraFilters: { regions: ["LAC"] }, integrity: isLac,                              label: "ux_region⊇LAC" },
};

// ---- gold queries ----------------------------------------------------------
let gold = JSON.parse(await Deno.readTextFile("evals/queries.json")).queries;
if (onlyIds.length) gold = gold.filter((q) => onlyIds.some((o) => q.id === o || q.id.startsWith(o)));

// ---- helpers ---------------------------------------------------------------
const cosOf = (p) => Number(p.realCosine ?? p.similarity ?? 0);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x, d = 3) => (x == null ? null : +Number(x).toFixed(d));
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// ---- Qwen judge (independent relevance oracle, random sample) --------------
const LLM_BASE = Deno.env.get("LLM_BASE_URL") ?? "https://llm.iotaimpact.com";
const LLM_KEY = Deno.env.get("LLM_API_KEY");
const CHAT_MODEL = Deno.env.get("LLM_MODEL") ?? Deno.env.get("OLLAMA_GENERATION_MODEL") ?? "qwen2.5:14b-synthesis";
const JUDGE_TIMEOUT_MS = Number(argVal("--judge-timeout") ?? 20000);
async function judgeOne(query, paper) {
  const prompt = `You are grading whether a research paper is RELEVANT to a policy-research query.\n\nQUERY: ${query}\n\nPAPER TITLE: ${paper.title ?? "(no title)"}\nABSTRACT: ${(paper.abstract ?? "(no abstract)").slice(0, 1500)}\n\nGrade relevance on this scale and reply with ONLY the single integer:\n3 = directly answers the query (on-topic AND addresses the stated relationship)\n2 = clearly on-topic and useful, but indirect (mechanism, adjacent population, descriptive)\n1 = tangentially related (same broad domain, different question)\n0 = off-topic (no substantive connection)\n\nInteger grade:`;
  // Bounded timeout: a hung call to the contended chat GPU must NOT block the whole
  // run (the stall cause — a no-timeout fetch can hang 300s+). Abort → null (graceful).
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), JUDGE_TIMEOUT_MS);
  try {
    const r = await fetch(`${LLM_BASE}/v1/chat/completions`, {
      method: "POST", signal: ac.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_KEY}` },
      body: JSON.stringify({ model: CHAT_MODEL, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: 16 }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const m = String(j.choices?.[0]?.message?.content ?? "").match(/[0-3]/);
    return m ? Number(m[0]) : null;
  } catch { return null; }
  finally { clearTimeout(to); }
}
function sampleRandom(arr, n) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}
async function judgeSample(query, papers, n) {
  const pick = sampleRandom(papers, Math.min(n, papers.length));
  const out = [];
  for (let i = 0; i < pick.length; i += JUDGE_CONC) {
    const batch = pick.slice(i, i + JUDGE_CONC);
    const grades = await Promise.all(batch.map((p) => judgeOne(query, p)));
    batch.forEach((p, k) => out.push({ id: p.id, title: (p.title ?? "").slice(0, 90), cos: round(cosOf(p)), grade: grades[k] }));
  }
  return out;
}

// ---- run -------------------------------------------------------------------
const agg = {};
for (const ch of chanArg) agg[ch] = { integrity: [], subsetCos: [], meanCos: [], offTopic: [], tableSize: [], judgeGrades: [], judgeCos: [] };
const perQuery = [];
let nRun = 0, nErr = 0;
const t0 = Date.now();

for (const chName of chanArg) {
  const ch = CHANNELS[chName];
  if (!ch) { console.error(`unknown channel ${chName}`); continue; }
  for (const q of gold) {
    let r;
    try {
      r = await retrieveWorks(q.query, { ...(q.filters ?? {}), ...ch.extraFilters }, {
        supabaseClient: sb, channelsOverride: ch.channelsOverride,
        // Match prod: no GLOBAL HyDE (only the foundational channel's built-in HyDE
        // fires). Mirrors the ablation harness "current" config; avoids 120s
        // whole-query HyDE timeouts on causal/recent/region.
        hydeOverride: { disable: true },
      });
    } catch (e) { nErr++; console.error(`  ${chName}/${q.id} ERR ${e.message}`); continue; }
    nRun++;
    const ev = (r.evidence ?? []).slice(0, TOP_K);
    if (!ev.length) { console.error(`  ${chName} ${q.id} EMPTY`); continue; }
    const pass = ev.filter(ch.integrity);
    const integrity = pass.length / ev.length;
    const subsetCos = mean(pass.map(cosOf));
    const mc = mean(ev.map(cosOf));
    const off = ev.filter((p) => cosOf(p) < OFFTOPIC_TAU).length;

    let judged = [];
    if (JUDGE && LLM_KEY) judged = await judgeSample(q.query, ev, JUDGE_N);

    const A = agg[chName];
    A.integrity.push(integrity);
    if (subsetCos != null) A.subsetCos.push(subsetCos);
    A.meanCos.push(mc);
    A.offTopic.push(off);
    A.tableSize.push(r.evidence?.length ?? 0);
    for (const jr of judged) { if (jr.grade != null) { A.judgeGrades.push(jr.grade); A.judgeCos.push(jr.cos); } }

    perQuery.push({
      channel: chName, query: q.id,
      integrity: round(integrity, 3), integrityPass: pass.length, k: ev.length,
      subsetMeanCos: round(subsetCos), meanCos: round(mc), offTopic: off,
      tableSize: r.evidence?.length ?? 0,
      judged: judged.map((j) => ({ id: j.id, title: j.title, cos: j.cos, grade: j.grade })),
      judgeMean: round(mean(judged.map((j) => j.grade).filter((g) => g != null)), 2),
    });
    console.error(`  ${chName.padEnd(12)} ${q.id.padEnd(36)} integ=${(integrity*100).toFixed(0)}% subCos=${round(subsetCos) ?? "-"} cos=${round(mc)} off=${off} size=${r.evidence?.length ?? 0} judge=${round(mean(judged.map(j=>j.grade).filter(g=>g!=null)),2) ?? "-"}`);
  }
}

// ---- summarize (incl. integrity% distribution for bar calibration) ---------
const summary = [];
for (const chName of chanArg) {
  const A = agg[chName];
  if (!A.integrity.length) continue;
  summary.push({
    channel: chName, definition: CHANNELS[chName].label, nQueries: A.integrity.length,
    integrity_mean: round(mean(A.integrity), 3),
    integrity_min: round(Math.min(...A.integrity), 3),
    integrity_median: round(median(A.integrity), 3),
    integrity_max: round(Math.max(...A.integrity), 3),
    subsetMeanCos: round(mean(A.subsetCos)),
    meanCos: round(mean(A.meanCos)),
    offTopic_mean: round(mean(A.offTopic), 2),
    tableSize_mean: round(mean(A.tableSize), 1),
    judge_n: A.judgeGrades.length,
    judge_meanGrade: round(mean(A.judgeGrades), 2),
    judge_meanCosOfJudged: round(mean(A.judgeCos)),
  });
}

const outPath = "reports/channel-relevance-scorecard.json";
await Deno.writeTextFile(outPath, JSON.stringify({
  topK: TOP_K, channels: chanArg, judge: JUDGE && !!LLM_KEY, judgeN: JUDGE_N,
  queries: gold.length, runs: nRun, errors: nErr, elapsedSec: Math.round((Date.now() - t0) / 1000),
  summary, perQuery,
}, null, 2));

console.error(`\n=== channel relevance scorecard (top-${TOP_K}, ${gold.length} queries, ${nRun} runs, ${nErr} err, ${Math.round((Date.now()-t0)/1000)}s) ===`);
console.error("channel".padEnd(13), "integ(mean/min/med/max)".padEnd(26), "subCos".padEnd(7), "meanCos".padEnd(8), "offTop".padEnd(7), "size".padEnd(6), "judge(grade/cos/n)");
for (const r of summary) {
  console.error(
    r.channel.padEnd(13),
    `${r.integrity_mean}/${r.integrity_min}/${r.integrity_median}/${r.integrity_max}`.padEnd(26),
    String(r.subsetMeanCos ?? "-").padEnd(7), String(r.meanCos).padEnd(8),
    String(r.offTopic_mean).padEnd(7), String(r.tableSize_mean).padEnd(6),
    `${r.judge_meanGrade ?? "-"}/${r.judge_meanCosOfJudged ?? "-"}/${r.judge_n}`,
  );
}
console.error(`\nwrote ${outPath}`);
