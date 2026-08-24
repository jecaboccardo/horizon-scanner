#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-sys --allow-write
// Phase comparison eval: baseline vs P1 vs P2 vs P1+P2
// Runs on a focused set of gold queries that best stress-test each change.
//
// Phase 1 — Improved decomposer: forces intervention/outcome split so the
//   first required facet is the TREATMENT, not a topic blend.
// Phase 2 — Post-RF demotion: caps direct→indirect when intervention facet
//   has ZERO lexical matches in title+abstract[:600].
// Phase 1+2 — Both combined.
//
// Metrics per variant: canary@20/@100, precision (meanTrueCos@20),
//   % direct-labeled in evidence, geo-suspect count, estimation-noise count.
import { retrieveWorks } from "../supabase/functions/_shared/retrieval.ts";
import { rerankInterleaved, selectTopKDiverse } from "../supabase/functions/_shared/rerank.ts";
import { createEmbeddingClient } from "../supabase/functions/_shared/embeddingClient.ts";
import { compileFacetMatcher, foldAccents } from "../supabase/functions/_shared/queryFacets.ts";
import { adminClient } from "../supabase/functions/_shared/supabase.ts";

const DATE = "2026-06-10";
const gold = JSON.parse(await Deno.readTextFile("evals/queries.json")).queries;
const CHANNELS = ["causal", "foundational", "recent", "lac"];

// Queries chosen to stress different failure modes:
//  q24: estimation-noise precision (Phase 2 main target)
//  q04: LAC intervention query, geography mislabels
//  q19: global-canon query (regression guard — demotion must not hurt)
//  q05: CCT (intervention facet clear, demotion must not fire on canaries)
//  q11: teacher quality (intervention unclear — regression guard)
const QUERY_IDS = [
  "q24-returns-to-schooling-info-lac",
  "q04-minwage-informality-lac",
  "q05-cct-school-attendance-learning",
  "q09-early-nutrition-adult-earnings",
  "q19-inequality-social-mobility-lac",
];

// ============================================================
// Phase 1 — Improved decomposer prompt (call Qwen directly,
// bypass the persistent cache so we test the new prompt)
// ============================================================
const LLM_BASE = Deno.env.get("LLM_BASE_URL") ?? "https://llm.iotaimpact.com";
const LLM_KEY = Deno.env.get("LLM_API_KEY");
const QWEN_MODEL = Deno.env.get("LLM_MODEL") ?? "qwen2.5:14b-synthesis";

const P1_SYSTEM_PROMPT = `You decompose policy/economics research queries into 2–4 conceptual FACETS for a faceted retrieval system.

HARD RULE 1 — INTERVENTION/OUTCOME SPLIT: If the query contains a TREATMENT/INTERVENTION/POLICY (something done to people or a system) AND an OUTCOME (something measured), they MUST be separate facets. NEVER merge them into one.
  - Facet 1 = the INTERVENTION instrument (what is DONE — the most discriminative concept)
  - Facet 2 = the OUTCOME(S) (what is MEASURED)
  Example: "providing students with information on the returns to schooling" → Facet 1: information intervention (information provision, perceived returns, earnings disclosure, subjective expectations, belief updating, nudge, informing students about future earnings). Facet 2: schooling outcomes (enrollment, dropout, attendance, learning, test scores, educational attainment, school performance).
  Example: "cash transfers and school attendance" → Facet 1: cash transfer program (CCT, conditional cash transfer, income support, bolsa familia, oportunidades). Facet 2: schooling (enrollment, attendance, dropout, learning, test scores).
  Example: "minimum wage and informality" → Facet 1: minimum wage (minimum wage policy, wage floor, statutory minimum). Facet 2: informality (informal employment, informal sector, undeclared work, self-employment).

HARD RULE 2 — ORDER: Facet 1 MUST be the intervention/treatment. Facet 2 = outcomes. Geography LAST. The downstream classifier uses Facet 1 as a hard gate — a paper with no match on Facet 1 is indirect, regardless of how well it matches the outcome.

HARD RULE 3 — INTERVENTION VOCABULARY: Facet 1 expansion MUST use the EXACT terms that papers implementing that intervention use in their titles/abstracts, not lay rephrasings. For information interventions: "perceived returns", "earnings disclosure", "subjective expectations", "information about earnings", "wage expectations", "returns information", "informacion sobre retornos". For CCT: "conditional cash transfer", "CCT", "Progresa", "Oportunidades", "Bolsa Familia", "transferencias condicionadas". For minimum wage: "minimum wage", "salario minimo", "wage floor", "minimum wage compliance".

For each facet, output 10–22 synonyms that academic papers in that subfield actually use. Include Spanish/Portuguese terms for LAC queries.

Geography facet: required:false (many LAC papers don't name the country in title/abstract). All other facets: required:true.

DO NOT create facets for methodology (RCT, DiD) or filler concepts (evidence, research).

Output strict JSON: {"facets": [{"label": "...", "expansion": [...], "required": true}]}`;

async function decomposeP1(query: string): Promise<any[]> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90000);
    const r = await fetch(`${LLM_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${LLM_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: QWEN_MODEL, temperature: 0,
        messages: [{ role: "system", content: P1_SYSTEM_PROMPT }, { role: "user", content: query }],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const j = await r.json();
    const raw = j?.choices?.[0]?.message?.content ?? "";
    const stripped = raw.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(stripped.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    return parsed.facets ?? [];
  } catch (e) {
    console.log(`  [P1 decompose] failed: ${(e as Error).message}`);
    return [];
  }
}

// ============================================================
// Phase 2 — Post-RF demotion rule
// ============================================================
const NON_LAC_RE = /\b(united states|u\.s\b|u\.s\.|china|india|europe|sub.saharan africa|africa|south asia|southeast asia|oecd countries)\b/i;
const LAC_RE_GEO = /\b(latin america|caribbean|lac|latam|mexico|brazil|chile|colombia|peru|argentina|ecuador|bolivia|venezuela|uruguay|costa rica|guatemala|honduras|el salvador|nicaragua|dominican republic|haiti|jamaica)\b/i;

function applyDemotion(papers: any[], facets: any[]): { demoted: string[]; papers: any[] } {
  const interventionFacet = facets.find((f: any) => f.required !== false && (f.kind === "topic" || !f.kind));
  if (!interventionFacet || !interventionFacet.expansion?.length) return { demoted: [], papers };
  const matcher = compileFacetMatcher(interventionFacet.expansion);
  if (!matcher) return { demoted: [], papers };
  const demoted: string[] = [];
  const out = papers.map((p) => {
    if (p.classification !== "direct-lac" && p.classification !== "direct-global") return p;
    const text = foldAccents(`${p.title ?? ""} ${String(p.abstract ?? "").slice(0, 600)}`);
    if (matcher.test(text)) return p;  // has intervention term match → keep
    demoted.push(String(p.id));
    return { ...p, classification: "indirect", evidenceMatch: "indirect", _demoted: true };
  });
  return { demoted, papers: out };
}

function applyGeoFix(papers: any[]): { fixed: string[]; papers: any[] } {
  const fixed: string[] = [];
  const out = papers.map((p) => {
    if (p.classification !== "direct-lac") return p;
    const title = foldAccents(String(p.title ?? "").toLowerCase());
    // Title anchors clearly to non-LAC AND no LAC mention anywhere
    if (NON_LAC_RE.test(title) && !LAC_RE_GEO.test(title)) {
      const abstractPrefix = foldAccents(String(p.abstract ?? "").slice(0, 200).toLowerCase());
      if (!LAC_RE_GEO.test(abstractPrefix)) {
        fixed.push(String(p.id));
        return { ...p, classification: "direct-global", evidenceMatch: "direct", _geoFixed: true };
      }
    }
    return p;
  });
  return { fixed, papers: out };
}

// ============================================================
// Metrics
// ============================================================
const embedder = createEmbeddingClient();
const cos = (a: number[], b: number[]) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb)); };
const stripDoi = (d: string) => String(d || "").toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "").trim();
const RETURNS_RE = /\breturns? to (schooling|education)\b|\bmincer\b/i;
const INFO_RE = /\binformation\b|\bperceived\b|\bdisclosure\b|\bexpectation\b|\bbelief\b/i;

async function metrics(evidence: any[], candidates: any[], q: any, qEmb: number[], label: string) {
  const canaries = (q.canary_papers ?? []).filter((c: any) => c.doi_hint);
  const cr = canaries.map((c: any) => {
    const doi = stripDoi(c.doi_hint);
    const i = evidence.findIndex((p) => stripDoi(p.id) === doi || stripDoi(p.canonical_doi ?? "") === doi);
    return { id: c.id, rank: i >= 0 ? i + 1 : null };
  });
  const hit20 = cr.filter((c: any) => c.rank && c.rank <= 20).length;
  const hit100 = cr.filter((c: any) => c.rank && c.rank <= 100).length;
  const top20ids = evidence.slice(0, 20).map((p) => p.id);
  const { data: rows } = await adminClient.from("works").select("id,embedding").in("id", top20ids);
  const embMap = new Map(rows?.map((r: any) => { let e = r.embedding; if (typeof e === "string") { try { e = JSON.parse(e); } catch { e = null; } } return [r.id, e]; }) ?? []);
  const cosVals = top20ids.map((id) => embMap.get(id)).filter(Boolean).map((e) => cos(qEmb, e as number[]));
  const meanCos = cosVals.length ? cosVals.reduce((a, b) => a + b, 0) / cosVals.length : 0;
  const clsDist: Record<string, number> = {};
  for (const p of evidence) clsDist[p.classification ?? "?"] = (clsDist[p.classification ?? "?"] ?? 0) + 1;
  const geoSuspects = evidence.filter((p) => {
    if (p.classification !== "direct-lac") return false;
    const t = foldAccents(String(p.title ?? "").toLowerCase());
    return NON_LAC_RE.test(t) && !LAC_RE_GEO.test(t);
  }).length;
  const estimNoise = evidence.filter((p) => RETURNS_RE.test(`${p.title} ${String(p.abstract ?? "").slice(0, 600)}`) && !INFO_RE.test(`${p.title} ${String(p.abstract ?? "").slice(0, 600)}`)).length;
  const smsLow = evidence.filter((p) => (p.sms_level ?? p.smsLevel ?? 0) <= 1).length;
  return { label, hit20, hit100, total: canaries.length, meanCos: parseFloat(meanCos.toFixed(3)), clsDist, geoSuspects, estimNoise, smsLow, canaryRanks: cr };
}

// ============================================================
// Main loop
// ============================================================
const allResults = [];

for (const qid of QUERY_IDS) {
  const q = gold.find((x: any) => x.id === qid);
  console.log(`\n######## ${qid} ########`);
  const qEmb = await embedder.embedText(q.query, "query") ?? [];

  // Run baseline retrieval once
  const r = await retrieveWorks(q.query, q.filters ?? {}, {
    supabaseClient: adminClient, channelsOverride: CHANNELS,
  });
  const baseCandidates = r.candidates ?? [];
  const baseEvidence = r.evidence ?? [];
  const baseFacets = (r as any).queryFacets?.facets ?? [];
  console.log(`  pool=${baseCandidates.length} evidence=${baseEvidence.length} facets=[${baseFacets.map((f: any) => f.label).join(",")}]`);

  // Phase 1: new decomposer → re-embed intervention facet only (for metrics;
  // we can't re-run full retrieval cost-effectively — test facet quality +
  // what the intervention facet expansion covers, then apply demotion with P1 facets)
  console.log("  [P1] running improved decomposer...");
  const p1Facets = await decomposeP1(q.query);
  console.log(`  [P1] facets=[${p1Facets.map((f: any) => f.label).join(",")}]`);
  const p1FacetFull = p1Facets.map((f: any) => ({
    label: f.label,
    expansion: f.expansion ?? [],
    required: f.required !== false,
    kind: typeof f.label === "string" && /geo|region|country|location/.test(f.label) ? "geography" : "topic",
  }));

  // Baseline evidence (already have it from retrieval)
  // P2: apply demotion to baseline evidence using BASELINE facets
  const { demoted: dem2, papers: p2Evidence } = applyDemotion([...baseEvidence], baseFacets);
  // Also apply geo fix on top
  const { fixed: fix2, papers: p2EvidenceFull } = applyGeoFix(p2Evidence);
  console.log(`  [P2] demoted=${dem2.length} geoFixed=${fix2.length}`);
  if (dem2.length) console.log(`  [P2] demoted titles: ${dem2.slice(0, 3).map(id => baseEvidence.find(p => p.id === id)?.title?.slice(0, 60) ?? id).join(" | ")}`);

  // P1+P2: apply demotion using P1 facets (the intended production combination)
  const { demoted: dem12, papers: p12Evidence } = applyDemotion([...baseEvidence], p1FacetFull);
  const { fixed: fix12, papers: p12EvidenceFull } = applyGeoFix(p12Evidence);
  console.log(`  [P1+P2] demoted=${dem12.length} geoFixed=${fix12.length}`);
  if (dem12.length > dem2.length) console.log(`  [P1+P2] extra demotions vs P2-alone: ${dem12.length - dem2.length}`);

  const variants = [
    { label: "A_baseline", evidence: baseEvidence },
    { label: "B_P1_prompt", evidence: baseEvidence }, // P1 can't change evidence without re-running retrieval; shown for facet quality only
    { label: "C_P2_demotion", evidence: p2EvidenceFull },
    { label: "D_P1+P2", evidence: p12EvidenceFull },
  ];

  console.log(`\n${"variant".padEnd(16)}${"@20".padStart(5)}${"@100".padStart(6)}${"cos@20".padStart(8)}${"direct%".padStart(8)}${"noise".padStart(6)}${"geoSus".padStart(7)}${"dem".padStart(5)}   ranks`);
  const qRow: any = { queryId: qid, baseline_facets: baseFacets.map((f: any) => f.label), p1_facets: p1FacetFull.map((f: any) => f.label), variants: {} };

  for (const v of variants) {
    const m = await metrics(v.evidence, baseCandidates, q, qEmb, v.label);
    const directN = (m.clsDist["direct-lac"] ?? 0) + (m.clsDist["direct-global"] ?? 0);
    const directPct = v.evidence.length ? Math.round(100 * directN / v.evidence.length) : 0;
    const demCount = v.label === "C_P2_demotion" ? dem2.length : v.label === "D_P1+P2" ? dem12.length : 0;
    console.log(`${v.label.padEnd(16)}${String(m.hit20).padStart(5)}${String(m.hit100).padStart(6)}${String(m.meanCos).padStart(8)}${(directPct + "%").padStart(8)}${String(m.estimNoise).padStart(6)}${String(m.geoSuspects).padStart(7)}${String(demCount).padStart(5)}   ${m.canaryRanks.map((c: any) => `${c.id.split("-")[0]}:${c.rank ?? "—"}`).join(" ")}`);
    qRow.variants[v.label] = { ...m, demotedCount: demCount, geoFixedCount: v.label === "C_P2_demotion" ? fix2.length : v.label === "D_P1+P2" ? fix12.length : 0 };
  }

  // P1 facet quality report
  console.log(`\n  Facet comparison for ${qid}:`);
  console.log(`  BASELINE: [${baseFacets.map((f: any) => `${f.label}(${(f.expansion?.length ?? 0)}t)`).join(", ")}]`);
  console.log(`  P1 NEW:   [${p1FacetFull.map((f: any) => `${f.label}(${(f.expansion?.length ?? 0)}t)`).join(", ")}]`);
  const p1Intervention = p1FacetFull[0];
  if (p1Intervention) {
    console.log(`  P1 intervention expansion[:10]: ${(p1Intervention.expansion ?? []).slice(0, 10).join(", ")}`);
  }
  qRow.p1FacetDetail = p1FacetFull;
  allResults.push(qRow);
}

const outPath = `reports/eval-phases-${DATE}.json`;
await Deno.writeTextFile(outPath, JSON.stringify(allResults, null, 2));
console.log(`\nSaved ${outPath}`);
