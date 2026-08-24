#!/usr/bin/env node
/**
 * check-invariants — fail the build when a value that lives in two places drifts.
 *
 * Some constants can't share a single import (frontend TSX ↔ Deno TS), so they're
 * duplicated and kept equal by discipline. This script makes that discipline
 * enforceable: it parses the source text of each copy and asserts they match.
 *
 * Source of truth + replicas tracked here are documented in docs/CONSISTENCY_AUDIT.md.
 * If you later single-source one of these via a shared import, drop its check.
 *
 * Exit 0 = all invariants hold; exit 1 = drift (with a precise diff).
 */
import { readFile } from "node:fs/promises";

const FAIL = [];
const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

// --- helpers ---------------------------------------------------------------
function extractChannelWeights(src, label) {
  const out = {};
  for (const ch of ["causal", "foundational", "recent", "lac"]) {
    const m = src.match(new RegExp(`\\b${ch}\\s*:\\s*\\{([^}]*)\\}`));
    if (!m) { FAIL.push(`[weights] ${label}: channel '${ch}' not found`); continue; }
    const nums = {};
    for (const km of m[1].matchAll(/(\w+)\s*:\s*([\d.]+)/g)) nums[km[1]] = parseFloat(km[2]);
    out[ch] = nums;
  }
  return out;
}
function quotedStrings(block) {
  return [...block.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
}
function arrayAfter(src, name) {
  // The declaration `[const] NAME[: Type[]] = [ ... ]`. Anchor on the `=` so we
  // skip type-annotation brackets (e.g. `ChannelId[]`) and bare comment mentions.
  const m = src.match(new RegExp(`\\b${name}\\b[^=\\n]*=\\s*\\[([^\\]]*)\\]`));
  return m ? quotedStrings(m[1]) : null;
}
const eqSet = (a, b) => a && b && a.length === b.length &&
  [...a].sort().join("|") === [...b].sort().join("|");

// --- 1. per-channel rerank weights: rerank.ts == App.tsx -------------------
{
  const rerank = await read("supabase/functions/_shared/rerank.ts");
  const app = await read("App.tsx");
  const a = extractChannelWeights(rerank, "rerank.ts CHANNEL_RERANK_WEIGHTS");
  const b = extractChannelWeights(app, "App.tsx channelsToRerankWeights");
  for (const ch of ["causal", "foundational", "recent", "lac"]) {
    const ka = a[ch] || {}, kb = b[ch] || {};
    const keys = new Set([...Object.keys(ka), ...Object.keys(kb)]);
    for (const k of keys) {
      if (ka[k] !== kb[k]) {
        FAIL.push(`[weights] ${ch}.${k}: rerank.ts=${ka[k]} but App.tsx=${kb[k]} — keep CHANNEL_RERANK_WEIGHTS and channelsToRerankWeights in sync`);
      }
    }
  }
}

// --- 2. LAC region keyword list: rerank.ts == retrieval.ts == utils/queryIntent.ts
{
  const rerank = await read("supabase/functions/_shared/rerank.ts");
  const retrieval = await read("supabase/functions/_shared/retrieval.ts");
  const intent = await read("utils/queryIntent.ts");
  const a = (rerank.match(/["']LAC["']\s*:\s*\[([\s\S]*?)\]/) || [])[1];
  const b = (retrieval.match(/["']LAC["']\s*:\s*\[([\s\S]*?)\]/) || [])[1];
  // Third copy (2026-06-10): the frontend clarify-card geo detector — frontend
  // can't import the Deno modules, so it carries its own list.
  const c = (intent.match(/LAC_KEYWORDS\s*:\s*string\[\]\s*=\s*\[([\s\S]*?)\]/) || [])[1];
  if (!a || !b) FAIL.push("[region] REGION_KEYWORDS['LAC'] not found in rerank.ts and/or retrieval.ts");
  else if (!eqSet(quotedStrings(a), quotedStrings(b))) {
    FAIL.push("[region] REGION_KEYWORDS['LAC'] differs between rerank.ts and retrieval.ts — keep them identical");
  }
  if (!c) FAIL.push("[region] LAC_KEYWORDS not found in utils/queryIntent.ts");
  else if (a && !eqSet(quotedStrings(a), quotedStrings(c))) {
    FAIL.push("[region] LAC_KEYWORDS in utils/queryIntent.ts differs from REGION_KEYWORDS['LAC'] in rerank.ts — keep all three copies identical");
  }
}

// --- 3. VALID_CHANNEL_IDS: types.ts == retrieval.ts ------------------------
{
  const types = await read("types.ts");
  const retrieval = await read("supabase/functions/_shared/retrieval.ts");
  const a = arrayAfter(types, "VALID_CHANNEL_IDS");
  const b = arrayAfter(retrieval, "VALID_CHANNEL_IDS");
  if (!a || !b) FAIL.push("[channels] VALID_CHANNEL_IDS not found in types.ts and/or retrieval.ts");
  else if (!eqSet(a, b)) FAIL.push(`[channels] VALID_CHANNEL_IDS differs: types.ts=[${a}] retrieval.ts=[${b}]`);
}

// --- 4. active persona set: prompts.ts == types.ts == ['policy'] -----------
{
  const prompts = await read("supabase/functions/_shared/prompts.ts");
  const types = await read("types.ts");
  const a = arrayAfter(prompts, "PERSONA_IDS");
  const b = arrayAfter(types, "AUDIENCE_IDS");
  if (!eqSet(a, b)) FAIL.push(`[persona] active set differs: prompts.ts PERSONA_IDS=[${a}] vs types.ts AUDIENCE_IDS=[${b}]`);
  if (a && !eqSet(a, ["policy"])) FAIL.push(`[persona] active set is [${a}] — expected ['policy'] (policy-only register)`);
}

// --- 5. foundational cite threshold (75) present in both sites -------------
{
  const app = await read("App.tsx");
  const tgc = await read("supabase/functions/_shared/topicGeoChannel.ts");
  const appHas = /citations?\s*>=\s*75/.test(app) || />=\s*75/.test(app);
  const tgcHas = /citation_count["']?\s*,?\s*75|>=\s*75|gte\(["']citation_count["'],\s*75/.test(tgc);
  if (!appHas || !tgcHas) {
    FAIL.push("[foundational] cite threshold 75 not found in App.tsx isFoundational and/or topicGeoChannel foundational slice — if you changed it, change BOTH (and the docs)");
  }
}

// --- 6. SearchFilters field contract: retrieval.ts ⊆ types.ts --------------
// retrieval.ts hand-copies the SearchFilters shape (can't import the frontend
// type across the Deno/TSX boundary). A field retrieval.ts READS that types.ts
// doesn't define can never arrive from the client → a silent always-undefined
// filter. Assert every retrieval field exists in the types.ts contract, minus a
// documented legacy exception. (types.ts may have MORE fields — retrieval simply
// ignores those, which is fine; this is a subset check, not equality.)
{
  const types = await read("types.ts");
  const retrieval = await read("supabase/functions/_shared/retrieval.ts");
  const fieldsOf = (src) => {
    const m = src.match(/interface SearchFilters\s*\{([\s\S]*?)\n\}/);
    if (!m) return null;
    return new Set([...m[1].matchAll(/^\s*(\w+)\??\s*:/gm)].map((x) => x[1]));
  };
  const t = fieldsOf(types), r = fieldsOf(retrieval);
  // KNOWN legacy divergence: retrieval reads filters.methodology, but the frontend
  // SearchFilters dropped it — so that methodology filter is effectively dead until
  // it's re-added to types.ts (a product decision, see docs/AUDIT-2026-06-09.md).
  // Documented here so it doesn't mask a NEW drift.
  const KNOWN_RETRIEVAL_ONLY = new Set(["methodology"]);
  if (!t || !r) FAIL.push("[filters] interface SearchFilters not found in types.ts and/or retrieval.ts");
  else {
    const extra = [...r].filter((f) => !t.has(f) && !KNOWN_RETRIEVAL_ONLY.has(f));
    if (extra.length) FAIL.push(`[filters] retrieval.ts SearchFilters reads field(s) absent from the types.ts contract: [${extra}] — add them to types.ts (frontend can't send them) or remove from retrieval.ts`);
  }
}

// --- 7. clarifier channel decomposition: QUESTION_CHANNELS_VALUES ⊆ VALID_CHANNEL_IDS
// The 6-step clarifier (SearchClarifier) only ASSEMBLES the four existing
// channel ids — it must never invent a new one. App.tsx exports the values its
// UI questions can produce; assert each is a real VALID_CHANNEL_IDS member.
{
  const app = await read("App.tsx");
  const types = await read("types.ts");
  const q = arrayAfter(app, "QUESTION_CHANNELS_VALUES");
  const valid = arrayAfter(types, "VALID_CHANNEL_IDS");
  if (!q) FAIL.push("[clarifier] QUESTION_CHANNELS_VALUES not found in App.tsx");
  else if (!valid) FAIL.push("[clarifier] VALID_CHANNEL_IDS not found in types.ts");
  else {
    const validSet = new Set(valid);
    const extra = q.filter((v) => !validSet.has(v));
    if (extra.length) FAIL.push(`[clarifier] QUESTION_CHANNELS_VALUES has channel id(s) absent from VALID_CHANNEL_IDS: [${extra}] — the clarifier UI must only assemble VALID_CHANNEL_IDS`);
  }
}

// --- 8. search-config reset guard: every search-INTENT useState resets on new search
// Leak class (incident 2026-06-12): search configuration lives in long-lived App.tsx
// component state, and "new search" was a hand-maintained list of setX() resets. A
// forgotten field (filters.regions) silently leaked a hard ['Sub-Saharan Africa']
// filter into an unrelated query → all-Africa table, Jensen 2010 dropped. This guard
// makes the leak impossible to reintroduce: EVERY useState in App.tsx must either be
// reset in resetSearchConfig()/handleNewSearch(), or be explicitly listed as
// NON_CONFIG (state that legitimately does NOT carry search intent — UI toggles,
// per-brief lifecycle objects, session/data, async JEL/signals). A NEW useState that
// is neither reset nor allow-listed fails CI → forces a deliberate decision.
{
  const app = await read("App.tsx");
  const states = [...app.matchAll(/const \[(\w+),\s*set\w+\]\s*=\s*useState/g)].map((m) => m[1]);
  // Reset region = resetSearchConfig() body + handleNewSearch() body (contiguous,
  // followed by handleBackToStep1 which deliberately PRESERVES config and is excluded).
  const slice = (app.match(/function resetSearchConfig\(\)[\s\S]*?\n  function handleBackToStep1/) || [])[0] || "";
  // State that does NOT change what gets retrieved or how the brief is synthesized,
  // so it need not reset on a new search. Adding a new useState here is a conscious
  // "this is not search intent" decision (the whole point of the guard).
  const NON_CONFIG = new Set([
    "activeJelJobId", "activePlan", "briefBasisIds", "chatError", "chatIsLoading",
    "chatMessages", "chatStreamingText", "clarifyingPhase", "currentBrief",
    "currentJelPaper", "currentRun", "currentVisibleState", "deepScanNotice",
    "deepScanResult", "deepScanStatus", "errorMessage", "examplesPopoverOpen",
    "highlightedSuggestionIdx", "historySidebarOpen", "isLoadingMore",
    "isPasswordRecovery", "isRegenerating", "jelJobFingerprint", "jelPaperProgress",
    "lastRunNextToken", "notes", "pendingSynthesis", "regenCount", "searchStatus",
    "seedingPaper", "session", "sessionLoading",
    // showClaudeSetup: visibility toggle for the Claude Code setup modal/card
    // (plugin onboarding) — UI-only, carries no search intent.
    "showClaudeSetup",
    "showAccount", "showMobileHistory", "signalsError", "signalsFetchedFor",
    "signalsLoading", "signalsResult", "snapshot", "streamingText",
    "suggestionsOpen", "tab",
  ]);
  if (!slice) {
    FAIL.push("[search-reset] resetSearchConfig()/handleNewSearch() block not found in App.tsx — the leak guard can't run");
  } else {
    for (const s of states) {
      if (NON_CONFIG.has(s)) continue;
      const setter = "set" + s[0].toUpperCase() + s.slice(1);
      if (!slice.includes(setter + "(")) {
        FAIL.push(`[search-reset] '${s}' is a search-config useState but its setter (${setter}) is not called in resetSearchConfig()/handleNewSearch() — reset it so a prior search can't leak into the next, or add it to NON_CONFIG in check-invariants with a reason. (Leak incident 2026-06-12: filters.regions.)`);
      }
    }
  }
}

// --- 9. JEL section-count cap: jelGenerationSpec.ts == jelPaperPipeline.ts maxSections
// The served writing contract (jelGenerationSpec.buildJelGenerationSpec, GET
// /api/generation-spec) is INHERITED verbatim by the Claude Code plugin (fetched live
// at runtime by claude-plugin/commands/horizon.md — no local plugin copy of the section
// cap to drift). The server drafter hard-caps the outline at `maxSections` total
// sections (jelPaperPipeline.ts). If the spec's stated section count drifts above that
// cap, the plugin promises more sections than the app can produce. Assert the number
// the spec states equals the pipeline cap.
// (Drift incident: spec said "5–9 body sections" while the pipeline capped at 7. The
// plugin's former skills/jel-paper/SKILL.md echoed this number too, but that file was
// removed 2026-07-09 — it was dead weight, never invoked by horizon.md, which fetches
// the spec live instead.)
{
  const spec = await read("supabase/functions/_shared/jelGenerationSpec.ts");
  const pipeline = await read("supabase/functions/_shared/jelPaperPipeline.ts");
  const cap = ((pipeline.match(/maxSections\s*=\s*(\d+)/) || [])[1]) ?? null;
  // Spec states "N–M numbered sections total".
  const specMax = (spec.match(/\d+\s*[–—-]\s*(\d+)\s+numbered sections total/i) || [])[1] ?? null;
  if (cap === null) {
    FAIL.push("[jel-sections] maxSections not found in jelPaperPipeline.ts — the section-cap invariant can't run");
  }
  if (specMax === null) {
    FAIL.push("[jel-sections] section-count range ('N–M numbered sections total') not found in jelGenerationSpec.ts JEL_STRUCTURE — state the total-section cap so it can be checked against the pipeline");
  } else if (cap !== null && specMax !== cap) {
    FAIL.push(`[jel-sections] jelGenerationSpec states max ${specMax} sections but jelPaperPipeline.ts maxSections=${cap} — the SERVED writing contract (which the plugin inherits) must state the pipeline's real cap`);
  }
}

// --- 10. citation-strip regex: identical across export, render, and the plugin command
// The inline [workId] citation fence is stripped from reader-facing prose in THREE
// places that can't share an import: the export path (exportService.ts), the render
// path (JelPaperView.tsx, twice), and the plugin's command doc (horizon.md), which
// documents the exact regex the plugin's local Claude must apply. If any copy
// diverges, the app and the plugin strip DIFFERENT tags → visibly different output.
// (Drift incident: exportService carried a {3,80} upper bound the other sites lack.
// The plugin's former skills/jel-paper/SKILL.md also carried a copy but was removed
// 2026-07-09 — dead weight, never invoked; horizon.md is the plugin's only copy now.)
{
  const files = {
    "services/exportService.ts": await read("services/exportService.ts"),
    "components/JelPaperView.tsx": await read("components/JelPaperView.tsx"),
    "claude-plugin/commands/horizon.md": await read("claude-plugin/commands/horizon.md"),
  };
  // Matches the literal citation-strip pattern text `\s*\[[^\]]{N[,M]}\]` wherever it
  // appears (JS regex literal or fenced markdown). Structure is fixed; only the
  // {quantifier} may vary — but m[0] is the whole pattern, so ANY structural edit
  // that this can't match trips the "not found" branch (also a drift).
  const RE = /\\s\*\\\[\[\^\\\]\]\{[0-9,]+\}\\\]/g;
  const byPattern = new Map(); // matched pattern text -> Set(files)
  const missing = [];
  for (const [name, src] of Object.entries(files)) {
    const found = [...src.matchAll(RE)].map((m) => m[0]);
    if (found.length === 0) { missing.push(name); continue; }
    for (const pat of found) {
      if (!byPattern.has(pat)) byPattern.set(pat, new Set());
      byPattern.get(pat).add(name);
    }
  }
  if (missing.length) {
    FAIL.push(`[cite-strip] citation-strip regex (\\s*\\[[^\\]]{N,}\\]) not found in: [${missing.join(", ")}] — it MUST be present and identical in the export path, the render path, and both plugin files`);
  }
  if (byPattern.size > 1) {
    const detail = [...byPattern.entries()]
      .map(([pat, fs]) => `"${pat}" in [${[...fs].join(", ")}]`).join(" ;; ");
    FAIL.push(`[cite-strip] citation-strip regex DIFFERS across copies: ${detail} — make them byte-identical (drop any length upper-bound); render + export + plugin must strip the same tags`);
  }
}

// --- report ----------------------------------------------------------------
if (FAIL.length) {
  console.error(`[check-invariants] ${FAIL.length} invariant(s) FAILED:`);
  for (const f of FAIL) console.error("  ✗ " + f);
  console.error("\nThese values are duplicated by necessity (cross-runtime). Re-sync them, or see docs/CONSISTENCY_AUDIT.md.");
  process.exit(1);
}
console.log("[check-invariants] ok — channel weights, LAC keywords, channel ids, persona set, foundational threshold, SearchFilters contract, clarifier channel decomposition, search-config reset guard, JEL section cap, citation-strip regex all in sync");
