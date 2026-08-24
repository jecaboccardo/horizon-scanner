// scripts/jel-survey/audit-section.mjs
//
// JEL Skill #5 — Claim Auditor.
//
// Reads a drafted section JSON (output of scripts/jel-survey/draft-section.mjs)
// and verifies every [workId] citation against the cited paper's actual
// content (evidence_card + abstract + optional PDF excerpt).
//
// Output: reports/audit-<query>-<section>-<date>.json with per-claim verdicts:
//   - supported    : the source clearly supports the surrounding sentence
//   - partial      : the source touches on the topic but doesn't directly support the specific claim
//   - unsupported  : the source does NOT support the sentence (hallucination or misattribution)
//   - unverifiable : source detail too thin to judge (no card, no abstract)
//
// Two phases:
//   1. Local pattern parser splits the body into (sentence, citation) tuples.
//   2. For each tuple, Gemini reads (card, abstract excerpt) and returns the verdict.
//
// Usage:
//   node --env-file=.env scripts/jel-survey/audit-section.mjs --draft <path>
//   node --env-file=.env scripts/jel-survey/audit-section.mjs --query cash-transfers-education-lac --section 4
//   node --env-file=.env scripts/jel-survey/audit-section.mjs --query ... --all-sections
//   node --env-file=.env scripts/jel-survey/audit-section.mjs --query ... --model qwen-14b-synth
//
// Same [workId] format the drafter uses — this is also a downstream sanity
// check on the citation normalizer.

import { createClient } from "@supabase/supabase-js";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const REPORTS_DIR = resolve(ROOT, "reports");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_AUDIT_MODEL ?? "gemini-2.5-flash";
const QWEN_AUDIT_MODEL = process.env.QWEN_AUDIT_MODEL ?? "qwen2.5:14b-synthesis";

const MODEL_ALIASES = {
  gemini: { backend: "gemini", id: GEMINI_MODEL },
  "qwen-14b-synth": { backend: "litellm", id: QWEN_AUDIT_MODEL },
};

if (!SUPABASE_URL || !SERVICE_KEY) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function parseArgs(argv) {
  const out = { draft: null, query: null, section: null, allSections: false, outDir: REPORTS_DIR, model: "gemini" };
  for (let i = 2; i < argv.length; i++) {
    const f = argv[i], n = argv[i + 1];
    if (f === "--draft") { out.draft = resolve(n); i++; }
    else if (f === "--query") { out.query = n; i++; }
    else if (f === "--section") { out.section = n; i++; }
    else if (f === "--all-sections") { out.allSections = true; }
    else if (f === "--out-dir") { out.outDir = resolve(n); i++; }
    else if (f === "--model") { out.model = n; i++; }
  }
  if (!MODEL_ALIASES[out.model]) {
    console.error(`Unknown --model "${out.model}". Available: ${Object.keys(MODEL_ALIASES).join(", ")}`);
    process.exit(1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Discover draft JSON paths
// ---------------------------------------------------------------------------

async function findDraftPaths(args) {
  if (args.draft) return [args.draft];
  if (!args.query) throw new Error("Need --draft <path> or --query <id>");
  const entries = await readdir(REPORTS_DIR);
  const all = entries
    .filter((f) => f.startsWith(`section-${args.query}-`) && f.endsWith(".json"))
    .sort()
    .reverse();
  if (args.allSections) {
    // Latest per section number — group by section then take newest
    const bySection = new Map();
    for (const f of all) {
      const m = f.match(new RegExp(`^section-${args.query}-([^-]+)-(\\d{4}-\\d{2}-\\d{2})\\.json$`));
      if (!m) continue;
      if (!bySection.has(m[1])) bySection.set(m[1], resolve(REPORTS_DIR, f));
    }
    return [...bySection.values()];
  }
  if (args.section) {
    const match = all.find((f) => f.includes(`-${args.section}-`));
    if (!match) throw new Error(`No draft for query=${args.query} section=${args.section}`);
    return [resolve(REPORTS_DIR, match)];
  }
  // Default: most recent draft for the query
  if (all.length === 0) throw new Error(`No drafts for query=${args.query}`);
  return [resolve(REPORTS_DIR, all[0])];
}

// ---------------------------------------------------------------------------
// Extract (sentence, citation) tuples from the draft body
// ---------------------------------------------------------------------------

// Match a sentence containing [workId] citations. Sentence = run of chars up to .!? boundary.
// Citation body: same regex as draft-section.mjs validator.
const CITATION_RE = /\[([^\]\s][^\]]{1,120})\]/g;
const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z\[*])/;

function splitClaims(body) {
  // First markdown-strip: remove **bold** wrappers so they don't break sentence splits.
  const text = body.replace(/\*\*([^*]+)\*\*/g, "$1");
  const sentences = text.split(SENTENCE_SPLIT).map((s) => s.trim()).filter(Boolean);
  const claims = [];
  for (const sentence of sentences) {
    const cites = [];
    for (const m of sentence.matchAll(CITATION_RE)) cites.push(m[1].trim());
    if (cites.length === 0) continue;
    claims.push({ sentence, citations: [...new Set(cites)] });
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Fetch source-of-truth for each cited workId
// ---------------------------------------------------------------------------

async function fetchSources(workIds) {
  const out = new Map();
  if (workIds.length === 0) return out;
  const CHUNK = 100;
  for (let i = 0; i < workIds.length; i += CHUNK) {
    const slice = workIds.slice(i, i + CHUNK);
    const [{ data: works }, { data: cards }] = await Promise.all([
      sb.from("works").select("id, title, authors, year, venue, abstract").in("id", slice),
      sb.from("evidence_cards")
        .select("work_id, study_design, intervention, outcome, effect_direction, effect_size_text, sample_size, sample_size_text, identification_strategy, country, mechanism, limitations, heterogeneity, finding_short, source_text, confidence")
        .in("work_id", slice),
    ]);
    const cardBy = new Map((cards ?? []).map((c) => [c.work_id, c]));
    for (const w of (works ?? [])) {
      out.set(w.id, { work: w, card: cardBy.get(w.id) ?? null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gemini call
// ---------------------------------------------------------------------------

function buildAuditPrompt(claims, sources) {
  const system = `You are the Claim Auditor for the Horizon Scanner JEL Survey pipeline.

Your job: for each claim below, decide whether the cited source(s) actually support the sentence. You are NOT writing prose — you're judging factual support.

VERDICT TAXONOMY (use exactly these strings):
- "supported"     — the source's content directly supports the specific claim in the sentence
- "partial"       — the source addresses the topic but the sentence overstates, generalizes, or attributes a specific detail the source doesn't actually contain
- "unsupported"   — the source does NOT contain the claim. Sentence is a hallucination or wrong attribution.
- "unverifiable"  — source detail is too thin (no card, no abstract) to judge

RULES:
- Be strict. Drafters tend to inflate. If the sentence claims a specific number, design, or finding that's not visible in the source, mark "partial" or "unsupported".
- If a sentence has multiple citations, judge each citation independently.
- For "partial" or "unsupported", quote the most relevant 1-2 sentences from the source in "evidence_quote" — the user uses this to revise.
- Brief notes only. 1-2 sentences in "rationale". No prose.

OUTPUT: JSON only. Schema:
{
  "verdicts": [
    {
      "claimIndex": <0-based index from input>,
      "citation": "<workId from input>",
      "verdict": "supported|partial|unsupported|unverifiable",
      "rationale": "<1-2 sentences>",
      "evidence_quote": "<source quote if verdict != supported; empty string otherwise>"
    }
  ]
}`;

  const sourceLines = [];
  const seenIds = new Set();
  for (const c of claims) {
    for (const cid of c.citations) {
      if (seenIds.has(cid)) continue;
      seenIds.add(cid);
      const s = sources.get(cid);
      if (!s) {
        sourceLines.push(`[${cid}] (NOT FOUND in evidence/works tables)`);
        continue;
      }
      const w = s.work;
      const card = s.card;
      const authors = (w.authors ?? []).slice(0, 3).join(", ") || "Unknown";
      const lines = [`[${cid}] "${w.title ?? "(no title)"}" — ${authors}, ${w.year ?? "n.d."}. ${w.venue ?? ""}`];
      if (card) {
        if (card.study_design) lines.push(`  Design: ${card.study_design}`);
        if (card.intervention) lines.push(`  Intervention: ${card.intervention}`);
        if (card.outcome) lines.push(`  Outcome: ${card.outcome}`);
        if (card.effect_direction) lines.push(`  Effect: ${card.effect_direction}${card.effect_size_text ? ` (${card.effect_size_text})` : ""}`);
        if (card.sample_size || card.sample_size_text) lines.push(`  Sample: ${card.sample_size || card.sample_size_text}`);
        if (card.identification_strategy) lines.push(`  Identification: ${card.identification_strategy}`);
        if (card.country) lines.push(`  Country: ${Array.isArray(card.country) ? card.country.join(", ") : card.country}`);
        if (card.mechanism) lines.push(`  Mechanism: ${card.mechanism}`);
        if (card.limitations && card.limitations.length > 0) lines.push(`  Limitations: ${Array.isArray(card.limitations) ? card.limitations.join("; ") : card.limitations}`);
        if (card.finding_short) lines.push(`  Finding: ${card.finding_short}`);
        if (card.source_text) lines.push(`  Source text: ${card.source_text.slice(0, 400)}`);
      } else {
        lines.push(`  (No evidence card extracted yet — abstract only:)`);
      }
      if (w.abstract) lines.push(`  Abstract: ${w.abstract.slice(0, 1500)}`);
      sourceLines.push(lines.join("\n"));
    }
  }

  const claimsLines = claims.map((c, i) =>
    `${i}. ${c.sentence}\n   Citations: [${c.citations.join("], [")}]`
  ).join("\n\n");

  const user = `SOURCES (the ONLY allowed grounding for verdicts):

${sourceLines.join("\n\n")}

CLAIMS (one or more citations each — judge each citation independently):

${claimsLines}

Return verdicts as JSON. One entry per (claim, citation) pair.`;

  return { system, user };
}

async function callGemini({ system, user }, modelId) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY required for --model gemini");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Gemini ${r.status}: ${text.slice(0, 400)}`);
  }
  const data = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p?.text ?? "").join("") ?? "";
  if (!text) throw new Error(`Gemini returned no text. finish=${data?.candidates?.[0]?.finishReason}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Gemini returned non-JSON. First 400: ${text.slice(0, 400)}`);
  }
}

async function callLiteLLM({ system, user }, modelId) {
  const key = process.env.LLM_API_KEY;
  const base = process.env.LLM_BASE_URL;
  if (!key || !base) throw new Error("LLM_API_KEY and LLM_BASE_URL required for --model qwen-14b-synth");
  const url = `${base.replace(/\/+$/, "")}/v1/chat/completions`;
  const body = {
    model: modelId,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0,
    max_tokens: 8192,
    response_format: { type: "json_object" },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`LiteLLM ${r.status}: ${text.slice(0, 400)}`);
  }
  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("LiteLLM returned no text.");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`LiteLLM returned non-JSON. First 400: ${text.slice(0, 400)}`);
  }
}

async function callModel(alias, prompt) {
  const spec = MODEL_ALIASES[alias];
  if (spec.backend === "gemini") return { model: spec.id, result: await callGemini(prompt, spec.id) };
  if (spec.backend === "litellm") return { model: spec.id, result: await callLiteLLM(prompt, spec.id) };
  throw new Error(`No backend for "${spec.backend}".`);
}

// ---------------------------------------------------------------------------
// Audit one section
// ---------------------------------------------------------------------------

async function auditOne(draftPath, outDir, modelAlias) {
  const draft = JSON.parse(await readFile(draftPath, "utf8"));
  console.log(`[audit] ${basename(draftPath)}`);
  console.log(`[audit]   section ${draft.sectionNumber}: ${draft.heading}`);
  console.log(`[audit]   draft: ${draft.actualWords}w, ${draft.citedWorkIds?.length ?? 0} citations`);

  const claims = splitClaims(draft.draftBody ?? "");
  if (claims.length === 0) {
    console.log(`[audit]   no cited claims found — section has no [workId] tokens.`);
    return null;
  }
  console.log(`[audit]   ${claims.length} cited sentences extracted`);

  const allCitations = [...new Set(claims.flatMap((c) => c.citations))];
  const sources = await fetchSources(allCitations);
  const missing = allCitations.filter((id) => !sources.has(id));
  if (missing.length > 0) {
    console.log(`[audit]   WARN: ${missing.length} citations not in works table: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "..." : ""}`);
  }

  const t0 = Date.now();
  const { model: usedModel, result } = await callModel(modelAlias, buildAuditPrompt(claims, sources));
  const elapsedMs = Date.now() - t0;
  const verdicts = Array.isArray(result?.verdicts) ? result.verdicts : [];
  console.log(`[audit]   ${usedModel} returned ${verdicts.length} verdicts in ${(elapsedMs / 1000).toFixed(1)}s`);

  const counts = { supported: 0, partial: 0, unsupported: 0, unverifiable: 0, other: 0 };
  for (const v of verdicts) {
    const k = ["supported", "partial", "unsupported", "unverifiable"].includes(v.verdict) ? v.verdict : "other";
    counts[k]++;
  }
  console.log(`[audit]   verdicts: ${JSON.stringify(counts)}`);

  const audit = {
    queryId: draft.queryId,
    sectionNumber: draft.sectionNumber,
    heading: draft.heading,
    draftPath: basename(draftPath),
    draftModel: draft.model,
    auditorModel: MODEL_ALIASES[modelAlias].id,
    auditedAt: new Date().toISOString(),
    elapsedMs,
    counts,
    claimCount: claims.length,
    citationCount: allCitations.length,
    missingFromWorks: missing,
    claims: claims.map((c, i) => ({
      index: i,
      sentence: c.sentence,
      citations: c.citations,
      verdicts: verdicts.filter((v) => v.claimIndex === i),
    })),
    flagged: verdicts.filter((v) => ["partial", "unsupported"].includes(v.verdict)),
  };

  await mkdir(outDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const outPath = resolve(outDir, `audit-${draft.queryId}-${draft.sectionNumber}-${today}.json`);
  await writeFile(outPath, JSON.stringify(audit, null, 2) + "\n");
  console.log(`[audit]   wrote ${outPath}`);

  // Surface flagged claims to stdout for quick scanning
  if (audit.flagged.length > 0) {
    console.log(`[audit]   FLAGGED CLAIMS (${audit.flagged.length}):`);
    for (const v of audit.flagged.slice(0, 5)) {
      const claim = claims[v.claimIndex];
      console.log(`    [${v.verdict.toUpperCase()}] cite=[${v.citation}]`);
      console.log(`      sentence: ${claim?.sentence?.slice(0, 200) ?? "(?)"}`);
      console.log(`      rationale: ${v.rationale?.slice(0, 200) ?? "(none)"}`);
    }
    if (audit.flagged.length > 5) console.log(`    ... and ${audit.flagged.length - 5} more in the JSON.`);
  }

  return audit;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const paths = await findDraftPaths(args);
  console.log(`[audit] auditing ${paths.length} draft${paths.length !== 1 ? "s" : ""}`);
  const audits = [];
  for (const p of paths) {
    const a = await auditOne(p, args.outDir, args.model);
    if (a) audits.push(a);
  }

  if (audits.length > 1) {
    const totals = { supported: 0, partial: 0, unsupported: 0, unverifiable: 0, other: 0 };
    for (const a of audits) for (const k of Object.keys(totals)) totals[k] += a.counts[k] ?? 0;
    console.log(`\n[audit] overall verdicts across ${audits.length} sections: ${JSON.stringify(totals)}`);
  }
}

main().catch((err) => { console.error("[audit] fatal:", err); process.exit(1); });
