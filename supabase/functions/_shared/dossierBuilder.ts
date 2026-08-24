/**
 * dossierBuilder.ts — on-demand, web-grounded dossier BUILDER (Deno).
 *
 * Companion to the read-only `dossiers.ts` accessor. The offline Node worker
 * (scripts/build-dossiers-worker.mjs) builds dossiers from OA PDFs (pdf-parse,
 * Node-only) AND a verified-web fallback. This module ports ONLY the web path
 * so the Deno generation pipeline can enrich a CORE paper on-demand when it has
 * no cached dossier — pdf-parse is not resolvable under Deno, so PDF dossiers
 * still come exclusively from the worker.
 *
 * Web grounding = Gemini + Google Search (a Gemini-specific capability), so this
 * uses the APP GEMINI_API_KEY directly and is INDEPENDENT of any BYOK key — a
 * BYOK-Claude user's web enrichment does NOT bill their Claude.
 *
 * 🔒 GOLDEN RULE: writes ONLY `work_dossiers` (the cache). Never writes `works`.
 * 🛡  SOFT-FAIL: any failure (no key, HTTP error, NOT_FOUND, too short) → returns
 *    null; the caller proceeds with cached/abstract evidence.
 */

import type { Dossier, DossierWork } from "./dossiers.ts";
import { buildIndexEntry } from "./dossiers.ts";

// Bare `gemini-2.5-flash` was retired 2026-07-09 (hard 404) — use the
// forward-compatible alias, same as llmConfig.DEFAULT_GEMINI_MODEL.
const GEMINI_MODEL = (typeof Deno !== "undefined" ? Deno.env.get("DOSSIER_GEMINI_MODEL") : undefined) ?? "gemini-flash-latest";

function geminiKey(): string | null {
  try {
    return (typeof Deno !== "undefined" ? Deno.env.get("GEMINI_API_KEY") : undefined) ?? null;
  } catch {
    return null;
  }
}

/** Gemini + Google Search grounding. Returns the grounded answer text, or "" on failure. */
async function geminiGrounded(prompt: string, maxTokens = 700, timeoutMs = 8000): Promise<string> {
  const key = geminiKey();
  if (!key) return "";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens },
        }),
        signal: ctrl.signal,
      },
    );
    if (!r.ok) return "";
    const j = await r.json();
    // deno-lint-ignore no-explicit-any
    return ((j.candidates?.[0]?.content?.parts ?? []) as any[]).map((p) => p.text || "").join("").trim();
  } catch {
    return "";
  } finally {
    clearTimeout(t);
  }
}

/** Name-gated, hedged web-brief prompt (verbatim port of the worker's webBriefPrompt). */
function webBriefPrompt(w: DossierWork): string {
  const auth = Array.isArray(w.authors) ? w.authors.slice(0, 4).join(", ") : String(w.authors ?? "");
  return [
    "Find published effect sizes, main findings, sample, and caveats for THIS SPECIFIC paper:",
    `  "${w.title}" — ${auth || "unknown authors"} (${w.year ?? "n.d."})`,
    "",
    "HARD RULES (citation integrity — a wrong attribution poisons a literature survey):",
    "- Use ONLY a source that EXPLICITLY names THIS paper (its title, OR its authors AND year).",
    "  Prefer the paper itself (working-paper or published version) or a review/replication citing it by name.",
    "- Do NOT report a number from a different-but-similar study. If unsure the number is from THIS exact",
    "  paper, do not report it.",
    "- If you cannot find a source clearly naming this exact paper, output EXACTLY: NOT_FOUND",
    '- HEDGE every magnitude (web-sourced, not read from the full text): "the study reports approximately ...".',
    "",
    'If found, OUTPUT this markdown (no preamble, no fences); "not stated" where unknown:',
    "- **Research question:** ...",
    "- **Data & sample:** ...",
    "- **Identification strategy:** ...",
    '- **Main results:** ... (hedged magnitudes, e.g. "the study reports approximately +0.2 SD on ...")',
    "- **Limitations / caveats:** ...",
    "- **Setting / geography:** ...",
  ].join("\n");
}

/**
 * Build a verified-web dossier for one work and upsert it into `work_dossiers`
 * (source='web', status='ok'), so subsequent generations read it from cache.
 * Returns the Dossier on success, or null (soft-fail) on any problem.
 *
 * @param client supabase admin client
 * @param w      the work (needs id/title/authors/year; abstract optional)
 * @param timeoutMs per-fetch ceiling for the grounding call
 */
// deno-lint-ignore no-explicit-any
export async function buildWebDossier(client: any, w: DossierWork, timeoutMs = 8000): Promise<Dossier | null> {
  if (!w?.id || !w?.title) return null;
  const out = await geminiGrounded(webBriefPrompt(w), 700, timeoutMs);
  // Same acceptance gate as the worker: name-gated NOT_FOUND + min length.
  if (!out || out.length < 120 || /NOT_FOUND/i.test(out)) return null;

  const indexEntry = buildIndexEntry(w);
  const tokenCount = Math.ceil(out.length / 4);
  const nowIso = new Date().toISOString();

  // Cache it (best-effort — a write failure does not invalidate the in-memory result).
  try {
    await client.from("work_dossiers").upsert({
      work_id: w.id,
      index_entry: null,
      full_text: out,
      token_count: tokenCount,
      source: "web",
      source_url: null,
      status: "ok",
      fetched_at: nowIso,
      updated_at: nowIso,
    }, { onConflict: "work_id" });
  } catch { /* table missing / write race — still return the brief for this run */ }

  return {
    workId: w.id,
    indexEntry,
    fullText: out,
    tokenCount,
    source: "web",
    status: "ok",
    cached: false,
  };
}
