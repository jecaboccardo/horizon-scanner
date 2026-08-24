#!/usr/bin/env node
/**
 * scripts/llm-cost-report.mjs
 *
 * Per-operation / per-model cost + latency report over the prod `llm_calls`
 * telemetry table. Built for the single-provider cost decision: it prints how
 * many calls, tokens, latency, and *estimated* USD each operation and each
 * model is responsible for, plus a projected 30-day figure.
 *
 * DATA SOURCE: self-hosted Supabase PostgREST (`llm_calls` table) using the
 * SERVICE ROLE key — same connection pattern as the other scripts (raw fetch,
 * apikey + Bearer, env from process.env).
 *
 * RUN:
 *   node --env-file=.env scripts/llm-cost-report.mjs --days 14
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment (.env).
 *
 * llm_calls schema (supabase/migrations/20260603000001_telemetry.sql +
 * 20260626000001_llm_calls_attribution.sql):
 *   ts timestamptz | model text | operation text | tokens_in int |
 *   tokens_out int | latency_ms int | status text | error text |
 *   tenant_id text | user_id text | key_id text
 * NOTE: the timestamp column is `ts` (NOT `created_at`).
 *
 * NOTE ON COVERAGE: this report only sees calls that were logged via
 * telemetry.logLlmCall(). As of 2026-07-09 the RB_JUDGE_BAND cross-encoder
 * (crossEncoder.ts) logs both its Gemini and Qwen scorers as operation
 * "band_judge" — windows that predate that deploy under-count the judge.
 * The run prints a caveat when no band_judge rows appear in the window.
 */

// ---------------------------------------------------------------------------
// Pricing — copied verbatim from supabase/functions/api/index.ts (~lines 74-82)
// so cost estimates match what the app surfaces. USD per 1M tokens [in, out].
// Models absent from this table estimate to $0 (e.g. qwen*, embeddings) — they
// run on self-hosted GPU / a flat-rate proxy, not per-token billed.
// ---------------------------------------------------------------------------
const MODEL_RATES = {
  "claude-opus-4-8": [15, 75],
  "claude-sonnet-4-6": [3, 15],
  "gemini-2.5-flash": [0.30, 2.50], // legacy rows (model retired 2026-07-09)
  "gemini-flash-latest": [0.30, 2.50], // current default — same Flash pricing
  // Gemini 2.5 Pro tiered: [1.25,10] for prompts <=200k, [2.50,15] above. Our
  // per-call prompts are <200k so the low tier applies. NOTE: Pro runs in
  // thinking mode — thoughtsTokenCount bills as OUTPUT, so Pro output cost is
  // materially higher than a naive prose-token estimate.
  "gemini-2.5-pro": [1.25, 10],
  "gemini-pro-latest": [1.25, 10],
  // Batch Mode calls (jelPaperPipeline callGeminiBatch) log with an "@batch"
  // suffix — Google bills batch at 50% of list, thinking included.
  "gemini-pro-latest@batch": [0.625, 5],
  "gemini-flash-latest@batch": [0.15, 1.25],
};
// Anthropic prompt-cache multipliers on the INPUT rate: cache reads bill ~0.1x,
// 5-min cache writes ~1.25x. tokens_in is the TOTAL (fresh + cache read + cache
// write), so fresh input = tokens_in − cacheRead − cacheWrite. Rows predating the
// cache-token columns (2026-07-09) have null cache counts → priced as all-fresh
// (the old behaviour), which OVER-states cost when caching was actually active.
// Cache-read multiplier is provider-specific: Anthropic prompt-cache reads bill
// ~0.1x the input rate; Gemini implicit context-cache reads bill ~0.25x. Both
// classes are logged into cache_read_tokens (Claude cache_read_input_tokens /
// Gemini cachedContentTokenCount), so price them by model. cache_write only
// applies to Anthropic (~1.25x); Gemini implicit caching has no write charge.
const CACHE_WRITE_MULT = 1.25;
function cacheReadMult(model) {
  return String(model ?? "").startsWith("gemini") ? 0.25 : 0.1;
}
function estimateUsd(model, tokensIn, tokensOut, cacheRead = 0, cacheWrite = 0, thinking = 0) {
  const [ri, ro] = MODEL_RATES[model ?? ""] ?? [0, 0];
  const cr = cacheRead ?? 0;
  const cw = cacheWrite ?? 0;
  const freshIn = Math.max(0, (tokensIn ?? 0) - cr - cw);
  return (
    (freshIn / 1e6) * ri +
    (cr / 1e6) * ri * cacheReadMult(model) +
    (cw / 1e6) * ri * CACHE_WRITE_MULT +
    ((tokensOut ?? 0) / 1e6) * ro +
    // Gemini thinking tokens bill at the OUTPUT rate (thoughtsTokenCount is not
    // part of tokens_out). Null for non-thinking calls → adds nothing.
    ((thinking ?? 0) / 1e6) * ro
  );
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  let days = 14;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days") {
      const v = Number(argv[i + 1]);
      if (!Number.isFinite(v) || v <= 0) {
        console.error(`[llm-cost-report] invalid --days value: ${argv[i + 1]}`);
        process.exit(1);
      }
      days = v;
      i++;
    }
  }
  return { days };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Paging: PostgREST server-side aggregates are off by default on most stacks,
// so we page raw rows and aggregate client-side. Cap to keep memory bounded;
// if we hit the cap we LOG that the report is based on a sample, not the full
// window (figures would then be an UNDER-count).
const PAGE = 1000;
const MAX_ROWS = 500_000;

function fail(msg) {
  console.error(`\n[llm-cost-report] ${msg}\n`);
  process.exit(1);
}

async function fetchPage(sinceIso, from, to) {
  const cols = "operation,model,tokens_in,tokens_out,cache_read_tokens,cache_write_tokens,thinking_tokens,latency_ms,status,ts";
  const url =
    `${SB}/rest/v1/llm_calls` +
    `?select=${cols}` +
    `&ts=gte.${encodeURIComponent(sinceIso)}` +
    `&order=ts.desc`;
  let res;
  try {
    res = await fetch(url, {
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        Range: `${from}-${to}`,
        "Range-Unit": "items",
      },
    });
  } catch (e) {
    fail(
      `could not reach Supabase at ${SB} — ${e?.message ?? e}.\n` +
        `  Check SUPABASE_URL is reachable from here (prod PostgREST/Kong gateway).`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    fail(
      `auth rejected (HTTP ${res.status}) by PostgREST.\n` +
        `  SUPABASE_SERVICE_ROLE_KEY is missing, wrong, or expired.\n` +
        `  Provide a valid service-role JWT (see .env / .env.example) and re-run:\n` +
        `    node --env-file=.env scripts/llm-cost-report.mjs`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    fail(`PostgREST returned HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

function fmtInt(n) {
  return Math.round(n).toLocaleString("en-US");
}
function fmtUsd(n) {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}
function padL(s, w) {
  s = String(s);
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

function printTable(title, keyLabel, rows) {
  console.log(`\n=== ${title} ===`);
  // cache% = cache_read_tokens / tokens_in per row group — the per-model /
  // per-op prefix-cache hit rate (the global figure hides Pro's rate behind
  // QA-flash and first-call misses). think = thinking tokens (billed as output).
  const header =
    pad(keyLabel, 26) +
    padL("count", 9) +
    padL("tok_in", 14) +
    padL("cache%", 8) +
    padL("tok_out", 12) +
    padL("think", 12) +
    padL("avg_ms", 10) +
    padL("est_USD", 12);
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of rows) {
    console.log(
      pad(r.key ?? "(null)", 26) +
        padL(fmtInt(r.count), 9) +
        padL(fmtInt(r.tokensIn), 14) +
        padL(r.tokensIn ? `${((r.cacheRead / r.tokensIn) * 100).toFixed(1)}%` : "-", 8) +
        padL(fmtInt(r.tokensOut), 12) +
        padL(r.thinking ? fmtInt(r.thinking) : "-", 12) +
        padL(r.count ? fmtInt(r.latencySum / r.count) : "-", 10) +
        padL(fmtUsd(r.usd), 12),
    );
  }
}

async function main() {
  const { days } = parseArgs(process.argv.slice(2));

  if (!SB || !KEY) {
    fail(
      `missing credentials.\n` +
        `  Need SUPABASE_URL${!SB ? " (MISSING)" : ""} and ` +
        `SUPABASE_SERVICE_ROLE_KEY${!KEY ? " (MISSING)" : ""}.\n` +
        `  Fix: copy .env.example → .env, fill in the prod values, then run:\n` +
        `    node --env-file=.env scripts/llm-cost-report.mjs --days ${days}`,
    );
  }

  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  console.log(
    `[llm-cost-report] window: last ${days} day(s) (ts >= ${sinceIso})\n` +
      `[llm-cost-report] source: ${SB}/rest/v1/llm_calls (service role)`,
  );

  // ---- page rows ----------------------------------------------------------
  const rows = [];
  let sampled = false;
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const to = Math.min(from + PAGE - 1, MAX_ROWS - 1);
    const page = await fetchPage(sinceIso, from, to);
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE) break; // last page
    if (from + PAGE >= MAX_ROWS) {
      sampled = true;
      break;
    }
  }

  if (rows.length === 0) {
    console.log(
      `\n[llm-cost-report] no llm_calls rows in the last ${days} day(s). ` +
        `Nothing to report.\n`,
    );
    return;
  }
  if (sampled) {
    console.warn(
      `\n[llm-cost-report] WARNING: hit the ${fmtInt(MAX_ROWS)}-row cap — figures ` +
        `below are a SAMPLE (most recent rows) and UNDER-count the true window.`,
    );
  }

  // ---- aggregate ----------------------------------------------------------
  const byOp = new Map();
  const byModel = new Map();
  const distinctOps = new Set();
  let gCount = 0,
    gTokIn = 0,
    gTokOut = 0,
    gCacheRead = 0,
    gCacheReadClaude = 0,
    gCacheReadGemini = 0,
    gCacheWrite = 0,
    gLatSum = 0,
    gLatN = 0,
    gUsd = 0;

  function bump(map, key, r, usd, lat) {
    let e = map.get(key);
    if (!e) {
      e = { key, count: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, thinking: 0, latencySum: 0, usd: 0 };
      map.set(key, e);
    }
    e.count++;
    e.tokensIn += r.tokens_in ?? 0;
    e.tokensOut += r.tokens_out ?? 0;
    e.cacheRead += r.cache_read_tokens ?? 0;
    e.thinking += r.thinking_tokens ?? 0;
    if (lat != null) e.latencySum += lat;
    e.usd += usd;
  }

  for (const r of rows) {
    const tin = r.tokens_in ?? 0;
    const tout = r.tokens_out ?? 0;
    const cr = r.cache_read_tokens ?? 0;
    const cw = r.cache_write_tokens ?? 0;
    const th = r.thinking_tokens ?? 0;
    const usd = estimateUsd(r.model, tin, tout, cr, cw, th);
    const lat = typeof r.latency_ms === "number" ? r.latency_ms : null;
    const op = r.operation ?? "(null)";
    const model = r.model ?? "(null)";
    distinctOps.add(op);
    // latencySum on the op/model rows uses only rows that have latency; but for
    // the printed avg we divide by count. To keep avg honest, accumulate
    // latency into latencySum only when present and divide by count — matches
    // "avg over all calls" (missing latency counts as 0). Good enough for a
    // cost/latency triage report.
    bump(byOp, op, r, usd, lat);
    bump(byModel, model, r, usd, lat);
    gCount++;
    gTokIn += tin;
    gTokOut += tout;
    gCacheRead += cr;
    if (String(model).startsWith("gemini")) gCacheReadGemini += cr;
    else gCacheReadClaude += cr;
    gCacheWrite += cw;
    if (lat != null) {
      gLatSum += lat;
      gLatN++;
    }
    gUsd += usd;
  }

  const opRows = [...byOp.values()].sort((a, b) => b.usd - a.usd);
  const modelRows = [...byModel.values()].sort((a, b) => b.usd - a.usd);

  printTable(`By operation (last ${days}d, sorted by est USD desc)`, "operation", opRows);
  printTable(`By model (last ${days}d, sorted by est USD desc)`, "model", modelRows);

  // ---- grand totals + projection -----------------------------------------
  const perDay = gUsd / days;
  console.log(`\n=== Grand totals (last ${days}d) ===`);
  console.log(`  calls        : ${fmtInt(gCount)}`);
  console.log(`  tokens_in    : ${fmtInt(gTokIn)}`);
  console.log(`  tokens_out   : ${fmtInt(gTokOut)}`);
  console.log(`  avg latency  : ${gLatN ? fmtInt(gLatSum / gLatN) + " ms" : "-"}`);
  console.log(`  est USD      : ${fmtUsd(gUsd)}`);
  console.log(`  est USD/day  : ${fmtUsd(perDay)}`);
  console.log(`  proj 30-day  : ${fmtUsd(perDay * 30)}`);

  // ---- prompt-cache summary (Claude + Gemini) -----------------------------
  // cacheRead+cacheWrite are a subset of tokens_in. A high read share = caching
  // is landing; near-zero on a JEL/chat-heavy window = the breakpoints aren't
  // hitting (Claude cache_control drift / >5-min TTL) or, for Gemini, the shared
  // prefix isn't repeating. Claude reads bill 0.1x input, Gemini implicit reads 0.25x.
  const cachedIn = gCacheRead + gCacheWrite;
  if (cachedIn > 0) {
    const readShare = gTokIn > 0 ? (gCacheRead / gTokIn) * 100 : 0;
    // What the cache SAVED vs. pricing every cached-read token as fresh input,
    // per provider at its own input rate + read multiplier.
    const sonnetIn = MODEL_RATES["claude-sonnet-4-6"][0];
    const geminiIn = MODEL_RATES["gemini-flash-latest"][0];
    const savedUsd =
      (gCacheReadClaude / 1e6) * sonnetIn * (1 - cacheReadMult("claude-sonnet-4-6")) +
      (gCacheReadGemini / 1e6) * geminiIn * (1 - cacheReadMult("gemini-flash-latest"));
    console.log(`\n=== Prompt cache (Claude + Gemini) ===`);
    console.log(`  cache_read   : ${fmtInt(gCacheRead)} tokens (${readShare.toFixed(1)}% of tokens_in)`);
    console.log(`     Claude     : ${fmtInt(gCacheReadClaude)} tokens (billed 0.1x input)`);
    console.log(`     Gemini     : ${fmtInt(gCacheReadGemini)} tokens (billed 0.25x input, implicit context cache)`);
    console.log(`  cache_write  : ${fmtInt(gCacheWrite)} tokens — Claude only, billed ${CACHE_WRITE_MULT}x`);
    console.log(`  est saved    : ${fmtUsd(savedUsd)} vs. no cache`);
  } else {
    console.log(`\n=== Prompt cache (Claude + Gemini) ===`);
    console.log(`  no cache tokens in this window — no BYOK-Claude calls and no Gemini`);
    console.log(`  implicit-cache hits, or the cache-token columns (added 2026-07-09)`);
    console.log(`  predate these rows.`);
  }

  // ---- distinct operations ------------------------------------------------
  console.log(`\n=== Distinct operations seen (${distinctOps.size}) ===`);
  console.log("  " + [...distinctOps].sort().join(", "));

  // ---- coverage caveat ----------------------------------------------------
  if (!distinctOps.has("band_judge")) {
    console.log(`\n=== Coverage caveat: RB_JUDGE_BAND cross-encoder ===`);
    console.log(
      "  No 'band_judge' rows in this window. crossEncoder.ts only started logging\n" +
        "  the band judge on 2026-07-09 — if this window predates that deploy (or\n" +
        "  RB_JUDGE_BAND is off), the judge's per-search Gemini cost is NOT included\n" +
        "  above. Any gemini-2.5-flash rows are from OTHER logged operations\n" +
        "  (gemini_synthesis / chat / JEL section drafting), not the band judge.\n",
    );
  }
}

main().catch((e) => {
  fail(`unexpected failure: ${e?.stack ?? e?.message ?? e}`);
});
