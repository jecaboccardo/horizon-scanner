// server-deno/server.ts
//
// Plain Deno self-hosted runner for the Horizon Scanner api function.
//
// Imports the existing Supabase Edge Function handler from
// supabase/functions/api/index.ts and serves it on a long-running Deno HTTP
// server. The same code path that runs on Supabase cloud edge functions runs
// here under our own Deno binary — no eszip bundling, no vendor lock-in.
//
// Replaces the previous Node.js + tsx + Express approach which
// crashed with ERR_UNSUPPORTED_ESM_URL_SCHEME on `npm:` specifiers.
//
// Run as systemd service `deno-api.service` (see /etc/systemd/system/).
//
// Required env (loaded from /opt/horizon-scanner/repo/.env via --env-file):
//   SUPABASE_URL                  override to http://localhost:8000 in prod
//                                 (NAT loopback: public IP unreachable from
//                                 inside the LXC)
//   SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_ROLE_KEY
//   GEMINI_API_KEY, GEMINI_MODEL
//   SEMANTIC_SCHOLAR_API_KEY, EXA_API_KEY, OPENALEX_API_KEY, OPENALEX_EMAIL
//   GROQ_API_KEY, GROK_API_KEY, OPENAI_API_KEY, NOMIC_API_KEY
//
// Optional env:
//   DENO_API_PORT                 default 3002

import { handler } from "../supabase/functions/api/index.ts";
import { warmJournalRankings } from "../supabase/functions/_shared/journalRankings.ts";

const PORT = parseInt(Deno.env.get("DENO_API_PORT") || "3002", 10);
const HOST = "0.0.0.0";

console.log(`[deno-api] starting ${HOST}:${PORT}`);
console.log(`[deno-api] SUPABASE_URL=${Deno.env.get("SUPABASE_URL")}`);
console.log(`[deno-api] hasGeminiKey=${!!Deno.env.get("GEMINI_API_KEY")}`);
console.log(`[deno-api] hasOpenAIKey=${!!Deno.env.get("OPENAI_API_KEY")}`);

// Pre-warm the journal-rankings cache so the first search after a restart
// doesn't pay the ~8s cold-load tax. Non-blocking — Deno.serve starts
// accepting connections immediately; if the warm-up isn't done by the time
// the first search lands, `lookupJournalRankings` will fall through to the
// same await on the in-flight load promise (lazy init still works).
const _warmStart = Date.now();
void warmJournalRankings().then(() => {
  console.log(`[deno-api] journal-rankings warmed in ${Date.now() - _warmStart}ms`);
}).catch((err) => {
  console.error("[deno-api] journal-rankings warm failed:", (err as Error).message);
});

// Safety net: a rejected promise nobody awaited (e.g. a detached background job
// throwing outside its own try/catch) must not take down the API process — one
// crash kills every concurrent user's stream and paper job. Log and continue;
// the startup watchdog in api/index.ts resets orphaned jel_papers rows after a
// real restart, and each fire-and-forget call site has its own .catch.
globalThis.addEventListener("unhandledrejection", (e) => {
  console.error("[deno-api] unhandled rejection (recovered):", (e as PromiseRejectionEvent).reason);
  e.preventDefault();
});

Deno.serve({ port: PORT, hostname: HOST }, async (req) => {
  try {
    return await handler(req);
  } catch (e) {
    console.error("[deno-api] error:", e);
    // Generic body only — raw messages can leak internals (see api handler).
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
