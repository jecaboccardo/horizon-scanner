# AI Gateway - LiteLLM/Qwen + Gemini

## Setup

- `LLM_BASE_URL` points to the OpenAI-compatible LiteLLM proxy.
- `LLM_API_KEY` is required for Qwen extraction, query expansion, and embeddings.
- `QWEN_MODEL` defaults to `qwen2.5:14b-synthesis` (set 2026-05-20; the earlier non-synthesis Qwen variant was removed from the LiteLLM proxy — `qwen2.5:14b-synthesis` is now the only general-purpose LLM available). Source of truth for the default: `qwenClient.ts`.
- `GEMINI_API_KEY` powers synthesis; deterministic fallback always remains available.
- Clients live under `supabase/functions/_shared/` and run through the Deno API path.

## Gemini model routing (2026-07-09, v149–v154)

Three env vars select Gemini models; each falls back to `DEFAULT_GEMINI_MODEL` in
`llmConfig.ts` (currently `gemini-flash-latest`) when unset. **Env beats the code
default** — a stale pin silently overrides a code fix (this bit us: the bare
`gemini-2.5-flash` alias was RETIRED by Google 2026-07-09 → hard 404, and a VPS
`GEMINI_MODEL=gemini-2.5-flash` pin masked the v149 default fix; never pin the bare
alias — use `gemini-flash-latest`).

| Env var | Used by | Prod value | Notes |
|---------|---------|-----------|-------|
| `GEMINI_MODEL` | brief synthesis (`geminiClient.ts`), creative planner | unset → `gemini-flash-latest` | leave UNSET so the code default wins |
| `GEMINI_JEL_MODEL` | JEL **section drafting** + outline + revise re-draft (`jelPaperPipeline.callGemini`) | `gemini-pro-latest` | Pro chosen 2026-07-09 A/B: clean citation-grounded prose vs flash's scratchpad/per-section-refs leaks |
| `GEMINI_JEL_QA_MODEL` | JEL **QA passes** — Devil's Advocate, coherence editor, claim audit, final review, corrector, revision routing | unset → `gemini-flash-latest` | these don't need Pro prose quality; keeps Pro spend to section drafting only (~halves it) |

**Cost/quality (measured 2026-07-09, thinking tokens INCLUDED — the true numbers):**
full-Pro ≈ **$2/paper** (Pro thinking ≈ 3–4× prose, billed as output); Pro-draft +
flash-QA ≈ **$1.42**; + flash-thinking-off ≈ **$1.2** (the practical floor). Flash-only
≈ $0.3 but leaks scratchpad/lists on hard sections. (Pre-v153 figures of $0.10/$0.41
were understated — thinking wasn't logged yet.) Quality of Pro-draft+flash-QA ==
full-Pro (clean prose, strong critique).

**Two cost levers, in order:** (1) **route fewer calls to Pro** — `callGemini(…, model?)`
sends the ~12 QA passes to `GEMINI_JEL_QA_MODEL` (flash) with descriptive ops
(`jel_devils_advocate`, `jel_claim_audit`, …) so telemetry splits pro-draft vs flash-QA
by `model`+`operation`. (2) **disable flash thinking** — `callGemini` sets
`thinkingConfig.thinkingBudget=0` when the model is flash (flash thinks by default; QA
doesn't need it → ~90k thinking tokens/paper saved + faster). **Pro thinking CANNOT be
disabled** (`thinkingBudget:0` → 400 "only works in thinking mode"; low budgets are a
soft hint Pro ignores) — it's the ~$1 floor and the quality you pay for. Live config:
`GET /api/_version`.

**(3) Batch Mode for Pro drafting (2026-07-13, v159) — halves the Pro floor incl.
thinking.** `callGeminiDraft` → `callGeminiBatch` submits each app-key **Pro** drafting
call as a single-request Batch API job (`:batchGenerateContent`), polls every
`GEMINI_BATCH_POLL_MS` (15s), and on `BATCH_STATE_SUCCEEDED` reads
`response.inlinedResponses[0]`. Batch bills **50% of list on everything including
thinking** — the one lever that touches the Pro floor. JEL is a background job, so the
added latency is fine (measured turnaround ~2–5 min/call). **15-min deadline
(`GEMINI_BATCH_DEADLINE_MS`) → cancel + fall through to the interactive retry loop**, so
batch can only add latency, never lose a section. Batch is SKIPPED for BYOK (user's own
key, interactive contract) and for flash (already cheap; QA is latency-sensitive).
Batch calls log `model="<model>@batch"` (priced at 50% in `llm-cost-report.mjs` +
`monitor/pricing.ts` + `index.ts` MODEL_RATES; `estimateGeminiCallUsd` applies 0.5×).
`GEMINI_BATCH_DRAFT=0` disables. Live config: `GET /api/_version` → `jelBatch`.
**Measured all-Gemini deep-mode paper: ~$0.42** (vs ~$1.2 interactive), quality parity
(prose scan clean, judge parity).

**Gemini-first drafting, Qwen is LAST resort (2026-07-13).** Per owner preference, drafting
never drops to Qwen on the first hiccup. `callGeminiDraft` retries Gemini up to
`GEMINI_DRAFT_ATTEMPTS` (3) with 10s/30s backoff on retryable errors (timeout/429/5xx/
overloaded/no-text), 180s per-attempt budget (`GEMINI_DRAFT_TIMEOUT_MS` — Pro thinking on
a ~12k-token prompt runs 60–100s, so the old 120s self-timed-out). Non-retryable 4xx throws
immediately. Only after all attempts fail does it fall to Qwen; a post-drafting **upgrade
pass** then re-attempts Gemini for any section that fell to Qwen during an outage (replaces
the Qwen draft only if the re-draft passes the word-floor + `sectionContentIssue` checks).

## Qwen concurrency gate (2026-07-09, v146) — `qwenGate.ts`

The `qwen2.5:14b-synthesis` model is a SINGLE-GPU instance that serializes concurrent
requests (measured: 1 call ~3-5s, 5 concurrent up to ~15s). A process-wide priority
semaphore (`qwenGate`, cap `QWEN_MAX_CONCURRENCY`=2) fronts EVERY 14b call so bursts
queue instead of dogpiling. **No degradation** — callers WAIT, they don't drop to a
fallback; interactive work (search/chat) has priority over `background:true` work
(JEL section drafting, topicality). Both `qwenClient.qwenGenerate` (pass
`background`/`gateWaitMs` via `QwenOptions`) and `jelPaperPipeline.callQwen` route
through it. Per-request timeouts start AFTER slot acquire (queue wait ≠ request budget);
the acquire ceiling (`QWEN_GATE_WAIT_MS`/`_BG_MS`) is a wedged-GPU safety net only.
Live counters: `GET /api/_version` → `qwenGate`. Scope is per deno-api process — it does
NOT bound the CT135 worker or backfill scripts, so "no heavy backfills while prod is live"
still holds. Embeddings (`qwen3-embedding:8b-app`, `ollamaClient`) are a different
model/GPU and are NOT gated.

## Telemetry & cost (2026-07-09, v147)

Every LLM call logs to the `llm_calls` table via `telemetry.logLlmCall` (fail-safe,
fire-and-forget) — including the marginal-band judge (`operation=band_judge`,
`crossEncoder.ts`, both Qwen and Gemini scorers). **Claude prompt-cache tokens** are
logged separately (`cache_read_tokens`/`cache_write_tokens`, migration
`20260709000001`); `scripts/llm-cost-report.mjs` prices the three token classes
correctly (read 0.1×, write 1.25×, fresh 1×) and prints a cache-hit summary — DON'T
price cached reads at full input rate. **Gemini thinking tokens** (`thinking_tokens`,
migration `20260709000002`) log `usageMetadata.thoughtsTokenCount` — billed at the
OUTPUT rate but NOT part of `tokens_out` (candidatesTokenCount). Without it, Pro cost is
understated ~2-3× (Pro thinking ≈ 3× prose). The cost report prices it at the output
rate; null for non-thinking calls (flash budget 0, Qwen, embeddings, Claude). Weekly cost report:
`.github/workflows/llm-cost-report.yml` runs `scripts/llm-cost-report.mjs --days 7`
every Monday; run locally with `node --env-file=.env scripts/llm-cost-report.mjs --days N`.

**Cost tiering (BYOK Claude):** chat prompts are split (`buildChatUserPrompt(...,true)`)
so Claude caches the evidence block across turns (brief synthesis is a single call →
NOT split). `chat_suggestions` + `chat_verifier` run on self-hosted Qwen, NOT the BYOK
key — keep them there; don't route cheap sub-tasks back onto Sonnet. Live prod
ranking/judge config is verifiable without SSH via `GET /api/_version`
(`rerank` + `judge` + `qwenGate` blocks).

## Batched QA calls — do not de-batch

The JEL claim audit (`jelPaperPipeline.ts` `runClaimAudit`, ≤8 claim/source pairs per
call) and the corrector triage (`corrector.ts`, ≤8 issues per call per section) send
NUMBERED batches and remap verdicts by item index. This is batching, not sampling —
coverage is every cited paper / every flagged issue. Keep verdict criteria and action
menus verbatim when editing these prompts; only the I/O shape is batched.

## APIs Used

LiteLLM exposes OpenAI-shaped `/v1/chat/completions` and `/v1/embeddings`.
Gemini is called through `geminiClient.ts` for synthesis.

## Structured Output Schema

The AI must return exactly this shape:

```json
{
  "summaryBullets": ["string"],
  "methodologyNote": "string",
  "coverageCard": {
    "universeCount": "number",
    "retrievedCount": "number",
    "admissibleCount": "number",
    "evidenceCount": "number",
    "signalCount": "number",
    "gapSummary": "string",
    "regionalGap": "string",
    "methodologicalGap": "string"
  },
  "followUpQuestions": ["string"],
  "warnings": ["string"]
}
```

`evidenceRows` and `citations` are not AI-generated. They always come from the
retrieval pipeline and are merged in after synthesis.

## Deterministic Fallback

`synthesizeDeterministicBrief()` in `synthesis.ts` always runs first. It produces
a complete brief using:

- Top evidence rows as summary bullets
- Methodology mix derived from work designs
- Coverage stats from retrieval
- LAC-specific gap notes
- Follow-up questions templated from the query

If Gemini is available, its output is merged over the deterministic base. If
Gemini fails or returns null, the deterministic brief ships as-is.

The deterministic fallback is a product requirement. Never remove it.

## System Prompt

The synthesis system prompt enforces:

- No invented evidence rows or citations
- All claims grounded in provided evidence
- Output must match the expected JSON shape

## Prompt Inputs Passed to AI

Two prompt family outputs are bundled and sent as context:

1. `queryPlanning` - expanded search frame
2. `synthesis` - brief generation instructions (citation balance/context rules;
   it no longer re-serializes the evidence rows)

These are generated deterministically from
`supabase/functions/_shared/prompts.ts` and passed alongside coverage stats and
the SINGLE evidence block built in `geminiClient.buildUserPrompt` (workId,
title, year, source, SMS, design, DIRECT/INDIRECT tag, finding ≤300 chars).
The former `sourceScreening`/`methodologyTagging` families were retired
2026-07-06 — they re-serialized every evidence title/abstract for no new signal.
