// deno-lint-ignore-file no-explicit-any
/**
 * supabase/functions/api/index.ts
 *
 * Single API handler for all Horizon Scanner routes.
 * Runs in the self-hosted Deno API runtime and remains Edge-compatible.
 */

import { handleCors, json, sseEvent, sseResponse, startSseHeartbeat } from "../_shared/cors.ts";
import { authenticateRequest, hashPluginKey } from "../_shared/auth.ts";
import { validatePayload } from "../_shared/routing.ts";
import { adminClient } from "../_shared/supabase.ts";
import { planSearchIntent, retrieveWorks, VALID_CHANNEL_IDS } from "../_shared/retrieval.ts";
// Classifier (LLM judge / trained RF / query-facet decomposition for classification)
// removed 2026-06-17 — relevance-first redesign. Membership = cosine relevance floor.
import { createEmbeddingClient } from "../_shared/embeddingClient.ts";
import { createBriefFromRun, createStreamingBriefFromRun } from "../_shared/synthesis.ts";
import { segmentWorks } from "../_shared/topicalitySegmenter.ts";
import { qwenGate } from "../_shared/qwenGate.ts";
import { createGeminiClient } from "../_shared/geminiClient.ts";
import { resolveSynthClientForUser, ProviderCallError, resolveProviderConfig, synthCtxStore, normalizeProviderInput, callSynthProvider } from "../_shared/synthesisProvider.ts";
import { encryptSecret } from "../_shared/secretBox.ts";
import { DEFAULT_GEMINI_MODEL } from "../_shared/llmConfig.ts";
import { verifyBriefSections, verifyChatAnswer } from "../_shared/verifier.ts";
import { normalizeAuditQueryKey, runRetrievalAudit } from "../_shared/retrievalAudit.ts";
import { runLearningAgent } from "../_shared/learningAgent.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";
import { fetchSignals } from "../_shared/signals.ts";
import { fetchFollowSignalsRss, type FollowSignalSource } from "../_shared/rssSignals.ts";
import { runJelPaperJob, runJelPaperRevision, JEL_BATCH_CONFIG } from "../_shared/jelPaperPipeline.ts";
import { lookupBatch } from "../_shared/journalRankings.ts";
import { generateClarification, generateOutlinePreview } from "../_shared/paperPlanEngine.ts";
import { resolveUpload, isAlreadyInPlan } from "../_shared/uploadIngest.ts";
import { logUsageEvent } from "../_shared/telemetry.ts";
import { runDeepScan } from "../_shared/deepScan.ts";
import { planQuery as runCreativePlan, groundPlan, selectAdds, rescoreByTrueQueryCosine, PLANNER_REL_THRESHOLD } from "../_shared/creativePlanner.ts";
import { buildJelGenerationSpec, JEL_SPEC_VERSION } from "../_shared/jelGenerationSpec.ts";
import { initServerSinks, captureServerException } from "../_shared/sinks.ts";

const geminiClient = createGeminiClient();

// Phase 3 visibility: log which external sinks are active at boot (no-op
// without keys). Safe to call once at module load.
initServerSinks();

/**
 * Run a probe with an individual timeout. Resolves to 'up' if fn completes
 * truthy within ms, 'down' on error/timeout/falsy. Never throws, never hangs
 * the health endpoint.
 */
async function probe(fn: () => Promise<boolean>, ms: number): Promise<"up" | "down"> {
  try {
    const result = await Promise.race([
      fn(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
    ]);
    return result ? "up" : "down";
  } catch {
    return "down";
  }
}

function readEnvVar(key: string): string | undefined {
  return (typeof Deno !== "undefined" ? Deno.env.get(key) : (globalThis as any).process?.env?.[key]) ?? undefined;
}
// Admin status is set server-side via Supabase Auth app_metadata.is_admin=true.
// Do not hardcode admin emails in source — set the flag via the Supabase Auth admin API.

// ---------------------------------------------------------------------------
// Synthesis-usage helpers (USD cost estimation + email resolution)
// ---------------------------------------------------------------------------

// Approximate USD per 1M tokens (input rate, output rate).
// Labelled as "estimated" in all surfaces — not billed totals.
const MODEL_RATES: Record<string, [number, number]> = {
  "claude-opus-4-8": [15, 75],
  "claude-sonnet-4-6": [3, 15],
  "gemini-2.5-flash": [0.30, 2.50], // legacy rows (model retired 2026-07-09)
  "gemini-flash-latest": [0.30, 2.50], // current default — same Flash pricing
  // Gemini 2.5 Pro low tier (prompts <=200k). Thinking tokens bill as output.
  "gemini-2.5-pro": [1.25, 10],
  "gemini-pro-latest": [1.25, 10],
  // Batch Mode (logged with @batch suffix) bills at 50% of list.
  "gemini-pro-latest@batch": [0.625, 5],
  "gemini-flash-latest@batch": [0.15, 1.25],
};
function estimateUsd(model: string | null, tokensIn: number, tokensOut: number): number {
  const [ri, ro] = MODEL_RATES[model ?? ""] ?? [0, 0];
  return (tokensIn / 1e6) * ri + (tokensOut / 1e6) * ro;
}

// Resolve a list of user-ids → email using auth.admin (same source as synthesis-users
// and synthesis-grants email lookups). Returns a Map; tolerates per-id failures.
async function resolveEmailsByIds(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  try {
    const { data: list } = await adminClient.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const byId = new Map<string, string>(
      (list?.users ?? []).map((u: any) => [u.id as string, u.email as string])
    );
    return new Map(ids.map((id) => [id, byId.get(id) ?? id]));
  } catch {
    return new Map(ids.map((id) => [id, id]));
  }
}

// ---------------------------------------------------------------------------
// Row mappers (snake_case DB → camelCase frontend)
// ---------------------------------------------------------------------------

function mapSearchRun(row: any) {
  if (!row) return null;
  return {
    id: row.id, tenantId: row.user_id, query: row.query, filters: row.filters || {},
    createdAt: row.created_at, intent: row.intent || {},
    candidateWorkIds: row.candidate_work_ids || [], evidenceWorkIds: row.evidence_work_ids || [],
    signalWorkIds: row.signal_work_ids || [],
    coverage: row.coverage || { universeCount: 0, retrievedCount: 0, admissibleCount: 0, evidenceCount: 0, signalCount: 0 },
    retrievalNotes: row.retrieval_notes || [],
    // Wave 2 (2026-05-07): per-paper Direct/Indirect classification + the
    // facets used to derive it. Both null on legacy rows.
    evidenceClassification: row.evidence_classification ?? null,
    queryFacets: row.query_facets ?? null,
    // Channel-of-origin provenance: workId -> channel ids that surfaced the
    // paper. Additive telemetry; null on legacy rows (frontend falls back to
    // the deterministic tagChannels recompute).
    workChannels: row.work_channels ?? null,
    // Topicality segmentation: workId -> "core"|"context"|"off" (+ "_core" concept
    // string). Recall-safe display signal; null on legacy rows. Never gates retrieval.
    workSegments: row.work_segments ?? null,
    // Load-more availability: true when extended evidence was stored at search time.
    hasMoreEvidence: Array.isArray(row.extended_evidence_work_ids) && row.extended_evidence_work_ids.length > 0,
    extendedEvidenceCount: Array.isArray(row.extended_evidence_work_ids) ? row.extended_evidence_work_ids.length : 0,
  };
}

function mapBrief(row: any) {
  if (!row) return null;
  return {
    id: row.id, tenantId: row.user_id, searchRunId: row.search_run_id, query: row.query,
    status: row.status, sections: row.sections || {}, auditTrace: row.audit_trace || {},
    createdAt: row.created_at, sharePath: row.share_path || "",
  };
}

function mapSubscription(row: any) {
  if (!row) return null;
  return {
    id: row.id, tenantId: row.user_id, type: row.type, label: row.label,
    cadence: row.cadence, query: row.query, authorId: row.author_id, topic: row.topic,
    createdAt: row.created_at,
  };
}

function mapFeedItem(row: any) {
  if (!row) return null;
  return {
    id: row.id, tenantId: row.user_id, kind: row.kind, title: row.title,
    reason: row.reason, linkedEntityId: row.linked_entity_id, createdAt: row.created_at,
  };
}

function mapFeedback(row: any) {
  if (!row) return null;
  return {
    id: row.id, tenantId: row.user_id, briefId: row.brief_id, workId: row.work_id,
    type: row.type, reason: row.reason, createdAt: row.created_at,
  };
}

function mapSource(row: any) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, sourceType: row.source_type, credibilityTier: row.credibility_tier,
    coverageType: row.coverage_type, licenseAccess: row.license_access, allowedUse: row.allowed_use,
    homepage: row.homepage,
  };
}

// Coerce any value to a string[]. A `works` row (or a live-retrieved paper) can carry
// authors/geography/fields_of_study as a JSON-encoded STRING (e.g. '["A","B"]'); `x || []`
// passes that string straight through, and a string later crashes `x.slice(...).join(...)`
// in the frontend (String.slice returns a string, which has no .join). Always normalise.
function toArr(v: any): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return [];
    if (t.startsWith("[")) { try { const p = JSON.parse(t); return Array.isArray(p) ? p : [t]; } catch { return [t]; } }
    return [t];
  }
  return [];
}

function mapWork(row: any) {
  if (!row) return null;
  return {
    id: row.id, title: row.title, canonicalDoi: row.canonical_doi, year: row.year,
    abstract: row.abstract, citationCount: row.citation_count, authors: toArr(row.authors),
    // 2026-05-21: `geography` was being dropped here — DB had it, query
    // selected it, but it never reached the frontend → empty Geography
    // column in every export. Pass through as an array (the column is a
    // text[] in Postgres so it arrives as an array already).
    geography: toArr(row.geography),
    publicationDate: row.publication_date, isOpenAccess: row.is_open_access,
    openAccessPdfUrl: row.open_access_pdf_url, fieldsOfStudy: toArr(row.fields_of_study),
    url: row.url, source: row.source, venue: row.venue,
    smsLevel: row.sms_level, methodologyDesign: row.methodology_design,
    causalStrength: row.causal_strength, absRating: row.abs_rating,
    repecRank: row.repec_rank, repecPercentile: row.repec_percentile,
    publicationType: row.publication_type ?? null,
    publicationTypeMethod: row.publication_type_method ?? null,
    publicationTypeConfidence: row.publication_type_confidence ?? null,
    sourceFamily: row.source_family ?? null,
    venueKind: row.venue_kind ?? null,
    excluded: row.excluded ?? false, starred: row.starred ?? false, smsRationale: row.sms_rationale ?? null,
    abstractBackfill: row.raw_data?.abstract_backfill ?? null,
    journalMatchInfo: row.journal_match_info ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function mapDomainWeight(row: any) {
  if (!row) return null;
  return {
    id: row.id, userId: row.user_id, domain: row.domain, alpha: row.alpha,
    betaParam: row.beta_param, weight: row.weight, signalCount: row.signal_count,
    updatedAt: row.updated_at,
  };
}

function mapWeightProposal(row: any) {
  if (!row) return null;
  return {
    id: row.id, userId: row.user_id, domain: row.domain,
    currentWeight: row.current_weight, proposedWeight: row.proposed_weight,
    explanation: row.explanation, signalCount: row.signal_count, driftPct: row.drift_pct,
    status: row.status, createdAt: row.created_at, reviewedAt: row.reviewed_at,
  };
}

function mapWeightAlert(row: any) {
  if (!row) return null;
  return {
    id: row.id, alertType: row.alert_type, message: row.message,
    totalDriftPct: row.total_drift_pct, createdAt: row.created_at, resolvedAt: row.resolved_at,
  };
}

function mapRetrievalAudit(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.user_id,
    searchRunId: row.search_run_id,
    query: row.query,
    verdict: row.verdict,
    confidence: Number(row.confidence ?? 0),
    expectedEvidence: row.expected_evidence || [],
    tableDiagnostics: row.table_diagnostics || {},
    recommendedActions: row.recommended_actions || [],
    auditMode: row.audit_mode || "corpus",
    externalDiagnostics: row.external_diagnostics || {},
    auditVersion: row.audit_version,
    createdAt: row.created_at,
  };
}

function mapChatMessage(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    briefId: row.brief_id,
    role: row.role,
    content: row.content,
    citations: row.citations || [],
    createdAt: row.created_at,
  };
}

function mapJelPaper(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    searchRunId: row.search_run_id,
    briefId: row.brief_id ?? null,
    status: row.status,
    query: row.query,
    outline: row.outline ?? null,
    sections: row.sections ?? [],
    bibliography: row.bibliography ?? [],
    wordCount: row.word_count ?? null,
    citationCount: row.citation_count ?? null,
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? null,
    plan: row.plan ?? null,
    regenerationsUsed: row.regenerations_used ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Helper: fetch works by ID in batches.
//
// Supabase's .in("id", [...]) URL-encodes every ID into the query string. With
// large arrays of long DOI-style IDs (~40 chars each), the URL crosses the
// PostgREST 8KB limit and fails with "URI too long". We chunk the lookup so
// each batch stays well under the limit, and we send batches in parallel.
// ---------------------------------------------------------------------------
async function fetchWorksByIds(
  client: any,
  ids: string[],
  batchSize = 80,
  selectCols = "*",
): Promise<any[]> {
  if (!ids || ids.length === 0) return [];
  const unique = [...new Set(ids)];
  if (unique.length <= batchSize) {
    const { data, error } = await client.from("works").select(selectCols).in("id", unique);
    if (error) {
      console.error("[works-fetch] single-batch error:", error.message);
      return [];
    }
    return await attachJournalRankings(data ?? []);
  }
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += batchSize) {
    batches.push(unique.slice(i, i + batchSize));
  }
  const results = await Promise.all(
    batches.map((b) => client.from("works").select(selectCols).in("id", b)),
  );
  const out: any[] = [];
  for (const r of results) {
    if (r.error) {
      console.error("[works-fetch] batch error:", r.error.message);
      continue;
    }
    if (r.data) out.push(...r.data);
  }
  return await attachJournalRankings(out);
}

// ABS / RePEc ratings are derived from the venue name at lookup time and are
// NOT stored as columns on `works`. retrieveWorks() attaches them to the live
// in-memory papers, but every DB read path (snapshot, saved-run reload, brief
// generation from a saved run) re-fetches raw rows that have no abs_rating —
// so the evidence table and exports showed blank ABS for anything but a fresh
// search. Re-run the in-memory ranking lookup here so all read paths match.
// The lookup is a cached in-memory Map (journalRankings.ts), so this is cheap.
async function attachJournalRankings(rows: any[]): Promise<any[]> {
  if (!rows || rows.length === 0) return rows;
  try {
    const rankings = await lookupBatch(
      rows.map((r) => ({ id: r.id, venue: r.venue })),
    );
    for (const r of rows) {
      const jr = rankings.get(r.id);
      if (!jr) continue;
      // Only fill — never clobber a value the row already carries.
      if (r.abs_rating == null) r.abs_rating = jr.absRating;
      if (r.repec_rank == null) r.repec_rank = jr.repecRank;
      if (r.repec_percentile == null) r.repec_percentile = jr.repecPercentile;
      if (r.journal_match_info == null) r.journal_match_info = jr.matchInfo ?? {};
    }
  } catch (err) {
    console.error("[works-fetch] journal ranking attach error:", (err as Error).message);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Startup watchdog — reset ALL jel_papers stuck in 'running' to 'error'.
// JEL generation is fire-and-forget IN THIS PROCESS, so when deno-api restarts
// (every deploy does `systemctl restart deno-api`) EVERY in-flight job is dead —
// regardless of age. The old 30-min threshold let young jobs (killed minutes
// into a run) stay stuck 'running' forever, because the watchdog only fires at
// startup and there's no later restart to catch them. At startup there can be no
// legitimately-running job (the previous process owned them all), so resetting
// every 'running' row is correct. New generations are created AFTER this runs.
// ---------------------------------------------------------------------------
(async () => {
  try {
    // 'queued' rows are equally dead at startup: the insert→mark_running window
    // belongs to the previous process, and a job that died before mark_running
    // (or was killed by a deploy in that window) would otherwise sit 'queued'
    // forever — the watchdog only fires at startup.
    const { error } = await adminClient
      .from("jel_papers")
      .update({ status: "error", error_message: "Generation interrupted by a server restart (deploy) mid-run. Re-generate to retry." })
      .in("status", ["running", "queued"]);
    if (error) console.error("[watchdog] jel_papers reset failed:", error.message);
  } catch (e) {
    console.error("[watchdog] error:", e);
  }
})();

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handler(req: Request): Promise<Response> {
  // CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const url = new URL(req.url);
    // Normalize path: Edge Function URL is /functions/v1/api/snapshot
    // but frontend sends /api/snapshot — handle both by extracting after the function name
    let path = url.pathname;

    // Normalize: strip /functions/v1/api prefix (edge function routing compat)
    path = path.replace(/^\/functions\/v1\/api/, "");
    // Normalize: strip /api prefix if the server is mounted at /api
    if (!path.startsWith("/api")) path = `/api${path}`;
    // Ensure trailing-slash safety
    if (path !== "/api" && path.endsWith("/")) path = path.slice(0, -1);

    // GET /api/_version — public diagnostic, no auth required.
    // Returns a build marker string so we can verify a deploy actually fired.
    // Update BUILD_MARKER below whenever a backend change ships.
    if (req.method === "GET" && (path === "/api/_health" || path === "/_health")) {
      // Phase 3 visibility: individually-timeboxed dependency probes. A failed
      // or slow probe → 'down'; the endpoint never hangs (each probe ≤ its ms).
      const [supabase, llm, gemini] = await Promise.all([
        // Supabase/Kong reachable: a trivial HEAD count against works.
        probe(async () => {
          const { error } = await adminClient.from("works").select("id", { count: "exact", head: true }).limit(1);
          return !error;
        }, 3_000),
        // LiteLLM proxy reachable (models endpoint, Bearer auth).
        probe(async () => {
          const base = (readEnvVar("LLM_BASE_URL") || "https://llm.iotaimpact.com").replace(/\/+$/, "");
          const key = readEnvVar("LLM_API_KEY") || readEnvVar("OPENAI_API_KEY") || "";
          if (!key) return false;
          const res = await fetch(`${base}/v1/models`, {
            headers: { Authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(3_000),
          });
          return res.ok;
        }, 4_000),
        // Gemini configured + key live (cheap models list call).
        probe(async () => {
          const key = readEnvVar("GEMINI_API_KEY");
          if (!key) return false;
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, {
            signal: AbortSignal.timeout(3_000),
          });
          return res.ok;
        }, 4_000),
      ]);

      const status = supabase === "up" ? "ok" : "degraded";
      return json({
        status,
        supabase,
        llm,
        gemini,
        runtime: typeof Deno !== "undefined" ? `deno-${Deno.version?.deno ?? "?"}` : "node",
        time: new Date().toISOString(),
      });
    }

    if (req.method === "GET" && (path === "/api/_version" || path === "/_version")) {
      const BUILD_MARKER = "v165-2026-08-16-deploy-sync";
      const _denoEnv = (k: string) => (typeof Deno !== "undefined" ? Deno.env.get(k) : process.env[k]);
      return json({
        buildMarker: BUILD_MARKER,
        runtime: typeof Deno !== "undefined" ? `deno-${Deno.version?.deno ?? "?"}` : "node",
        // Unified relevance-first reranker (2026-06-15) — relevance(realCosine) ×
        // bounded channel boosts, no gate/floor/drop. Flag activation is verifiable here.
        rerank: {
          // RB_UNIFIED flag retired 2026-07-08 — rerankUnified is the only runtime path.
          rbUnified: true,
          boostProfile: (_denoEnv("RB_BOOST_PROFILE") && ["conservative","moderate","aggressive"].includes(_denoEnv("RB_BOOST_PROFILE")!)) ? _denoEnv("RB_BOOST_PROFILE") : "conservative",
          // Relevance floor = the membership/table-size mechanism (2026-06-17).
          relFloor: parseFloat(_denoEnv("RB_REL_FLOOR") || "0.45"),
          relDelta: parseFloat(_denoEnv("RB_REL_DELTA") || "0.15"),
          relMinKeep: parseInt(_denoEnv("RB_REL_MIN_KEEP") || "8", 10),
          sourceDefaultHardFilter: _denoEnv("RB_NO_SOURCE_DEFAULT") !== "1",
          // Learning-agent loop: per-user approved domain_weights → bounded rerank boost.
          domainWeights: _denoEnv("RB_DOMAIN_WEIGHTS") === "1",
          domainWeightBoost: parseFloat(_denoEnv("RB_DOMAIN_WEIGHT_BOOST") || "0.15"),
          // Positive-feedback loop: liked/saved/added papers → bounded rerank boost on similar queries.
          promoteFeedback: _denoEnv("RB_PROMOTE_FEEDBACK") === "1",
          promoteBoost: parseFloat(_denoEnv("RB_PROMOTE_BOOST") || "0.25"),
        },
        // Marginal-band cross-encoder judge (crossEncoder.ts / retrieval.ts).
        // Exposed here so prod judge config is verifiable without SSH.
        judge: {
          bandJudge: _denoEnv("RB_JUDGE_BAND") === "1",
          backend: _denoEnv("RB_JUDGE_BACKEND") === "qwen" ? "qwen" : "gemini",
          dropOnly: _denoEnv("RB_JUDGE_DROP_ONLY") === "1",
          dropThr: parseInt(_denoEnv("RB_JUDGE_DROP_THR") || "0", 10),
        },
        thresholds: {
          facetFloor: parseFloat(
            (typeof Deno !== "undefined" ? Deno.env.get("FACET_FLOOR") : process.env.FACET_FLOOR) || "0.50",
          ),
          facetGmThreshold: parseFloat(
            (typeof Deno !== "undefined" ? Deno.env.get("FACET_GM_THRESHOLD") : process.env.FACET_GM_THRESHOLD) || "0.55",
          ),
          enableFacetRetrieval: (
            (typeof Deno !== "undefined" ? Deno.env.get("ENABLE_FACET_RETRIEVAL") : process.env.ENABLE_FACET_RETRIEVAL)
          ) !== "false",
        },
        classifier: {
          // Direct/indirect/excluded classifier REMOVED 2026-06-17 (relevance-first
          // redesign). Membership is now the cosine relevance floor (see rerank above).
          removed: true,
        },
        // Gemini Batch Mode for JEL Pro drafting (50% price; 15-min deadline →
        // interactive fallback). Verifiable here without SSH.
        jelBatch: JEL_BATCH_CONFIG,
        // Qwen 2.5-14b concurrency gate (qwenGate.ts, 2026-07-09) — serializes the
        // single-GPU model so bursts queue instead of dogpiling. Live counters.
        qwenGate: qwenGate.stats(),
        time: new Date().toISOString(),
      });
    }

    // GET /api/generation-spec — the JEL writing CONTRACT, served read-only for the
    // Claude Code plugin. Single source of truth: the same jelGenerationSpec.ts blocks
    // the server's buildSectionPrompt spreads into its prompt, so plugin and server
    // can't drift. Unauthenticated (methodology, not tenant data). ?audience=technical|policy.
    if (req.method === "GET" && (path === "/api/generation-spec" || path === "/generation-spec")) {
      const audience = url.searchParams.get("audience") === "policy" ? "policy" : "technical";
      return json({ version: JEL_SPEC_VERSION, audience, spec: buildJelGenerationSpec(audience) });
    }

    // GET /api/monitor-alerts — cron-only pilot alert check. Auth via a shared secret
    // header (MONITOR_CRON_SECRET), NOT an admin JWT, so the cron (VPS systemd timer
    // primary, GitHub Action backup) never depends on an expiring login token. Read-only;
    // returns ONLY the alert list — no query text. Info-level activity alerts carry the
    // roster user's email local-part (owner's explicit choice, 2026-07-15). Handled here,
    // before the auth gate, like _health/_version.
    if (req.method === "GET" && (path === "/api/monitor-alerts" || path === "/monitor-alerts")) {
      const cronSecret = readEnvVar("MONITOR_CRON_SECRET");
      if (!cronSecret || req.headers.get("x-monitor-secret") !== cronSecret) {
        return json({ error: "Unauthorized" }, 401);
      }
      const mon = await import("../_shared/monitor/handlers.ts");
      return json(await mon.alerts(adminClient));
    }

    // Auth gate
    const { user, db, error: authError, viaPluginKey } = await authenticateRequest(req);
    if (authError || !user || !db) {
      return json({ error: authError || "Authentication required" }, 401);
    }

    const userId = (user as any).id;
    const appMeta = (user as any).app_metadata ?? {};
    const userEmail = String((user as any).email || "").trim().toLowerCase();
    const isAdmin = appMeta.is_admin === true;

    // ---------------------------------------------------------------------------
    // Rate limiting — applied before route dispatch, bypassed for admins.
    // Limits are per-user sliding windows; state lives in module memory (single
    // Deno process). A process restart resets counters — acceptable for this
    // deployment model. Adjust limits via env vars if needed.
    // ---------------------------------------------------------------------------
    if (!isAdmin) {
      const RL: Array<[string, string, number, number]> = [
        // [method, exact-path, maxHits, windowMs]
        ["POST", "/api/search-runs",    10,  60_000],   // 10 searches / user / min
        ["POST", "/api/briefs",          5,  60_000],   // 5 briefs    / user / min
        ["GET",  "/api/briefs/stream",   5,  60_000],   // 5 streams   / user / min
        ["POST", "/api/jel-papers",      3, 600_000],   // 3 JEL papers / user / 10 min
      ];
      for (const [method, endpoint, max, windowMs] of RL) {
        if (req.method === method && path === endpoint) {
          const { allowed, retryAfterMs } = checkRateLimit(`${userId}:${endpoint}`, max, windowMs);
          if (!allowed) {
            const retrySec = Math.ceil(retryAfterMs / 1000);
            return json({ error: `Rate limit exceeded. Try again in ${retrySec}s.` }, 429);
          }
          break;
        }
      }
    }

    // Narrow capability: BYOK key/grant management ONLY (not the full admin suite).
    // A byok_admin (e.g. rafaelde) can reach the synthesis-* endpoints but NOT /api/admin/*.
    // byok_admin is sourced from server-set app_metadata (via adminClient.auth.getUser,
    // not a user-decodable JWT claim) — cannot be self-granted by a user.
    const isByokAdmin = isAdmin || appMeta.byok_admin === true;

    // 🔒 Plugin-key scope: a durable plugin key (hsk_...) may ONLY reach the
    // endpoints the Claude Code plugin uses. Everything else (incl. minting more
    // keys) is JWT-only — so a leaked key can't touch the rest of the API.
    if (viaPluginKey) {
      const pluginAllowed =
        (req.method === "POST" && path === "/api/search-runs") ||
        (req.method === "GET" && /^\/api\/search-runs\/[^/]+$/.test(path)) ||
        (req.method === "POST" && path === "/api/paper-plans") ||
        (req.method === "GET" && /^\/api\/paper-plans\/[^/]+(\/bundle)?$/.test(path)) ||
        (req.method === "POST" && /^\/api\/paper-plans\/[^/]+\/ground$/.test(path)) ||
        (req.method === "POST" && /^\/api\/paper-plans\/[^/]+\/uploads$/.test(path)) ||
        // PATCH is allowed but the handler further restricts plugin-key bodies to
        // evidence-curation fields only (curatedWorkIds/discoveredWorkIds/removedWorkIds)
        // so the plugin can persist its curated set without arbitrary plan mutation.
        (req.method === "PATCH" && /^\/api\/paper-plans\/[^/]+$/.test(path)) ||
        // Feedback (like/dislike/save/dismiss on a workId) feeds the learning agent.
        // Resolves to the owning user; the handler only writes a feedback row (never
        // touches `works`), so it is golden-rule-safe and scope-safe for a plugin key.
        (req.method === "POST" && path === "/api/feedback");
      if (!pluginAllowed) {
        return json({ error: "This endpoint is not available with a plugin key" }, 403);
      }
    }

    // POST /api/plugin-keys — mint a durable plugin key for the Claude Code plugin.
    // JWT-only (a plugin key cannot mint more keys — see the allowlist above).
    // The raw key is returned ONCE; only its SHA-256 hash is stored.
    if (req.method === "POST" && path === "/api/plugin-keys") {
      const body = await req.json().catch(() => ({} as any));
      const label = typeof body?.label === "string" ? body.label.slice(0, 80) : null;
      const tenantId = req.headers.get("x-tenant-id") || userId;
      const rand = crypto.getRandomValues(new Uint8Array(32));
      const b64 = btoa(String.fromCharCode(...rand)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const raw = `hsk_${b64}`;
      const token_hash = await hashPluginKey(raw);
      const { data, error } = await adminClient
        .from("plugin_keys")
        .insert({ user_id: userId, tenant_id: tenantId, token_hash, prefix: raw.slice(0, 10), label })
        .select("id, prefix, label, created_at")
        .single();
      if (error || !data) return json({ error: "Could not create plugin key" }, 500);
      // raw key shown exactly once — never retrievable again.
      return json({ id: data.id, key: raw, prefix: data.prefix, label: data.label, createdAt: data.created_at }, 201);
    }

    // GET /api/plugin-keys — list this user's active keys (metadata only, never the raw key).
    if (req.method === "GET" && path === "/api/plugin-keys") {
      const { data } = await adminClient
        .from("plugin_keys")
        .select("id, prefix, label, created_at, last_used_at")
        .eq("user_id", userId)
        .is("revoked_at", null)
        .order("created_at", { ascending: false });
      return json({ keys: data ?? [] });
    }

    // DELETE /api/plugin-keys/:id — revoke a key (scoped to the owner).
    if (req.method === "DELETE" && path.startsWith("/api/plugin-keys/")) {
      const id = path.split("/").pop();
      const { error } = await adminClient
        .from("plugin_keys")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", id)
        .eq("user_id", userId);
      if (error) return json({ error: "Could not revoke key" }, 500);
      return json({ ok: true });
    }

    // POST /api/synthesis-keys — set the admin's BYOK provider key (encrypted at rest).
    // JWT + admin only. One active key per owner: setting a new one revokes the prior.
    if (req.method === "POST" && path === "/api/synthesis-keys") {
      if (!isByokAdmin) return json({ error: "Admin access required" }, 403);
      const body = await req.json().catch(() => ({} as any));
      let norm;
      try { norm = normalizeProviderInput({ provider: body.provider, apiKey: body.apiKey, model: body.model }); }
      catch (e) { return json({ error: (e as Error).message }, 400); }
      // Best-effort live validation: reject a clearly-bad key (provider auth failure)
      // at save time. Transient/non-auth errors do NOT block (the key still saves and
      // is exercised at generation). Costs ~1 token on the admin's own key.
      try {
        await callSynthProvider("", "ping", { expectJson: false, maxTokens: 4, op: "key_validation" },
          { provider: norm.provider, apiKey: norm.apiKey, model: norm.model });
      } catch (e) {
        if (e instanceof ProviderCallError && e.isKeyFailure) {
          return json({ error: "That key was rejected by the provider — check it and try again." }, 400);
        }
        // non-auth error (timeout / 5xx / network) → best-effort, proceed with saving.
      }
      const { ct, iv } = await encryptSecret(norm.apiKey);
      await adminClient.from("synthesis_keys")
        .update({ revoked_at: new Date().toISOString(), active: false })
        .eq("owner_user_id", userId).is("revoked_at", null);
      const { data, error } = await adminClient.from("synthesis_keys")
        .insert({ owner_user_id: userId, provider: norm.provider, model: norm.model, enc_key: ct, enc_iv: iv, label: body.label ?? null })
        .select("id, provider, model, label, active, created_at").single();
      if (error || !data) return json({ error: "Could not save key" }, 500);
      // Re-point the admin's ACTIVE grants to the new key so a key rotation doesn't
      // lock out the existing roster (grants reference a fixed key_id; the prior key
      // row was just revoked above).
      await adminClient.from("synthesis_grants")
        .update({ key_id: data.id })
        .eq("created_by", userId).is("revoked_at", null);
      return json({ id: data.id, provider: data.provider, model: data.model, label: data.label, active: data.active }, 201);
    }

    // GET /api/synthesis-keys — metadata only, NEVER the key.
    if (req.method === "GET" && path === "/api/synthesis-keys") {
      if (!isByokAdmin) return json({ error: "Admin access required" }, 403);
      const { data } = await adminClient.from("synthesis_keys")
        .select("id, provider, model, label, active, created_at, last_used_at, owner_self_use, owner_self_model")
        .eq("owner_user_id", userId).is("revoked_at", null).order("created_at", { ascending: false });
      return json({ keys: data ?? [] });
    }

    // PATCH /api/synthesis-keys/:id — owner self-preference: run their OWN generations
    // on the key or not (owner_self_use), and optionally a different model than the team
    // (owner_self_model, same provider). Does NOT touch the team model or grants.
    if (req.method === "PATCH" && path.startsWith("/api/synthesis-keys/")) {
      if (!isByokAdmin) return json({ error: "Admin access required" }, 403);
      const id = path.split("/").pop();
      const body = await req.json().catch(() => ({}));
      const patch: Record<string, unknown> = {};
      if (typeof body.ownerSelfUse === "boolean") patch.owner_self_use = body.ownerSelfUse;
      if (body.ownerSelfModel === null || typeof body.ownerSelfModel === "string") patch.owner_self_model = body.ownerSelfModel || null;
      if (Object.keys(patch).length === 0) return json({ error: "Nothing to update" }, 400);
      const { error } = await adminClient.from("synthesis_keys")
        .update(patch).eq("id", id).eq("owner_user_id", userId).is("revoked_at", null);
      if (error) return json({ error: "Could not update key preferences" }, 500);
      return json({ ok: true });
    }

    // DELETE /api/synthesis-keys/:id — revoke the key + its active grants.
    if (req.method === "DELETE" && path.startsWith("/api/synthesis-keys/")) {
      if (!isByokAdmin) return json({ error: "Admin access required" }, 403);
      const id = path.split("/").pop();
      await adminClient.from("synthesis_grants")
        .update({ revoked_at: new Date().toISOString() }).eq("key_id", id).is("revoked_at", null);
      const { error } = await adminClient.from("synthesis_keys")
        .update({ revoked_at: new Date().toISOString(), active: false }).eq("id", id).eq("owner_user_id", userId);
      if (error) return json({ error: "Could not revoke key" }, 500);
      return json({ ok: true });
    }

    // GET /api/synthesis-users?q= — search EXISTING registered users by email (admin picker).
    if (req.method === "GET" && path === "/api/synthesis-users") {
      if (!isByokAdmin) return json({ error: "Admin access required" }, 403);
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      if (q.length < 2) return json({ users: [] });
      const { data: list } = await adminClient.auth.admin.listUsers({ page: 1, perPage: 200 });
      const users = (list?.users || [])
        .filter((u: any) => (u.email || "").toLowerCase().includes(q))
        .slice(0, 20)
        .map((u: any) => ({ id: u.id, email: u.email }));
      return json({ users });
    }

    // POST /api/synthesis-grants { keyId, granteeEmail } — grant an EXISTING user.
    if (req.method === "POST" && path === "/api/synthesis-grants") {
      if (!isByokAdmin) return json({ error: "Admin access required" }, 403);
      const body = await req.json().catch(() => ({} as any));
      const email = String(body.granteeEmail || "").trim().toLowerCase();
      if (!body.keyId || !email) return json({ error: "keyId and granteeEmail are required" }, 400);
      const { data: key } = await adminClient.from("synthesis_keys")
        .select("id").eq("id", body.keyId).eq("owner_user_id", userId).is("revoked_at", null).maybeSingle();
      if (!key) return json({ error: "Key not found" }, 404);
      const { data: list } = await adminClient.auth.admin.listUsers({ page: 1, perPage: 200 });
      const match = (list?.users || []).find((u: any) => (u.email || "").toLowerCase() === email);
      if (!match) return json({ error: "No registered user with that email. Ask them to sign up first." }, 404);
      await adminClient.from("synthesis_grants")
        .update({ revoked_at: new Date().toISOString() }).eq("grantee_user_id", match.id).is("revoked_at", null);
      const { data, error } = await adminClient.from("synthesis_grants")
        .insert({ key_id: body.keyId, grantee_user_id: match.id, created_by: userId })
        .select("id, created_at").single();
      if (error || !data) return json({ error: "Could not create grant" }, 500);
      return json({ id: data.id, email, status: "active", createdAt: data.created_at }, 201);
    }

    // GET /api/synthesis-grants?keyId= — list grantees (email + status) created by this admin.
    if (req.method === "GET" && path === "/api/synthesis-grants") {
      if (!isByokAdmin) return json({ error: "Admin access required" }, 403);
      const keyId = url.searchParams.get("keyId");
      let qb = adminClient.from("synthesis_grants")
        .select("id, grantee_user_id, created_at").is("revoked_at", null).eq("created_by", userId);
      if (keyId) qb = qb.eq("key_id", keyId);
      const { data: grants } = await qb.order("created_at", { ascending: false });
      const { data: list } = await adminClient.auth.admin.listUsers({ page: 1, perPage: 200 });
      const byId = new Map((list?.users || []).map((u: any) => [u.id, u.email]));
      const out = (grants || []).map((g: any) => ({ id: g.id, email: byId.get(g.grantee_user_id) || g.grantee_user_id, status: "active", createdAt: g.created_at }));
      return json({ grants: out });
    }

    // DELETE /api/synthesis-grants/:id — revoke a grant (owner-scoped via created_by).
    if (req.method === "DELETE" && path.startsWith("/api/synthesis-grants/")) {
      if (!isByokAdmin) return json({ error: "Admin access required" }, 403);
      const id = path.split("/").pop();
      const { error } = await adminClient.from("synthesis_grants")
        .update({ revoked_at: new Date().toISOString() }).eq("id", id).eq("created_by", userId);
      if (error) return json({ error: "Could not revoke grant" }, 500);
      return json({ ok: true });
    }

    // GET /api/synthesis-access — which synthesis model THIS user's next generation
    // will use + provenance. ANY authenticated user (NOT admin-gated). Powers the
    // pre-generation model badge. Never returns the key itself.
    if (req.method === "GET" && path === "/api/synthesis-access") {
      const emailOf = async (uid: string | null | undefined): Promise<string | null> => {
        if (!uid) return null;
        try { const { data } = await adminClient.auth.admin.getUserById(uid); return (data as any)?.user?.email ?? null; }
        catch { return null; }
      };
      let cfg = null;
      try { cfg = await resolveProviderConfig(adminClient, userId); }
      catch { cfg = null; } // grant-but-key-gone → show default for the badge
      if (cfg) {
        const grantedByEmail = await emailOf(cfg.ownerId);
        return json({
          status: "granted", provider: cfg.provider, model: cfg.model,
          grantedByEmail, ownKey: cfg.ownerId === userId,
        });
      }
      // Not granted → app default. Surface an admin to request access from (the owner
      // of an active key), but NOT the team key's specific model (generic ask).
      let requestFromEmail: string | null = null;
      try {
        const { data: keys } = await adminClient.from("synthesis_keys")
          .select("owner_user_id").is("revoked_at", null).eq("active", true)
          .order("created_at", { ascending: false }).limit(1);
        requestFromEmail = await emailOf(keys?.[0]?.owner_user_id);
      } catch { /* ignore */ }
      return json({ status: "default", defaultModel: DEFAULT_GEMINI_MODEL, requestFromEmail });
    }

    // GET /api/synthesis-usage — owner-scoped per-person/per-date token usage on
    // the caller's active BYOK key. JWT + isByokAdmin only. Read-only; never writes works.
    if (req.method === "GET" && path === "/api/synthesis-usage") {
      if (!isByokAdmin) return json({ error: "Admin access required" }, 403);
      const window = url.searchParams.get("window") === "all" ? "all" : "30d";
      const { data: keyRow } = await adminClient
        .from("synthesis_keys").select("id, created_at")
        .eq("owner_user_id", userId).is("revoked_at", null).eq("active", true)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!keyRow) {
        return json({ window, since: null, overall: { calls: 0, tokensIn: 0, tokensOut: 0, estCostUsd: 0 }, byPerson: [] });
      }
      let q = adminClient.from("llm_calls")
        .select("user_id, model, tokens_in, tokens_out, ts")
        .eq("key_id", (keyRow as any).id);
      if (window === "30d") {
        q = q.gte("ts", new Date(Date.now() - 30 * 864e5).toISOString());
      }
      const { data: rows } = await q;
      const calls = rows || [];
      const byUser = new Map<string, { calls: number; tokensIn: number; tokensOut: number; estCostUsd: number; daily: Map<string, { tokensIn: number; tokensOut: number; calls: number }> }>();
      let oTi = 0, oTo = 0, oCost = 0;
      for (const r of calls) {
        const uid: string = (r as any).user_id || "unknown";
        const ti: number = (r as any).tokens_in || 0;
        const to: number = (r as any).tokens_out || 0;
        const cost = estimateUsd((r as any).model ?? null, ti, to);
        oTi += ti; oTo += to; oCost += cost;
        let u = byUser.get(uid);
        if (!u) { u = { calls: 0, tokensIn: 0, tokensOut: 0, estCostUsd: 0, daily: new Map() }; byUser.set(uid, u); }
        u.calls++; u.tokensIn += ti; u.tokensOut += to; u.estCostUsd += cost;
        const day = String((r as any).ts).slice(0, 10);
        let d = u.daily.get(day);
        if (!d) { d = { tokensIn: 0, tokensOut: 0, calls: 0 }; u.daily.set(day, d); }
        d.tokensIn += ti; d.tokensOut += to; d.calls++;
      }
      const ids = [...byUser.keys()].filter((x) => x !== "unknown");
      const emailById = await resolveEmailsByIds(ids);
      const byPerson = [...byUser.entries()].map(([uid, u]) => ({
        email: emailById.get(uid) || (uid === "unknown" ? "(unattributed)" : uid),
        calls: u.calls, tokensIn: u.tokensIn, tokensOut: u.tokensOut,
        estCostUsd: Number(u.estCostUsd.toFixed(2)),
        daily: [...u.daily.entries()]
          .sort((a, b) => b[0].localeCompare(a[0]))
          .map(([date, d]) => ({ date, tokensIn: d.tokensIn, tokensOut: d.tokensOut, calls: d.calls })),
      })).sort((a, b) => (b.tokensIn + b.tokensOut) - (a.tokensIn + a.tokensOut));
      return json({
        window, since: (keyRow as any).created_at,
        overall: { calls: calls.length, tokensIn: oTi, tokensOut: oTo, estCostUsd: Number(oCost.toFixed(2)) },
        byPerson,
      });
    }

    // ----------------------------------------------------------------
    // POST /api/events
    //
    // First-party usage-events ingest: how frontend-only actions get into
    // usage_events WITH attribution (user_id + tenant_id from the auth'd
    // request). Body: { eventType, status?, latencyMs?, error?, targetType?,
    // targetId?, payload? }. The emit is fire-and-forget via logUsageEvent —
    // this endpoint ALWAYS returns 202, never 500s on a telemetry failure.
    // Raw context (filter values, formats) is stored in OUR Postgres; the
    // PostHog mirror inside logUsageEvent is scrubbed.
    // ----------------------------------------------------------------
    if (req.method === "POST" && path === "/api/events") {
      try {
        const body = await req.json().catch(() => ({} as any));
        const eventType = typeof body?.eventType === "string" ? body.eventType.slice(0, 80) : null;
        if (eventType) {
          logUsageEvent({
            tenantId: req.headers.get("x-tenant-id") || userId,
            userId,
            eventType,
            status: typeof body.status === "string" ? body.status : undefined,
            latencyMs: typeof body.latencyMs === "number" ? body.latencyMs : undefined,
            error: typeof body.error === "string" ? body.error : undefined,
            targetType: typeof body.targetType === "string" ? body.targetType : undefined,
            targetId: typeof body.targetId === "string" ? body.targetId : undefined,
            payload: body.payload && typeof body.payload === "object" ? body.payload : {},
          });
        }
      } catch {
        // Telemetry ingest must never fail the caller. Swallow everything.
      }
      // Always 202 — fire-and-forget, attribution-only contract.
      return json({ accepted: true }, 202);
    }

    // ----------------------------------------------------------------
    // GET /api/_debug/last-search-classification
    //
    // Diagnostic for the per-facet similarity classifier. Loads the most
    // recent search_run for the auth'd user, reads evidence_classification,
    // joins paper titles, and returns the top-30 candidates by GM plus a
    // "near-miss" view: papers that fell just below the relevance gate.
    //
    // Use to calibrate FACET_FLOOR / FACET_GM_THRESHOLD without grepping logs.
    // ----------------------------------------------------------------
    if (req.method === "GET" && path === "/api/_debug/last-search-classification") {
      const { data: run, error: runErr } = await db
        .from("search_runs")
        .select("id, query, created_at, evidence_classification, query_facets, coverage")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      if (runErr || !run) {
        return json({ error: "No recent search_run found", details: runErr?.message }, 404);
      }
      const cls: Record<string, any> = (run.evidence_classification as any) ?? {};
      const ids = Object.keys(cls);
      // Pull titles + key metadata for these papers in one batch.
      const works = await fetchWorksByIds(
        adminClient,
        ids,
        80,
        "id, title, year, venue, sms_level, abs_rating, citation_count",
      );
      const worksById: Record<string, any> = {};
      for (const w of works) worksById[w.id] = w;

      // Read live thresholds from env so the diagnostic always reflects what
      // the running classifier is using.
      const readEnv = (k: string) =>
        typeof Deno !== "undefined" ? Deno.env.get(k) : (globalThis as any).process?.env?.[k];
      const floor = parseFloat(readEnv("FACET_FLOOR") || "0.50");
      const gmTh = parseFloat(readEnv("FACET_GM_THRESHOLD") || "0.55");

      const rows = ids.map((id) => {
        const c = cls[id] ?? {};
        const w = worksById[id] ?? {};
        return {
          id,
          title: w.title ?? "(unknown)",
          year: w.year ?? null,
          venue: w.venue ?? null,
          smsLevel: w.sms_level ?? null,
          absRating: w.abs_rating ?? null,
          citationCount: w.citation_count ?? null,
          classification: c.classification ?? c.evidenceMatch ?? "unknown",
          gmRequired: typeof c.gmRequired === "number" ? c.gmRequired : null,
          facetScores: c.facetScores ?? null,
          geographyMatched: c.geographyMatched ?? null,
          facetsMatched: c.facetsMatched ?? [],
          facetsMissed: c.facetsMissed ?? [],
        };
      });

      // Sort by GM desc; null GM (legacy rows) sink to the bottom.
      rows.sort((a, b) => {
        const ag = a.gmRequired ?? -1;
        const bg = b.gmRequired ?? -1;
        return bg - ag;
      });

      // Bucket distribution
      const dist: Record<string, number> = {};
      for (const r of rows) dist[r.classification] = (dist[r.classification] ?? 0) + 1;

      // Near-miss: papers within ±0.10 of the GM threshold OR within ±0.10 of
      // the floor on any required facet. Useful for "what would tightening do."
      const nearMiss = rows.filter((r) => {
        if (r.gmRequired !== null && Math.abs(r.gmRequired - gmTh) <= 0.10) return true;
        if (r.facetScores) {
          for (const v of Object.values(r.facetScores)) {
            if (typeof v === "number" && Math.abs((v as number) - floor) <= 0.10) return true;
          }
        }
        return false;
      });

      return json({
        searchRunId: run.id,
        query: run.query,
        createdAt: run.created_at,
        thresholds: { facetFloor: floor, facetGmThreshold: gmTh },
        queryFacets: run.query_facets ?? null,
        coverage: run.coverage ?? null,
        distribution: dist,
        totalClassified: rows.length,
        topByGm: rows.slice(0, 30),
        nearMiss: nearMiss.slice(0, 30),
      });
    }

    // ----------------------------------------------------------------
    // GET /api/snapshot
    // ----------------------------------------------------------------
    if (req.method === "GET" && path === "/api/snapshot") {
      const [sourcesR, worksR, searchRunsR, briefsR, subsR, feedR, fbR, jelR] = await Promise.all([
        adminClient.from("sources").select("*").order("name"),
        adminClient.from("works").select("*").order("created_at", { ascending: false }).limit(100),
        db.from("search_runs").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
        db.from("briefs").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
        db.from("subscriptions").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
        db.from("feed").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
        adminClient.from("feedback").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
        db.from("jel_papers").select("id, tenant_id, search_run_id, brief_id, status, query, outline, sections, bibliography, word_count, citation_count, error_message, created_at, completed_at").eq("tenant_id", userId).order("created_at", { ascending: false }).limit(20),
      ]);

      return json({
        tenantId: userId,
        sources: (sourcesR.data || []).map(mapSource),
        works: (await attachJournalRankings(worksR.data || [])).map(mapWork),
        searchRuns: (searchRunsR.data || []).map(mapSearchRun),
        briefs: (briefsR.data || []).map(mapBrief),
        subscriptions: (subsR.data || []).map(mapSubscription),
        feed: (feedR.data || []).map(mapFeedItem),
        feedback: (fbR.data || []).map(mapFeedback),
        jelPapers: (jelR.data || []).map(mapJelPaper),
        generatedAt: new Date().toISOString(),
      });
    }

    // ----------------------------------------------------------------
    // POST /api/search-runs
    // ----------------------------------------------------------------
    if (req.method === "POST" && path === "/api/search-runs") {
      const searchStartedAt = Date.now();
      // deno-lint-ignore no-explicit-any
      const body = await req.json().catch(() => ({} as any)); // malformed body → route validation 400s, not a leaked 500
      if (!body.query || typeof body.query !== "string") {
        return json({ error: "query is required" }, 400);
      }
      // Cap the free-text query so an oversized body can't reach intent
      // planning / embedding (a real query is well under 2k chars).
      const queryErr = validatePayload(body, { query: { type: "string", maxLen: 2000 } });
      if (queryErr) return json({ error: queryErr }, 400);

      const intent = planSearchIntent(body.query, body.filters || {});

      // Wrap retrieval in a hard timeout + try/catch so a stuck upstream
      // (slow Crossref, weird query embedding, etc.) returns a real JSON
      // error instead of letting nginx eventually 502 us. 75s ceiling
      // matches nginx's default proxy_read_timeout (~90s) with margin.
      // Per-request HyDE override — lets eval scripts A/B without env flips.
      // Body fields: { hyde: true|false, hydeThreshold: 0.40, hydeLimit: 200 }.
      // Default is on (since 2026-05-09); body.hyde === false disables for one
      // request without env coordination.
      const hydeOverride = body.hyde === true || body.hyde === false || typeof body.hydeThreshold === "number" || typeof body.hydeLimit === "number"
        ? {
            force: body.hyde === true,
            disable: body.hyde === false,
            threshold: typeof body.hydeThreshold === "number" ? body.hydeThreshold : undefined,
            limit: typeof body.hydeLimit === "number" ? body.hydeLimit : undefined,
          }
        : undefined;

      // Per-request cross-encoder override.
      // Body fields: { crossEncoder: true|false, crossEncoderTopN: 50 }.
      // Flag-gated; default off until eval validates.
      const crossEncoderOverride =
        body.crossEncoder === true ||
        body.crossEncoder === false ||
        typeof body.crossEncoderTopN === "number"
          ? {
              force: body.crossEncoder === true,
              disable: body.crossEncoder === false,
              topN:
                typeof body.crossEncoderTopN === "number"
                  ? body.crossEncoderTopN
                  : undefined,
            }
          : undefined;

      // Per-request facet-retrieval override.
      // Body field: { facetRetrieval: true|false }.
      // Used by eval scripts to A/B-test the multi-vector facet path
      // (decomposeQuery + multi-facet search) without env flips.
      const facetRetrievalOverride =
        body.facetRetrieval === true || body.facetRetrieval === false
          ? {
              force: body.facetRetrieval === true,
              disable: body.facetRetrieval === false,
            }
          : undefined;

      // Per-request LLM-judge classifier override.
      // Body fields: { llmJudge: true|false, llmJudgeCap: 100 }.
      // Used by latency-sweep probes to vary the cap without redeploying.
      const llmJudgeOverride =
        body.llmJudge === true ||
        body.llmJudge === false ||
        typeof body.llmJudgeCap === "number"
          ? {
              force: body.llmJudge === true,
              disable: body.llmJudge === false,
              cap: typeof body.llmJudgeCap === "number" ? body.llmJudgeCap : undefined,
            }
          : undefined;

      // Per-request composite rerank weights override for A/B eval sweeps.
      // Body: { rerankWeights: { similarity, rigor, recency, region, citation, fts } }
      // Any unspecified fields fall back to DEFAULT_RERANK_WEIGHTS.
      const rerankWeightsOverride = body.rerankWeights && typeof body.rerankWeights === "object"
        ? body.rerankWeights as Record<string, number>
        : undefined;

      // Only accept known channel ids (VALID_CHANNEL_IDS) — silently drop any
      // unknown values rather than passing junk into retrieval.
      const channelsOverride = Array.isArray(body.channels)
        ? (body.channels as string[]).filter((c) => (VALID_CHANNEL_IDS as readonly string[]).includes(c))
        : undefined;
      const includeSelectionPool = body.includeSelectionPool === true;

      let retrieved: Awaited<ReturnType<typeof retrieveWorks>>;
      try {
        retrieved = await Promise.race([
          retrieveWorks(body.query, body.filters || {}, { supabaseClient: adminClient, hydeOverride, crossEncoderOverride, facetRetrievalOverride, llmJudgeOverride, rerankWeightsOverride, channelsOverride, userId, includeSelectionPool }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("retrieval-timeout")), 75_000)
          ),
        ]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        // Log the full stack server-side for debugging.
        console.error("[POST /api/search-runs] retrieval failed:", msg);
        if (stack) console.error("[POST /api/search-runs] stack:", stack);
        // Telemetry: capture the failed search with reason (best-effort).
        logUsageEvent({
          tenantId: req.headers.get("x-tenant-id") || userId,
          userId,
          eventType: "search.submitted",
          targetType: "search_run",
          latencyMs: Date.now() - searchStartedAt,
          status: "failed",
          error: msg === "retrieval-timeout" ? "retrieval_timeout" : "retrieval_error",
          payload: { query: body.query, channels: Array.isArray(body.channels) ? body.channels : undefined },
        });
        if (msg === "retrieval-timeout") {
          return json({
            error: "Search took too long. Try a more specific query or fewer filters.",
            code: "retrieval_timeout",
          }, 504);
        }
        return json({
          error: "Search failed. Try rewording the query or simplifying the filters.",
          code: "retrieval_error",
        }, 500);
      }

      // Per-paper classification map. Stores the four-bucket classification
      // (direct-lac / direct-global / indirect / excluded) plus per-facet
      // similarity scores so the frontend can render Match chips and the
      // eval harness can replay threshold sensitivity without re-retrieving.
      const classificationMap: Record<string, {
        classification?: string;
        evidenceMatch: string;
        facetScores?: Record<string, number>;
        gmRequired?: number;
        facetsMatched: string[];
        facetsMissed: string[];
        geographyMatched?: boolean;
        surfacedFromHyde?: boolean;
        hydeSimilarity?: number;
        llmRationale?: string;
        trainedProbs?: number[];
      }> = {};
      const classificationSource = [...(retrieved.candidates ?? []), ...(retrieved.evidence ?? [])];
      for (const w of classificationSource) {
        if (w?.id && w?.evidenceMatch) {
          classificationMap[w.id] = {
            classification: w.classification,
            evidenceMatch: w.evidenceMatch,
            facetScores: w.facetScores,
            gmRequired: w.gmRequired,
            facetsMatched: w.facetsMatched ?? [],
            facetsMissed: w.facetsMissed ?? [],
            geographyMatched: w.geographyMatched,
            surfacedFromHyde: w.surfacedFromHyde === true,
            hydeSimilarity: typeof w.hydeSimilarity === "number" ? w.hydeSimilarity : undefined,
            // Tier-specific audit: only one of these fields is present per
            // paper. llmRationale → LLM judge tier. trainedProbs → trained
            // classifier tier. Neither → facet-cosine tier.
            llmRationale: typeof w.llmRationale === "string" ? w.llmRationale : undefined,
            trainedProbs: Array.isArray(w.trainedProbs) ? w.trainedProbs : undefined,
          };
        }
      }
      const hasClassification = Object.keys(classificationMap).length > 0;

      const { data: row, error: insertError } = await db
        .from("search_runs")
        .insert({
          user_id: userId, query: body.query, filters: body.filters || {}, intent,
          candidate_work_ids: retrieved.candidates.map((w: any) => w.id),
          evidence_work_ids: retrieved.evidence.map((w: any) => w.id),
          extended_evidence_work_ids: (retrieved as any).extended?.map((w: any) => w.id) ?? null,
          signal_work_ids: retrieved.signals.map((w: any) => w.id),
          coverage: retrieved.coverage, retrieval_notes: retrieved.retrievalNotes,
          evidence_classification: hasClassification ? classificationMap : null,
          query_facets: (retrieved as any).facets ?? null,
          // Channel-of-origin provenance (additive). Map of workId -> channel
          // ids (causal/recent/foundational/lac) that actually surfaced the
          // paper. NULL when no paper came from a channel (plain vector/FTS).
          work_channels: (retrieved as any).workChannels ?? null,
          // Cosine summary for the pilot monitor (design spec §6). Read-only signal.
          top_cosine: (retrieved as any).topCosine ?? null,
          mean_cosine: (retrieved as any).meanCosine ?? null,
        })
        .select().single();

      if (insertError) {
        console.error("[POST /api/search-runs] insert error:", insertError);
        return json({ error: "Failed to create search run" }, 500);
      }

      // Embed the retrieved works directly in the response. The /api/snapshot
      // endpoint only returns the 100 most-recent works (perf cap), but a
      // search can pull papers ingested weeks/months ago that are NOT in the
      // most-recent 100. Without this, the frontend's worksById lookup misses
      // those rows and renders Source as "—" + Type as "Other".
      const retrievedWorks = [
        ...(retrieved.candidates ?? []),
        ...(retrieved.evidence ?? []),
        ...(retrieved.signals ?? []),
      ];
      // Deduplicate by id — a paper may appear in both candidates and evidence
      const seen = new Set<string>();
      const dedupedWorks = retrievedWorks.filter((w: any) => {
        if (!w?.id || seen.has(w.id)) return false;
        seen.add(w.id);
        return true;
      });
      // 2026-05-21: the in-memory Paper objects coming out of retrieval are
      // either upsert-source live-API results OR vectorSearch RPC rows.
      // Neither path carries DB-derived columns like citation_count or
      // geography reliably, so the embedded works arrive at the frontend
      // missing those fields. Re-fetch from the DB so worksById has the
      // full row. Trade-off: one extra batched query per search-run.
      const refreshedWorks = await fetchWorksByIds(
        adminClient,
        dedupedWorks.map((w: any) => w.id).filter(Boolean),
      );
      const refreshedById = new Map<string, any>(refreshedWorks.map((r) => [r.id, r]));
      const mergedWorks = dedupedWorks.map((w: any) => {
        const fresh = refreshedById.get(w.id);
        // Merge: DB row wins on every column it owns; in-memory keeps any
        // fields that only retrieval knows (similarity score, facetScores, etc.).
        return fresh ? { ...w, ...fresh } : w;
      });

      const response = json({
        ...mapSearchRun(row),
        works: mergedWorks.map(mapWork),
        // Diagnostic: per-phase retrieval timings (added 2026-05-11). Eval
        // bench reads this; safe to ignore on the frontend.
        perfLog: (retrieved as any).perfLog,
        // Funnel debug: full ranked 200-paper pool before diverse top-100 selection.
        // Only present when request body includes includeSelectionPool:true.
        selectionPool: retrieved.selectionPool,
      }, 201);

      // (Async LLM-judge classification pass REMOVED 2026-06-17 — the
      // direct/indirect/excluded classifier is gone in the relevance-first
      // redesign. Membership is decided by the cosine relevance floor inside
      // retrieveWorks; no post-response classification upgrade runs.)

      // Phase 3 visibility — usage event. Best-effort, non-blocking. Raw query
      // is stored in OUR DB only; scrubForExternal() strips it before PostHog.
      logUsageEvent({
        tenantId: req.headers.get("x-tenant-id") || userId,
        userId,
        eventType: "search.submitted",
        targetType: "search_run",
        targetId: row?.id,
        latencyMs: Date.now() - searchStartedAt,
        status: "completed",
        payload: {
          query: body.query, // stored locally only; scrubbed for external sinks
          channels: Array.isArray(body.channels) ? body.channels : undefined,
          evidenceMatch: body.filters?.evidenceMatch,
          evidenceCount: retrieved.evidence?.length ?? 0,
          candidateCount: retrieved.candidates?.length ?? 0,
          signalCount: retrieved.signals?.length ?? 0,
          searchRunId: row?.id,
        },
      });

      return response;
    }

    // ----------------------------------------------------------------
    // GET /api/signals?query=...&profiles=policy,buzz
    //
    // Off-evidence signals — Exa-backed, two profiles. Never enters the
    // evidence table or synthesis prompt; rendered separately.
    //   policy = whitelisted grey lit + working papers + multilaterals
    //   buzz   = open web, last 30 days
    // Both profiles default OFF on the frontend; user opts in.
    // ----------------------------------------------------------------
    if (req.method === "GET" && path === "/api/signals") {
      const query = url.searchParams.get("query") || "";
      const profilesParam = url.searchParams.get("profiles") || "";
      const profiles = profilesParam.split(",").map((s) => s.trim()).filter(Boolean);
      if (!query.trim()) return json({ error: "query required" }, 400);
      if (profiles.length === 0) {
        return json({ policy: [], buzz: [] });
      }
      const result = await fetchSignals(query, {
        policy: profiles.includes("policy"),
        buzz: profiles.includes("buzz"),
      });
      return json(result);
    }

    // ----------------------------------------------------------------
    // GET /api/search-runs/:id
    // ----------------------------------------------------------------
    // Exact-depth match (/api/search-runs/:id = 4 segments) — startsWith alone
    // shadowed GET .../:id/more-evidence below (id parsed as "more-evidence" →
    // 404 on every "Load more papers" click).
    if (req.method === "GET" && path.startsWith("/api/search-runs/") && path.split("/").length === 4) {
      const id = path.split("/").pop();
      // Plugin keys run on adminClient (bypasses RLS), so the owner filter must
      // be explicit here — without it any valid plugin key + a foreign run UUID
      // read another tenant's run. JWT requests keep pure-RLS semantics
      // (owner or admin) via the user-scoped client.
      let q = db.from("search_runs").select("*").eq("id", id);
      if (viaPluginKey) q = q.eq("user_id", userId);
      const { data: row } = await q.single();
      if (!row) return json({ error: "Search run not found" }, 404);
      return json(mapSearchRun(row));
    }

    // ----------------------------------------------------------------
    // GET /api/search-runs/:id/more-evidence
    //
    // Returns the next batch of ranked papers (51-200) from the already-computed
    // selection pool, stored as extended_evidence_work_ids at search time.
    // No re-retrieval — O(1) DB read + works fetch.
    // ----------------------------------------------------------------
    if (req.method === "GET" && path.startsWith("/api/search-runs/") && path.endsWith("/more-evidence")) {
      const id = path.split("/")[3];
      if (!id) return json({ error: "Search run id required" }, 400);
      const { data: run } = await db.from("search_runs").select("extended_evidence_work_ids").eq("id", id).single();
      if (!run) return json({ error: "Search run not found" }, 404);
      const extIds: string[] = run.extended_evidence_work_ids ?? [];
      if (extIds.length === 0) return json({ works: [], total: 0 });
      // Fetch full work metadata for the extended IDs
      const { data: works } = await db.from("works")
        .select("id,title,abstract,year,citation_count,sms_level,geography,venue,publication_type,authors,canonical_doi,open_access_pdf_url,fields_of_study,url,source,methodology_design,causal_strength,abs_rating,raw_data")
        .in("id", extIds);
      // Preserve ranked order from extIds
      const byId = new Map((works ?? []).map((w: any) => [w.id, w]));
      const ordered = extIds.map((id) => byId.get(id)).filter(Boolean);
      return json({ works: ordered, total: ordered.length });
    }

    // ----------------------------------------------------------------
    // POST /api/search-runs/:id/deep-scan — opt-in second retrieval round.
    //
    // An LLM (Gemini-primary, Qwen-fallback) inspects the query + the run's
    // top-50 evidence titles, names the literatures the first pass MISSED,
    // and emits 2-4 follow-up sub-queries; each runs through the READ-ONLY
    // corpus search (searchLocalCorpus — 🔒 golden rule: never retrieveWorks,
    // never upserts `works`). New papers are returned for the user to opt in
    // to expanding the evidence set via the existing evidenceWorkIdsOverride
    // regenerate path. At most ONE deep scan per run (409 on repeat).
    // ----------------------------------------------------------------
    if (req.method === "POST" && path.startsWith("/api/search-runs/") && path.endsWith("/deep-scan")) {
      const scanStartedAt = Date.now();
      const id = path.split("/")[3];
      if (!id) return json({ error: "Search run id required" }, 400);

      // Tenant scoping mirrors GET /api/search-runs/:id — the user-scoped
      // client (`db`, RLS: user_id = auth.uid()) only sees the caller's runs.
      const { data: run } = await db.from("search_runs").select("*").eq("id", id).single();
      if (!run) return json({ error: "Search run not found" }, 404);

      // Allow at most one deep scan per run. The audit object lives inside the
      // run's `intent` jsonb (the run's planning/audit structure — search_runs
      // has no dedicated audit column and adding one would need DDL).
      if ((run.intent as any)?.deep_scan) {
        return json({ error: "Deep scan already run for this search." }, 409);
      }

      // Top-50 evidence titles, preserved in evidence (table) order.
      // .in() chunks of ≤80 ids — larger chunks hit the PostgREST 8KB
      // URI-too-long limit and silently drop the lookup.
      const evidenceIds: string[] = (run.evidence_work_ids ?? []).slice(0, 50);
      const titleById = new Map<string, string>();
      for (let i = 0; i < evidenceIds.length; i += 80) {
        const { data: rows } = await adminClient
          .from("works")
          .select("id, title")
          .in("id", evidenceIds.slice(i, i + 80));
        for (const r of rows ?? []) titleById.set(r.id, r.title ?? "");
      }
      const evidenceTitles = evidenceIds
        .map((wid) => titleById.get(wid))
        .filter((t): t is string => !!t);

      // Resolve the caller's BYOK provider (null => app-default Gemini).
      let dsCfg = null;
      try { dsCfg = await resolveProviderConfig(adminClient, userId); }
      catch (e) { if (e instanceof ProviderCallError) return json({ error: "Your team's synthesis key is unavailable — contact your admin." }, 503); throw e; }

      // runDeepScan soft-fails internally (returns the empty result) — it
      // never throws, and its only corpus access is read-only.
      const scan = await synthCtxStore.run({ providerCfg: dsCfg, tenantId: userId }, () => runDeepScan({
        query: run.query,
        evidenceTitles,
        supabaseClient: adminClient,
        tenantId: req.headers.get("x-tenant-id") || userId,
      }));

      // Only offer papers NOT already known to this run.
      const known = new Set<string>([
        ...(run.evidence_work_ids ?? []),
        ...(run.candidate_work_ids ?? []),
        ...(run.signal_work_ids ?? []),
      ]);
      const newPapers = scan.newPapers.filter((p: any) => p?.id && !known.has(String(p.id)));
      const newWorkIds = newPapers.map((p: any) => String(p.id));

      // Persist NON-destructively: merge deep_scan into intent (preserving all
      // existing keys) and union 'deepscan' into work_channels per new paper.
      // Existing candidate/evidence/coverage/classification fields are untouched.
      const deepScanAudit = {
        missing: scan.missing,
        subQueries: scan.subQueries,
        newWorkIds,
        model: scan.model,
        at: new Date().toISOString(),
      };
      const mergedChannels: Record<string, string[]> = { ...((run.work_channels as any) ?? {}) };
      for (const wid of newWorkIds) {
        const existing = Array.isArray(mergedChannels[wid]) ? mergedChannels[wid] : [];
        mergedChannels[wid] = existing.includes("deepscan") ? existing : [...existing, "deepscan"];
      }
      const { error: deepScanUpdateError } = await db
        .from("search_runs")
        .update({
          intent: { ...((run.intent as any) ?? {}), deep_scan: deepScanAudit },
          work_channels: mergedChannels,
        })
        .eq("id", id);
      if (deepScanUpdateError) {
        // Soft-fail: the scan itself succeeded — losing the once-per-run
        // marker is the lesser evil vs erroring the feature for the user.
        console.error("[POST /api/search-runs/:id/deep-scan] persist error:", deepScanUpdateError);
      }

      // Trimmed shape for the UI panel (papers come from searchLocalCorpus's
      // mapRow: citationCount is camelCase, sms_level is snake_case).
      const newWorks = newPapers.map((p: any) => ({
        id: String(p.id),
        title: p.title ?? "",
        authors: Array.isArray(p.authors) ? p.authors : [],
        year: p.year ?? null,
        venue: p.venue ?? null,
        similarity: typeof p.similarity === "number" ? p.similarity : null,
        smsLevel: p.sms_level ?? null,
        citationCount: p.citationCount ?? null,
        abstract: typeof p.abstract === "string" ? p.abstract.slice(0, 300) : null,
      }));

      // Telemetry — fire-and-forget (logUsageEvent never blocks or throws;
      // the per-LLM-call rows are logged inside runDeepScan as 'deep_scan').
      logUsageEvent({
        tenantId: req.headers.get("x-tenant-id") || userId,
        userId,
        eventType: "search.deep_scan",
        targetType: "search_run",
        targetId: id,
        latencyMs: Date.now() - scanStartedAt,
        status: scan.model ? "completed" : "degraded",
        payload: {
          query: run.query, // local-only; scrubbed for external sinks
          model: scan.model,
          missingCount: scan.missing.length,
          subQueryCount: scan.subQueries.length,
          newWorkCount: newWorks.length,
          searchRunId: id,
        },
      });

      return json({ missing: scan.missing, subQueries: scan.subQueries, newWorks });
    }

    // ----------------------------------------------------------------
    // DELETE /api/search-runs/:id — hard delete run + all children
    // (briefs, brief_messages, feedback on those briefs, feed items
    // referencing those briefs).
    // ----------------------------------------------------------------
    if (req.method === "DELETE" && path.startsWith("/api/search-runs/")) {
      const id = path.split("/").pop();

      const { data: runRow } = await db.from("search_runs").select("id").eq("id", id).single();
      if (!runRow) return json({ error: "Search run not found" }, 404);

      const { data: briefRows } = await db.from("briefs").select("id").eq("search_run_id", id);
      const briefIds = (briefRows || []).map((b: any) => b.id);

      if (briefIds.length > 0) {
        await db.from("brief_messages").delete().in("brief_id", briefIds);
        await db.from("feedback").delete().in("brief_id", briefIds);
        await db.from("feed").delete().in("linked_entity_id", briefIds);
        await db.from("briefs").delete().in("id", briefIds);
      }

      const { error: deleteError } = await db.from("search_runs").delete().eq("id", id);
      if (deleteError) {
        console.error("[DELETE /api/search-runs/:id] error:", deleteError);
        return json({ error: "Failed to delete search run" }, 500);
      }

      return json({ ok: true, deletedBriefCount: briefIds.length });
    }

    // ----------------------------------------------------------------
    // POLICY-ONLY (2026-06-03): POST /api/briefs/render was removed. It only
    // existed to re-render a brief under a different persona for the persona-
    // swap UI, which is gone now that every brief is the policy register. The
    // language toggle (EN/ES/PT) is handled client-side, not via this route.
    // ----------------------------------------------------------------
    // POST /api/briefs
    // ----------------------------------------------------------------
    if (req.method === "POST" && path === "/api/briefs") {
      const briefStartedAt = Date.now();
      // deno-lint-ignore no-explicit-any
      const body = await req.json().catch(() => ({} as any)); // malformed body → route validation 400s, not a leaked 500
      if (!body.searchRunId) return json({ error: "searchRunId is required" }, 400);
      const lang: 'en' | 'es' | 'pt' = body.lang === 'es' || body.lang === 'pt' ? body.lang : 'en';

      const { data: searchRunRow } = await db.from("search_runs").select("*").eq("id", body.searchRunId).single();
      if (!searchRunRow) return json({ error: "Search run not found" }, 404);

      let searchRun = mapSearchRun(searchRunRow);
      if (!searchRun) return json({ error: "Search run not found" }, 404);
      // Deep-scan papers must never enter the brief evidence table — strip them
      // regardless of how the call was constructed (direct or override).
      const deepScanIds = new Set<string>(
        ((searchRunRow.intent as any)?.deep_scan?.newWorkIds ?? []) as string[]
      );

      // Regenerate-brief flow (2026-05-21): when the user expands the evidence
      // table past the default 50 and asks to regenerate, the frontend sends
      // the explicit list of work IDs they want in the brief. Override the
      // search run's evidenceWorkIds for this call only (we do NOT persist it
      // back to the search_runs row — the brief itself captures the expanded
      // set). The synthesis cap is bumped to match so Gemini sees them all.
      const overrideIds: string[] | undefined = Array.isArray(body.evidenceWorkIdsOverride)
        ? body.evidenceWorkIdsOverride.filter((id: unknown): id is string => typeof id === 'string' && !deepScanIds.has(id))
        : undefined;
      let synthesisCap: number | undefined;
      if (overrideIds && overrideIds.length > 0) {
        searchRun = { ...searchRun, evidenceWorkIds: overrideIds };
        synthesisCap = overrideIds.length;
      } else if (deepScanIds.size > 0) {
        // Strip deepscan papers from the run's own evidence list.
        searchRun = {
          ...searchRun,
          evidenceWorkIds: (searchRun.evidenceWorkIds ?? []).filter((id: string) => !deepScanIds.has(id)),
        };
      }

      const allWorkIds = [...new Set([
        ...(searchRun.candidateWorkIds || []),
        ...(searchRun.evidenceWorkIds || []),
        ...(searchRun.signalWorkIds || []),
      ])];

      let works: any[] = [];
      if (allWorkIds.length > 0) {
        const workRows = await fetchWorksByIds(adminClient, allWorkIds);
        works = (workRows || []).map(mapWork);
      }

      // Topicality segmentation (core/context/off) — FULLY ASYNC (2026-07-09):
      // runs on the Qwen gate at BACKGROUND priority and persists to the run when
      // ready; it NEVER blocks the brief response. The client picks up segments on
      // the next run fetch. Advisory + recomputable, so a lost race on a deploy
      // restart is harmless. Soft-fails to null.
      const _segEvidence = (searchRun.evidenceWorkIds || [])
        .map((id: string) => works.find((w: any) => w.id === id))
        .filter(Boolean)
        .map((w: any) => ({ id: w.id, title: w.title, abstract: w.abstract }));
      if (_segEvidence.length > 0) {
        const _runId = searchRun.id;
        void segmentWorks(searchRun.query, _segEvidence, { tenantId: req.headers.get("x-tenant-id") || userId, concurrency: 4 })
          .then((seg) => {
            if (seg && Object.keys(seg.segments).length > 0) {
              return db.from("search_runs").update({ work_segments: { ...seg.segments, _core: seg.core } }).eq("id", _runId);
            }
          })
          .then(undefined, (e) => console.error("[POST /api/briefs] async segmentation failed (non-fatal):", (e as Error)?.message));
      }

      let synthClient;
      try {
        synthClient = await resolveSynthClientForUser(adminClient, userId);
      } catch (e) {
        if (e instanceof ProviderCallError) return json({ error: "Your team's synthesis key is unavailable — contact your admin." }, 503);
        throw e;
      }
      let generated;
      try {
        const extraPapers = Array.isArray(body.extraPapers) ? body.extraPapers : [];
        generated = await createBriefFromRun(searchRun, works, synthClient, [], body.persona, lang, synthesisCap, extraPapers);
      } catch (e) {
        // BYOK key failed: hard-error, NEVER fall back to the app's Gemini or a degraded brief.
        if ((synthClient as { byok?: boolean } | null)?.byok && e instanceof ProviderCallError) {
          const msg = e.isKeyFailure
            ? "Your team's synthesis key was rejected — contact your admin."
            : "Synthesis failed on your team's key — contact your admin.";
          return json({ error: msg }, 502);
        }
        throw e;
      }
      const auditTrace = { ...(generated.auditTrace || {}), savedToLibrary: true };

      const { data: briefRow, error: briefError } = await db
        .from("briefs")
        .insert({
          user_id: userId, search_run_id: searchRun.id, query: searchRun.query,
          status: generated.status, sections: generated.sections,
          audit_trace: auditTrace, share_path: `/briefs/${searchRun.id}`,
        })
        .select().single();

      if (briefError) {
        console.error("[POST /api/briefs] insert error:", briefError);
        return json({ error: "Failed to create brief" }, 500);
      }

      // (topicality segments persist asynchronously — kicked off above, never awaited here)

      await db.from("feed").insert({
        user_id: userId, kind: "brief",
        title: `New brief generated for "${searchRun.query}"`,
        reason: "Created from a structured retrieval and synthesis run.",
        linked_entity_id: briefRow.id,
      });

      // Phase 3 visibility — brief.generated / brief.regenerated event.
      // Best-effort, non-blocking. model='deterministic' on the audit trace
      // flags a fallback brief; `fallback` makes that explicit.
      const briefModel = (auditTrace as any)?.model;
      const isRegenerate = !!(overrideIds && overrideIds.length > 0);
      logUsageEvent({
        tenantId: req.headers.get("x-tenant-id") || userId,
        userId,
        eventType: isRegenerate ? "brief.regenerated" : "brief.generated",
        targetType: "brief",
        targetId: briefRow?.id,
        latencyMs: Date.now() - briefStartedAt,
        status: generated.status === "error" ? "failed" : "completed",
        error: generated.status === "error" ? "synthesis_error" : undefined,
        payload: {
          query: searchRun.query, // local-only; scrubbed for external sinks
          persona: body.persona,
          lang,
          model: briefModel,
          fallback: briefModel === "deterministic",
          briefStatus: generated.status,
          evidenceCount: searchRun.evidenceWorkIds?.length ?? 0,
          overrideCount: isRegenerate ? overrideIds!.length : undefined,
          briefId: briefRow?.id,
          searchRunId: searchRun.id,
        },
      });

      return json(mapBrief(briefRow), 201);
    }

    // ----------------------------------------------------------------
    // GET /api/briefs/stream — SSE streaming endpoint (Phase 4)
    // Must be BEFORE /api/briefs/:id to prevent "stream" matching as ID
    // ----------------------------------------------------------------
    if (req.method === "GET" && path === "/api/briefs/stream") {
      const searchRunId = url.searchParams.get("searchRunId");
      const persona = url.searchParams.get("persona");
      const langParam = url.searchParams.get("lang");
      const lang: 'en' | 'es' | 'pt' = langParam === 'es' || langParam === 'pt' ? langParam : 'en';
      const excludedRaw = url.searchParams.get("excludedWorkIds") || "";
      const excludedSet = new Set(
        excludedRaw.split(",").map((s) => s.trim()).filter(Boolean),
      );
      // visibleWorkIds: the SPECIFIC set of papers currently visible in the
      // user's table. When provided, brief synthesis + box stats use ONLY
      // these papers, not the full retrieval pool. Makes the table the
      // source of truth: counts in boxes match what user sees, Gemini's
      // narrative is grounded only in the visible set.
      const visibleRaw = url.searchParams.get("visibleWorkIds") || "";
      const visibleSet = new Set(
        visibleRaw.split(",").map((s) => s.trim()).filter(Boolean),
      );
      const extraPapersJson = url.searchParams.get("extraPapersJson");
      let extraPapers: any[] = [];
      if (extraPapersJson) {
        try {
          // UTF-8-safe decode: atob yields a byte-string; decode those bytes as
          // UTF-8 so accented titles/abstracts (é, ñ, em-dash) round-trip intact.
          // Backward compatible: ASCII-only payloads decode identically.
          const bytes = Uint8Array.from(atob(extraPapersJson), (c) => c.charCodeAt(0));
          extraPapers = JSON.parse(new TextDecoder().decode(bytes));
          if (!Array.isArray(extraPapers)) extraPapers = [];
          // Product contract: max 3 added papers per brief (client enforces the
          // same cap; this stops an oversized forged payload).
          extraPapers = extraPapers.slice(0, 3);
        } catch { extraPapers = []; }
      }
      if (!searchRunId) return json({ error: "searchRunId is required" }, 400);

      const { data: searchRunRow } = await db.from("search_runs").select("*").eq("id", searchRunId).single();
      if (!searchRunRow) return json({ error: "Search run not found" }, 404);

      let searchRun = mapSearchRun(searchRunRow);
      if (!searchRun) return json({ error: "Search run not found" }, 404);
      // Apply user exclusions to the in-memory SearchRun used for synthesis only.
      // The persisted SearchRun is unchanged — exclusions are per-regeneration.
      if (excludedSet.size > 0) {
        searchRun = {
          ...searchRun,
          candidateWorkIds: (searchRun.candidateWorkIds || []).filter((id: string) => !excludedSet.has(id)),
          evidenceWorkIds: (searchRun.evidenceWorkIds || []).filter((id: string) => !excludedSet.has(id)),
          signalWorkIds: (searchRun.signalWorkIds || []).filter((id: string) => !excludedSet.has(id)),
        };
      }
      // Apply visibleWorkIds AFTER exclusions — exclusions still take effect
      // even if not in visibleWorkIds. If both are specified, the intersection
      // is what gets synthesized.
      if (visibleSet.size > 0) {
        searchRun = {
          ...searchRun,
          evidenceWorkIds: (searchRun.evidenceWorkIds || []).filter((id: string) => visibleSet.has(id)),
          // candidate + signal IDs left alone — only evidence drives synthesis
        };
      }
      const allWorkIds = [...new Set([
        ...(searchRun.candidateWorkIds || []),
        ...(searchRun.evidenceWorkIds || []),
        ...(searchRun.signalWorkIds || []),
      ])];

      let works: any[] = [];
      if (allWorkIds.length > 0) {
        const workRows = await fetchWorksByIds(adminClient, allWorkIds);
        works = (workRows || []).map(mapWork);
      }

      // Topicality segmentation — FULLY ASYNC (2026-07-09): background priority on
      // the Qwen gate, persists to the run when ready, never blocks the stream.
      const _segEvidenceS = (searchRun.evidenceWorkIds || [])
        .map((id: string) => works.find((w: any) => w.id === id))
        .filter(Boolean)
        .map((w: any) => ({ id: w.id, title: w.title, abstract: w.abstract }));
      if (_segEvidenceS.length > 0) {
        const _runIdS = searchRun.id;
        void segmentWorks(searchRun.query, _segEvidenceS, { tenantId: req.headers.get("x-tenant-id") || userId, concurrency: 4 })
          .then((seg) => {
            if (seg && Object.keys(seg.segments).length > 0) {
              return db.from("search_runs").update({ work_segments: { ...seg.segments, _core: seg.core } }).eq("id", _runIdS);
            }
          })
          .then(undefined, (e) => console.error("[GET /api/briefs/stream] async segmentation failed (non-fatal):", (e as Error)?.message));
      }

      // Capture phase1 brief for error fallback persistence
      let phase1Brief: any = null;
      // Set once the healthy brief row is persisted. Guards the catch block from
      // inserting a SECOND (status='error') brief when the failure is merely a
      // client disconnect during the post-persist enqueue/verifier — the brief
      // itself already succeeded, so the user should end with one good brief,
      // not one good + one error row (and two feed items).
      let briefPersisted = false;

      let synthClient;
      try {
        synthClient = await resolveSynthClientForUser(adminClient, userId);
      } catch (e) {
        if (e instanceof ProviderCallError) return json({ error: "Your team's synthesis key is unavailable — contact your admin." }, 503);
        throw e;
      }

      // Client-disconnect tracking: cancel() fires when the consumer goes away.
      // Synthesis + persistence deliberately CONTINUE after a disconnect — the
      // brief still lands in history — but we stop the heartbeat immediately and
      // stop writing to the dead pipe. send() never throws, so a mid-generation
      // disconnect can no longer divert a healthy run into the catch path
      // (which used to persist a duplicate status='error' brief).
      let clientGone = false;
      let stopHeartbeatRef: () => void = () => {};
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const send = (frame: string) => {
            if (clientGone) return;
            try { controller.enqueue(encoder.encode(frame)); } catch { clientGone = true; }
          };
          const closeStream = () => { try { controller.close(); } catch { /* already closed/cancelled */ } };
          // Slow synthesis (BYOK Claude ≈75s) emits nothing while the provider
          // call is in flight; proxies on the Vercel→nginx path kill silent
          // connections and the client reports "connection dropped" even
          // though the brief persists fine. Heartbeat comments keep the pipe
          // warm until the terminal event. See startSseHeartbeat docs.
          const stopHeartbeat = startSseHeartbeat(controller);
          stopHeartbeatRef = stopHeartbeat;

          try {
            const finalBrief = await createStreamingBriefFromRun(
              searchRun, works, synthClient, [],
              {
                onPhase1: (brief) => {
                  phase1Brief = brief;
                  send(sseEvent("phase1", brief));
                },
                onChunk: (text) => {
                  send(sseEvent("chunk", { text }));
                },
              },
              persona,
              lang,
              extraPapers,
            );

            // Persist the final brief to DB
            const { data: briefRow, error: briefError } = await db
              .from("briefs")
              .insert({
                user_id: userId, search_run_id: searchRun.id, query: searchRun.query,
                status: finalBrief.status, sections: finalBrief.sections,
                audit_trace: { ...(finalBrief.auditTrace || {}), savedToLibrary: false },
                share_path: `/briefs/${searchRun.id}`,
              })
              .select().single();

            if (briefError) {
              console.error("[GET /api/briefs/stream] insert error:", briefError);
              send(sseEvent("error", { error: "Failed to persist brief" }));
              closeStream();
              return;
            }
            briefPersisted = true;

            // (topicality segments persist asynchronously — kicked off above, never awaited here)

            // Create feed item
            await db.from("feed").insert({
              user_id: userId, kind: "brief",
              title: `New brief generated for "${searchRun.query}"`,
              reason: "Created from a structured retrieval and synthesis run.",
              linked_entity_id: briefRow.id,
            });

            send(sseEvent("done", mapBrief(briefRow)));

            // POST-DONE: one bounded Qwen verifier call for the generated brief
            // prose. This runs after the user-visible `done` event, so it does
            // not add brief latency. If it times out/fails/returns unchanged,
            // the original Gemini brief remains in place.
            try {
              const rows = finalBrief.sections?.evidenceRows || [];
              if (rows.length > 0) {
                const verified = await verifyBriefSections(finalBrief.sections || {}, rows, lang);
                if (verified.changed) {
                  const correctedSections = {
                    ...finalBrief.sections,
                    abstractSummary: verified.sections.abstractSummary ?? finalBrief.sections?.abstractSummary,
                    summaryBullets: verified.sections.summaryBullets ?? finalBrief.sections?.summaryBullets,
                    strongestEvidence: verified.sections.strongestEvidence ?? finalBrief.sections?.strongestEvidence,
                    methodologyNote: verified.sections.methodologyNote ?? finalBrief.sections?.methodologyNote,
                    coverageCard: {
                      ...(finalBrief.sections?.coverageCard || {}),
                      ...(verified.sections.coverageCard || {}),
                    },
                  };
                  await db.from("briefs").update({ sections: correctedSections }).eq("id", briefRow.id);
                  send(sseEvent("verified", {
                    sections: correctedSections,
                    methodologyNote: correctedSections.methodologyNote,
                    gapSummary: correctedSections.coverageCard?.gapSummary,
                  }));
                  console.log("[brief-verifier] post-done section corrections applied to brief", briefRow.id);
                }
              }
            } catch (vErr) {
              console.error("[brief-verifier] post-done check failed (non-blocking):", vErr);
            }

            closeStream();
          } catch (err) {
            console.error("[GET /api/briefs/stream] error:", err);

            // The healthy brief already persisted (failure was a client
            // disconnect during a post-persist enqueue / the verifier). Do NOT
            // insert a duplicate error brief — just close.
            if (briefPersisted) {
              closeStream();
              return;
            }

            // BYOK key failure → emit a clear error frame; do NOT persist/ship a degraded brief.
            if ((synthClient as { byok?: boolean } | null)?.byok && err instanceof ProviderCallError) {
              send(sseEvent("error", {
                error: err.isKeyFailure
                  ? "Your team's synthesis key was rejected — contact your admin."
                  : "Synthesis failed on your team's key — contact your admin.",
              }));
              closeStream();
              return;
            }

            // Always persist a brief — use deterministic fallback from phase1
            const fallback = phase1Brief || { query: searchRun.query, status: "error", sections: {}, auditTrace: {} };
            try {
              const { data: errorRow } = await db
                .from("briefs")
                .insert({
                  user_id: userId, search_run_id: searchRun.id, query: searchRun.query,
                  status: "error", sections: fallback.sections || {},
                  audit_trace: { ...(fallback.auditTrace || {}), savedToLibrary: false },
                  share_path: `/briefs/${searchRun.id}`,
                })
                .select().single();

              if (errorRow) {
                await db.from("feed").insert({
                  user_id: userId, kind: "brief",
                  title: `Brief generated for "${searchRun.query}" (with errors)`,
                  reason: "Synthesis failed — deterministic fallback used.",
                  linked_entity_id: errorRow.id,
                });
                send(sseEvent("done", mapBrief(errorRow)));
              }
            } catch (dbErr) {
              console.error("[GET /api/briefs/stream] fallback DB insert failed:", dbErr);
            }

            send(sseEvent("error", { error: err instanceof Error ? err.message : "Synthesis failed" }));
            closeStream();
          } finally {
            stopHeartbeat();
          }
        },
        cancel() {
          // Consumer disconnected. Stop the heartbeat now (don't wait for the
          // next tick to throw) and flag the pipe dead so send() no-ops.
          clientGone = true;
          stopHeartbeatRef();
        },
      });

      return sseResponse(stream);
    }

    // ----------------------------------------------------------------
    // POST /api/briefs/:id/chat — Conversational follow-up (Phase 5)
    // Must be BEFORE generic GET /api/briefs/:id
    // ----------------------------------------------------------------
    if (req.method === "POST" && path.startsWith("/api/briefs/") && path.endsWith("/chat")) {
      const briefId = path.split("/")[3];
      // deno-lint-ignore no-explicit-any
      const body = await req.json().catch(() => ({} as any)); // malformed body → route validation 400s, not a leaked 500
      const question = body.question;
      if (!question || typeof question !== "string") {
        return json({ error: "question is required" }, 400);
      }
      const history: Array<{ role: 'user' | 'model'; content: string }> = body.history || [];

      const { data: briefRow } = await db.from("briefs").select("id, sections").eq("id", briefId).single();
      if (!briefRow) return json({ error: "Brief not found" }, 404);

      const evidenceRows = briefRow.sections?.evidenceRows || [];
      const briefContext = {
        strongestEvidence: briefRow.sections?.strongestEvidence ?? null,
        methodologyNote: briefRow.sections?.methodologyNote ?? null,
      };
      const cappedHistory = history.slice(-10);

      let chatClient;
      try {
        chatClient = await resolveSynthClientForUser(adminClient, userId);
      } catch (e) {
        if (e instanceof ProviderCallError) return json({ error: "Your team's synthesis key is unavailable — contact your admin." }, 503);
        throw e;
      }
      if (!chatClient) {
        return json({ error: "AI chat requires a synthesis key to be configured" }, 503);
      }

      // Telemetry: chat is async (SSE). Emit started here, completed/failed
      // from inside the stream so duration + outcome are both captured.
      const chatTenant = req.headers.get("x-tenant-id") || userId;
      const chatStartedAt = Date.now();
      logUsageEvent({
        tenantId: chatTenant, userId, eventType: "brief.chat",
        targetType: "brief", targetId: briefId, status: "started",
        payload: { question, briefId },
      });

      // Client-disconnect tracking (see the brief stream above). The answer +
      // verifier still run and PERSIST after a disconnect — the message shows
      // up when the user reopens the brief — but SSE writes become no-ops and
      // the suggestions call (whose only consumer is the live pipe) is skipped.
      let chatClientGone = false;
      let stopChatHeartbeatRef: () => void = () => {};
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const send = (frame: string) => {
            if (chatClientGone) return;
            try { controller.enqueue(encoder.encode(frame)); } catch { chatClientGone = true; }
          };
          const closeStream = () => { try { controller.close(); } catch { /* already closed/cancelled */ } };
          let fullResponse = "";
          // Chat answers arrive as ONE chunk after the full provider call
          // (~18s on BYOK Claude), then verifier + suggestion calls add more
          // silent gaps. Same proxy-idle-timeout exposure as the brief
          // stream — keep the pipe warm until the terminal event.
          const stopHeartbeat = startSseHeartbeat(controller);
          stopChatHeartbeatRef = stopHeartbeat;

          try {
            const result = await chatClient.streamChatResponse({
              evidenceRows: evidenceRows.map((r: any) => ({
                workId: r.workId,
                title: r.title,
                sourceName: r.sourceName,
                year: r.year,
                smsLevel: r.smsLevel ?? null,
                finding: r.finding || "",
                authors: toArr(r.authors),
                methodologyBadge: r.methodologyBadge || null,
                causalStrength: r.causalStrength || null,
                geography: toArr(r.geography),
              })),
              history: cappedHistory,
              question,
              briefContext,
              onChunk: (text: string) => {
                fullResponse += text;
                send(sseEvent("chunk", { text }));
              },
            });

            if (!result) {
              send(sseEvent("error", { error: "Gemini returned no response — the model may have been unable to process the evidence context" }));
              logUsageEvent({
                tenantId: chatTenant, userId, eventType: "brief.chat",
                targetType: "brief", targetId: briefId, status: "failed",
                latencyMs: Date.now() - chatStartedAt, error: "gemini_no_response",
                payload: { briefId },
              });
              closeStream();
              return;
            }

            // VERIFIER PASS — silently correct paper-specific claims that
            // contradict the evidence table. Qwen receives the table as ground
            // truth and rewrites methodology/SMS/year/author drift. If the
            // draft is already correct or verifier fails, fullResponse is
            // unchanged. User never sees warnings — only the corrected text.
            let verifiedResponse = fullResponse;
            try {
              const verifierRows = evidenceRows.map((r: any) => ({
                workId: r.workId,
                title: r.title,
                authors: toArr(r.authors),
                year: r.year ?? null,
                methodologyBadge: r.methodologyBadge || "Unclassified",
                smsLevel: r.smsLevel ?? null,
                geography: toArr(r.geography),
                finding: r.finding || "",
              }));
              // Tiered off the BYOK key 2026-07-09: the chat fact-check is a cheap
              // sub-task, so verify on self-hosted Qwen (omit chatClient → Qwen path)
              // instead of billing the user's (possibly Sonnet) provider. Qwen
              // contention is now managed by the concurrency gate.
              const { corrected, changed } = await verifyChatAnswer(fullResponse, verifierRows);
              if (changed && corrected && corrected !== fullResponse) {
                verifiedResponse = corrected;
                send(sseEvent("correction", { text: corrected }));
                console.log(`[chat-verifier] applied correction (${fullResponse.length} → ${corrected.length} chars)`);
              }
            } catch (vErr) {
              console.error("[chat-verifier] error (non-blocking):", vErr);
            }

            // Parse [workId] citations from the VERIFIED response and validate
            // against evidence. Verifier may have stripped invalid citations.
            // Membership in the evidence set is the ONLY validity test — workIds
            // are DOI-shaped for most of the corpus (e.g. 10.1093/wber/lhad029),
            // so any bracketed token that exactly matches a row's workId counts.
            // (The old /[a-z]{2,4}:.../ shape check silently dropped every
            // DOI-shaped citation, leaving chat citations empty.)
            const citationPattern = /\[([^\[\]]{2,80})\]/g;
            const rawCitations: string[] = [];
            let match;
            while ((match = citationPattern.exec(verifiedResponse)) !== null) {
              rawCitations.push(match[1].trim());
            }
            const validWorkIds = new Set(evidenceRows.map((r: any) => r.workId));
            const validCitations = [...new Set(rawCitations.filter((c: string) => validWorkIds.has(c)))];

            // Persist user message
            await db.from("brief_messages").insert({
              user_id: userId, brief_id: briefId, role: "user", content: question, citations: [],
            });

            // Persist VERIFIED model message — DB stores corrected text, not
            // the original Gemini draft.
            const { data: modelMsg } = await db.from("brief_messages").insert({
              user_id: userId, brief_id: briefId, role: "model", content: verifiedResponse, citations: validCitations,
            }).select("id").single();

            send(sseEvent("citations", { workIds: validCitations }));

            // Generate adaptive chat-suggestion chips for the next turn.
            // Quick best-effort call — if it fails or times out, frontend
            // falls back to a static evergreen list. Skipped entirely when the
            // client is gone: the live pipe is its only consumer, so the LLM
            // call would be pure waste.
            if (!chatClientGone) {
              try {
                const briefQuery = (briefRow as any).sections?.query || question;
                const suggestions = await chatClient.generateChatSuggestions({
                  briefQuery: typeof briefQuery === 'string' ? briefQuery : question,
                  history: [...cappedHistory, { role: 'user', content: question }, { role: 'model', content: fullResponse }],
                  avoid: cappedHistory.filter((m) => m.role === 'user').map((m) => m.content),
                });
                if (suggestions && suggestions.length > 0) {
                  send(sseEvent("suggestions", { suggestions }));
                }
              } catch (suggestErr) {
                console.error("[POST /api/briefs/:id/chat] suggestion gen failed:", suggestErr);
              }
            }

            send(sseEvent("done", { messageId: modelMsg?.id || null }));
            logUsageEvent({
              tenantId: chatTenant, userId, eventType: "brief.chat",
              targetType: "brief", targetId: briefId, status: "completed",
              latencyMs: Date.now() - chatStartedAt,
              payload: { briefId, citationCount: validCitations.length, answerLength: verifiedResponse.length },
            });
            closeStream();
          } catch (err) {
            console.error("[POST /api/briefs/:id/chat] error:", err);
            logUsageEvent({
              tenantId: chatTenant, userId, eventType: "brief.chat",
              targetType: "brief", targetId: briefId, status: "failed",
              latencyMs: Date.now() - chatStartedAt,
              error: err instanceof Error ? err.message : "chat_failed",
              payload: { briefId },
            });
            // BYOK key failure → surface a clear error; never silently fall back.
            const chatErrMsg = ((chatClient as { byok?: boolean } | null)?.byok && err instanceof ProviderCallError)
              ? (err.isKeyFailure
                  ? "Your team's synthesis key was rejected — contact your admin."
                  : "Synthesis failed on your team's key — contact your admin.")
              : (err instanceof Error ? err.message : "Chat failed");
            send(sseEvent("error", { error: chatErrMsg }));
            closeStream();
          } finally {
            stopHeartbeat();
          }
        },
        cancel() {
          // Consumer disconnected — stop the heartbeat now and mark the pipe
          // dead so send() no-ops and the suggestions call is skipped.
          chatClientGone = true;
          stopChatHeartbeatRef();
        },
      });

      return sseResponse(stream);
    }

    // ----------------------------------------------------------------
    // GET /api/briefs/:id/messages — Chat history (Phase 5)
    // Must be BEFORE generic GET /api/briefs/:id
    // ----------------------------------------------------------------
    if (req.method === "GET" && path.startsWith("/api/briefs/") && path.endsWith("/messages")) {
      const briefId = path.split("/")[3];
      const { data: rows, error: fetchError } = await db
        .from("brief_messages")
        .select("*")
        .eq("brief_id", briefId)
        .order("created_at", { ascending: true });

      if (fetchError) {
        console.error("[GET /api/briefs/:id/messages] error:", fetchError);
        return json({ error: "Failed to fetch messages" }, 500);
      }

      return json((rows || []).map(mapChatMessage));
    }

    // ----------------------------------------------------------------
    // DELETE /api/briefs/:id/messages/:messageId — Delete a chat message
    // ----------------------------------------------------------------
    if (req.method === "DELETE" && path.startsWith("/api/briefs/") && path.includes("/messages/")) {
      const parts = path.split("/");
      const messageId = parts[5]; // /api/briefs/:briefId/messages/:messageId
      if (!messageId) return json({ error: "messageId is required" }, 400);

      const { error: deleteError } = await db
        .from("brief_messages")
        .delete()
        .eq("id", messageId)
        .eq("user_id", userId); // RLS also enforces this

      if (deleteError) {
        console.error("[DELETE /api/briefs/:id/messages/:messageId] error:", deleteError);
        return json({ error: "Failed to delete message" }, 500);
      }

      return json({ ok: true });
    }

    // ----------------------------------------------------------------
    // GET /api/briefs/:id
    // ----------------------------------------------------------------
    if (req.method === "GET" && path.startsWith("/api/briefs/")) {
      const id = path.split("/").pop();
      const { data: row } = await db.from("briefs").select("*").eq("id", id).single();
      if (!row) return json({ error: "Brief not found" }, 404);
      // Embed works so the frontend can resolve abstracts/metadata regardless of
      // the snapshot's 100-most-recent cap. Sections are stored camelCase
      // (evidenceRows/workId — same shape the chat route reads); the old
      // snake_case keys never existed, so the embed always returned [].
      const workIds: string[] = ((row.sections?.evidenceRows ?? []) as any[])
        .map((r: any) => r.workId)
        .filter(Boolean);
      const works = workIds.length > 0
        ? (await fetchWorksByIds(adminClient, workIds)).map(mapWork).filter(Boolean)
        : [];
      return json({ ...mapBrief(row), works });
    }

    // ----------------------------------------------------------------
    // POST /api/alerts/subscriptions
    // ----------------------------------------------------------------
    if (req.method === "POST" && path === "/api/alerts/subscriptions") {
      // deno-lint-ignore no-explicit-any
      const body = await req.json().catch(() => ({} as any)); // malformed body → route validation 400s, not a leaked 500
      const { data: row, error: insertError } = await db
        .from("subscriptions")
        .insert({
          user_id: userId, type: body.type, label: body.label,
          cadence: body.cadence || "weekly", query: body.query || null,
          author_id: body.authorId || null, topic: body.topic || null,
        })
        .select().single();

      if (insertError) {
        logUsageEvent({
          tenantId: req.headers.get("x-tenant-id") || userId, userId,
          eventType: "subscription.created", targetType: "subscription",
          status: "failed", error: "insert_failed", payload: { type: body.type },
        });
        return json({ error: "Failed to create subscription" }, 500);
      }
      logUsageEvent({
        tenantId: req.headers.get("x-tenant-id") || userId, userId,
        eventType: "subscription.created", targetType: "subscription", targetId: row?.id,
        status: "completed",
        payload: { subType: body.type, cadence: body.cadence || "weekly", query: body.query || null },
      });
      return json(mapSubscription(row), 201);
    }

    // ----------------------------------------------------------------
    // GET /api/feed
    // ----------------------------------------------------------------
    if (req.method === "GET" && path === "/api/feed") {
      const { data: rows } = await db.from("feed").select("*").eq("user_id", userId).order("created_at", { ascending: false });
      return json((rows || []).map(mapFeedItem));
    }

    // ----------------------------------------------------------------
    // POST /api/feedback
    // ----------------------------------------------------------------
    if (req.method === "POST" && path === "/api/feedback") {
      // deno-lint-ignore no-explicit-any
      const body = await req.json().catch(() => ({} as any)); // malformed body → route validation 400s, not a leaked 500
      // Use adminClient for writes — db (user-client via Kong/PostgREST) silently
      // fails RLS checks in the self-hosted Supabase stack. All other write paths
      // in this handler use adminClient for the same reason.
      const { data: row, error: insertError } = await adminClient
        .from("feedback")
        .insert({
          user_id: userId, brief_id: body.briefId || null, work_id: body.workId || null,
          type: body.type, reason: body.reason || null,
        })
        .select().single();

      if (insertError) {
        console.error("[feedback] insert failed:", insertError.message, insertError.code);
        logUsageEvent({
          tenantId: req.headers.get("x-tenant-id") || userId, userId,
          eventType: "feedback.submitted",
          targetType: body.workId ? "work" : "brief",
          targetId: body.workId || body.briefId || undefined,
          status: "failed", error: "insert_failed",
          payload: { rating: body.type },
        });
        return json({ error: "Failed to record feedback" }, 500);
      }

      // Telemetry: feedback.submitted (rating = like/dislike/save/dismiss).
      // For dislikes, capture the reason (not-relevant | something-wrong + correction).
      // type='save' is also surfaced as paper.saved / query.saved for funnel clarity.
      const fbTenant = req.headers.get("x-tenant-id") || userId;
      const fbTarget = body.workId ? "work" : "brief";
      const fbTargetId = body.workId || body.briefId || undefined;
      logUsageEvent({
        tenantId: fbTenant, userId, eventType: "feedback.submitted",
        targetType: fbTarget, targetId: fbTargetId, status: "completed",
        payload: { rating: body.type, reason: body.reason || null, briefId: body.briefId || null, workId: body.workId || null },
      });
      if (body.type === "save") {
        logUsageEvent({
          tenantId: fbTenant, userId,
          eventType: body.workId ? "paper.saved" : "query.saved",
          targetType: fbTarget, targetId: fbTargetId, status: "completed",
          payload: { briefId: body.briefId || null, workId: body.workId || null },
        });
      }

      // Fire-and-forget: capture the originating query on the feedback row so
      // future semantically-similar queries can act on it. DISLIKE → suppress
      // the paper (dislikeFilter.ts); LIKE/SAVE → boost it (promoteFilter.ts).
      // Query resolved from briefId (brief→run→query) OR an explicit searchRunId
      // (the plugin has a run but no brief). Requires a workId.
      if (row && body.workId && ["dislike", "like", "save"].includes(body.type)) {
        (async () => {
          try {
            // Resolve the originating query from (in priority): explicit queryText
            // (Paper Studio passes the plan's working question), searchRunId (plugin),
            // or briefId (web evidence table → brief → run).
            let queryText: string | null =
              (typeof body.queryText === "string" && body.queryText.trim()) ? body.queryText.trim() : null;
            if (!queryText) {
              let searchRunId: string | null = body.searchRunId || null;
              if (!searchRunId && body.briefId) {
                const { data: brief } = await adminClient
                  .from("briefs").select("search_run_id").eq("id", body.briefId).single();
                searchRunId = brief?.search_run_id ?? null;
              }
              if (searchRunId) {
                const { data: run } = await adminClient
                  .from("search_runs").select("query").eq("id", searchRunId).single();
                queryText = run?.query ?? null;
              }
            }
            if (!queryText) return;
            const ec = createEmbeddingClient();
            if (!ec) return;
            const emb = await ec.embedText(queryText, "query");
            if (!emb) return;
            await adminClient
              .from("feedback")
              .update({ query_embedding: `[${emb.join(",")}]`, query_text: queryText })
              .eq("id", row.id);
          } catch (err) {
            console.warn("[feedback] failed to backfill query_embedding:", (err as Error).message);
          }
        })();
      }

      return json(mapFeedback(row), 201);
    }

    // ----------------------------------------------------------------
    // POST /api/admin/source-review
    // ----------------------------------------------------------------
    if (req.method === "POST" && path === "/api/admin/source-review") {
      if (!isAdmin) return json({ error: "Admin access required" }, 403);
      // deno-lint-ignore no-explicit-any
      const body = await req.json().catch(() => ({} as any)); // malformed body → route validation 400s, not a leaked 500
      if (!body.sourceId) return json({ error: "sourceId is required" }, 400);

      const { data: source } = await adminClient.from("sources").select("*").eq("id", body.sourceId).single();
      if (!source) return json({ error: "Source not found" }, 404);

      const newAllowedUse = body.approved
        ? source.coverage_type === "signal" ? "signal" : "evidence"
        : "restricted";

      const { error: updateError } = await adminClient.from("sources").update({ allowed_use: newAllowedUse }).eq("id", body.sourceId);
      if (updateError) return json({ error: "Failed to update source" }, 500);

      await db.from("feed").insert({
        user_id: userId, kind: "signal", title: `Source policy updated for ${source.name}`,
        reason: body.note || "", linked_entity_id: null,
      });

      logUsageEvent({
        tenantId: req.headers.get("x-tenant-id") || userId, userId,
        eventType: "admin.source_review", targetType: "source", targetId: body.sourceId,
        status: "completed",
        payload: { approved: body.approved === true, newAllowedUse },
      });

      return json({ ok: true });
    }

    // ----------------------------------------------------------------
    // POST /api/admin/works/:id/exclude
    // ----------------------------------------------------------------
    if (req.method === "POST" && path.startsWith("/api/admin/works/") && path.endsWith("/exclude")) {
      if (!isAdmin) return json({ error: "Admin access required" }, 403);
      const workId = decodeURIComponent(path.split("/")[4]);
      // deno-lint-ignore no-explicit-any
      const body = await req.json().catch(() => ({} as any)); // malformed body → route validation 400s, not a leaked 500
      const excluded = body.excluded === true;

      const { error: updateError } = await adminClient.from("works").update({ excluded }).eq("id", workId);
      if (updateError) return json({ error: "Failed to update work" }, 500);
      return json({ ok: true, excluded });
    }

    // ----------------------------------------------------------------
    // POST /api/admin/works/:id/star
    // ----------------------------------------------------------------
    if (req.method === "POST" && path.startsWith("/api/admin/works/") && path.endsWith("/star")) {
      if (!isAdmin) return json({ error: "Admin access required" }, 403);
      const workId = decodeURIComponent(path.split("/")[4]);
      // deno-lint-ignore no-explicit-any
      const body = await req.json().catch(() => ({} as any)); // malformed body → route validation 400s, not a leaked 500
      const starred = body.starred === true;

      const { error: updateError } = await adminClient.from("works").update({ starred }).eq("id", workId);
      if (updateError) return json({ error: "Failed to update work" }, 500);
      return json({ ok: true, starred });
    }

    // ----------------------------------------------------------------
    // POST /api/admin/learning-agent/run
    // ----------------------------------------------------------------
    if (req.method === "POST" && path === "/api/admin/learning-agent/run") {
      if (!isAdmin) return json({ error: "Admin access required" }, 403);
      const result = await runLearningAgent(adminClient);
      return json(result);
    }

    // ----------------------------------------------------------------
    // GET /api/admin/retrieval-audits
    // ----------------------------------------------------------------
    if (req.method === "GET" && path === "/api/admin/retrieval-audits") {
      if (!isAdmin) return json({ error: "Admin access required" }, 403);
      const { data, error } = await adminClient
        .from("retrieval_audits")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) {
        console.error("[retrieval-audit] list failed:", error);
        return json({ error: "Failed to fetch retrieval audits" }, 500);
      }
      return json((data || []).map(mapRetrievalAudit));
    }

    // ----------------------------------------------------------------
    // POST /api/admin/retrieval-audits/run
    // ----------------------------------------------------------------
    if (req.method === "POST" && path === "/api/admin/retrieval-audits/run") {
      if (!isAdmin) return json({ error: "Admin access required" }, 403);
      // deno-lint-ignore no-explicit-any
      const body = await req.json().catch(() => ({} as any)); // malformed body → route validation 400s, not a leaked 500
      if (!body.searchRunId) return json({ error: "searchRunId is required" }, 400);

      const { data: searchRunRow } = await adminClient
        .from("search_runs")
        .select("*")
        .eq("id", body.searchRunId)
        .single();
      if (!searchRunRow) return json({ error: "Search run not found" }, 404);

      const searchRun = mapSearchRun(searchRunRow);
      if (!searchRun) return json({ error: "Search run not found" }, 404);
      const evidenceIds = searchRun?.evidenceWorkIds || [];
      const evidenceRows = evidenceIds.length > 0
        ? await fetchWorksByIds(
          adminClient,
          evidenceIds,
          80,
          "id,title,canonical_doi,year,authors,source,venue,abstract,citation_count,sms_level,methodology_design,abs_rating,repec_percentile,geography,publication_type",
        )
        : [];

      const mode = body?.mode === "external" ? "external" : "corpus";
      const { data: auditFeedback } = await adminClient
        .from("retrieval_audit_feedback")
        .select("item_title,item_doi,item_year,item_source,item_authors,item_why_expected,item_status,query_key,verdict")
        .eq("query_key", normalizeAuditQueryKey(searchRun.query))
        .order("created_at", { ascending: false })
        .limit(500);
      const audit = await runRetrievalAudit({
        client: adminClient,
        searchRun,
        evidenceWorks: evidenceRows,
        mode,
        feedback: auditFeedback || [],
      });

      const { data: auditRow, error: insertError } = await adminClient
        .from("retrieval_audits")
        .insert({
          user_id: userId,
          search_run_id: searchRun.id,
          query: searchRun.query,
          verdict: audit.verdict,
          confidence: audit.confidence,
          expected_evidence: audit.expectedEvidence,
          table_diagnostics: audit.tableDiagnostics,
          recommended_actions: audit.recommendedActions,
          audit_mode: audit.auditMode,
          external_diagnostics: audit.externalDiagnostics || {},
          audit_version: audit.auditVersion,
        })
        .select("*")
        .single();
      if (insertError) {
        console.error("[retrieval-audit] insert failed:", insertError);
        return json({ error: "Failed to save retrieval audit" }, 500);
      }
      return json(mapRetrievalAudit(auditRow), 201);
    }

    // ----------------------------------------------------------------
    // POST /api/admin/retrieval-audits/:id/feedback
    // ----------------------------------------------------------------
    if (req.method === "POST" && path.startsWith("/api/admin/retrieval-audits/") && path.endsWith("/feedback")) {
      if (!isAdmin) return json({ error: "Admin access required" }, 403);
      const auditId = path.split("/")[4];
      // deno-lint-ignore no-explicit-any
      const body = await req.json().catch(() => ({} as any)); // malformed body → route validation 400s, not a leaked 500
      const title = String(body.itemTitle || "").trim();
      const verdict = body.verdict === "relevant" ? "relevant" : "not_relevant";
      if (!auditId || !title) return json({ error: "auditId and itemTitle are required" }, 400);

      const { data: auditRow } = await adminClient
        .from("retrieval_audits")
        .select("id,search_run_id,query")
        .eq("id", auditId)
        .single();
      if (!auditRow) return json({ error: "Audit not found" }, 404);

      const { data, error } = await adminClient
        .from("retrieval_audit_feedback")
        .insert({
          audit_id: auditId,
          user_id: userId,
          search_run_id: auditRow.search_run_id,
          query: auditRow.query,
          query_key: normalizeAuditQueryKey(auditRow.query),
          item_title: title,
          item_doi: body.itemDoi || null,
          item_year: Number.isFinite(Number(body.itemYear)) ? Number(body.itemYear) : null,
          item_source: body.itemSource || null,
          item_authors: Array.isArray(body.itemAuthors) ? body.itemAuthors : [],
          item_why_expected: body.itemWhyExpected || null,
          item_status: body.itemStatus || null,
          verdict,
          note: body.note || null,
        })
        .select("*")
        .single();
      if (error) {
        if ((error as any).code === "23505") return json({ ok: true, duplicate: true }, 200);
        console.error("[retrieval-audit-feedback] insert failed:", error);
        return json({ error: "Failed to save audit feedback" }, 500);
      }
      logUsageEvent({
        tenantId: req.headers.get("x-tenant-id") || userId, userId,
        eventType: "admin.retrieval_audit_feedback", targetType: "retrieval_audit", targetId: auditId,
        status: "completed",
        payload: { verdict, searchRunId: auditRow.search_run_id },
      });
      return json({ ok: true, feedback: data }, 201);
    }

    // ----------------------------------------------------------------
    // GET /api/admin/weights
    // ----------------------------------------------------------------
    if (req.method === "GET" && path === "/api/admin/weights") {
      if (!isAdmin) return json({ error: "Admin access required" }, 403);
      const { data, error } = await adminClient.from("domain_weights").select("*").order("user_id").order("domain");
      if (error) return json({ error: "Failed to fetch weights" }, 500);
      return json((data || []).map(mapDomainWeight));
    }

    // ----------------------------------------------------------------
    // GET /api/admin/proposals
    // ----------------------------------------------------------------
    if (req.method === "GET" && path === "/api/admin/proposals") {
      if (!isAdmin) return json({ error: "Admin access required" }, 403);
      const { data, error } = await adminClient.from("weight_proposals").select("*").order("created_at", { ascending: false });
      if (error) return json({ error: "Failed to fetch proposals" }, 500);
      return json((data || []).map(mapWeightProposal));
    }

    // ----------------------------------------------------------------
    // POST /api/admin/proposals/:id/review
    // ----------------------------------------------------------------
    if (req.method === "POST" && path.startsWith("/api/admin/proposals/") && path.endsWith("/review")) {
      if (!isAdmin) return json({ error: "Admin access required" }, 403);
      const proposalId = path.split("/")[4];
      // deno-lint-ignore no-explicit-any
      const body = await req.json().catch(() => ({} as any)); // malformed body → route validation 400s, not a leaked 500
      if (!["approved", "rejected"].includes(body.status)) {
        return json({ error: "Status must be approved or rejected" }, 400);
      }

      const { data: proposal, error: updateError } = await adminClient
        .from("weight_proposals")
        .update({ status: body.status, reviewed_at: new Date().toISOString() })
        .eq("id", proposalId).select("*").single();

      if (updateError) return json({ error: "Failed to update proposal" }, 500);

      if (body.status === "approved" && proposal) {
        await adminClient.from("domain_weights")
          .update({ weight: proposal.proposed_weight, updated_at: new Date().toISOString() })
          .eq("user_id", proposal.user_id).eq("domain", proposal.domain);
      }

      return json({ ok: true });
    }

    // ----------------------------------------------------------------
    // GET /api/admin/alerts
    // ----------------------------------------------------------------
    if (req.method === "GET" && path === "/api/admin/alerts") {
      if (!isAdmin) return json({ error: "Admin access required" }, 403);
      const { data, error } = await adminClient.from("weight_alerts").select("*").order("created_at", { ascending: false });
      if (error) return json({ error: "Failed to fetch alerts" }, 500);
      return json((data || []).map(mapWeightAlert));
    }

    // ----------------------------------------------------------------
    // GET /api/admin/monitor/* — SCL pilot monitoring (read-only, admin)
    // ----------------------------------------------------------------
    if (req.method === "GET" && path.startsWith("/api/admin/monitor/")) {
      if (!isAdmin) return json({ error: "Admin access required" }, 403);
      const mon = await import("../_shared/monitor/handlers.ts");
      const sub = path.replace("/api/admin/monitor/", "");
      if (sub === "overview") return json(await mon.overview(adminClient));
      if (sub === "activity") return json(await mon.activity(adminClient, url));
      if (sub === "quality") return json(await mon.quality(adminClient));
      if (sub === "cost") return json(await mon.cost(adminClient));
      if (sub === "alerts") return json(await mon.alerts(adminClient));
      if (sub.startsWith("quality/run/")) return json(await mon.qualityForRun(adminClient, sub.replace("quality/run/", "")));
      if (sub.startsWith("quality/paper/")) return json(await mon.qualityForPaper(adminClient, sub.replace("quality/paper/", "")));
      if (sub.startsWith("judge/")) {
        const { latestReview } = await import("../_shared/monitor/judge.ts");
        return json(await latestReview(adminClient, sub.replace("judge/", "")));
      }
      return json({ error: "Unknown monitor endpoint" }, 404);
    }

    // POST /api/admin/monitor/judge/:paperId — run one on-demand JEL quality spot-check
    // (spends one gated Qwen call). Result is persisted; the GET variant above reads it back.
    if (req.method === "POST" && path.startsWith("/api/admin/monitor/judge/")) {
      if (!isAdmin) return json({ error: "Admin access required" }, 403);
      const { judgePaper } = await import("../_shared/monitor/judge.ts");
      const paperId = path.replace("/api/admin/monitor/judge/", "");
      try {
        return json(await judgePaper(adminClient, paperId));
      } catch (e) {
        return json({ error: String((e as Error)?.message ?? e) }, 400);
      }
    }

    // ----------------------------------------------------------------
    // GET /api/admin/corpus/stats — corpus health and storage info
    // ----------------------------------------------------------------
    if (req.method === "GET" && path === "/api/admin/corpus/stats") {
      if (!isAdmin) return json({ error: "Admin access required" }, 403);

      const { count: totalEmbedded } = await adminClient
        .from("works")
        .select("*", { count: "exact", head: true })
        .not("embedding", "is", null);

      const { count: totalCorpus } = await adminClient
        .from("works")
        .select("*", { count: "exact", head: true })
        .not("corpus_source", "is", null);

      const { data: lastImport } = await adminClient
        .from("works")
        .select("corpus_imported_at")
        .not("corpus_imported_at", "is", null)
        .order("corpus_imported_at", { ascending: false })
        .limit(1);

      const { data: sourceCounts } = await adminClient
        .rpc("corpus_source_counts");

      return json({
        totalEmbedded: totalEmbedded ?? 0,
        totalCorpus: totalCorpus ?? 0,
        lastImportAt: lastImport?.[0]?.corpus_imported_at ?? null,
        estimatedStorageMb: Math.round(((totalEmbedded ?? 0) * 5) / 1024),
        bySource: sourceCounts ?? [],
      });
    }

    // ----------------------------------------------------------------
    // POST /api/admin/corpus/import — trigger incremental corpus import
    // Limited to small batches (edge function 60s timeout)
    // ----------------------------------------------------------------
    if (req.method === "POST" && path === "/api/admin/corpus/import") {
      if (!isAdmin) return json({ error: "Admin access required" }, 403);

      const { importCorpus } = await import("../_shared/corpusImport.ts");
      // deno-lint-ignore no-explicit-any
      const body = await req.json().catch(() => ({} as any)); // malformed body → route validation 400s, not a leaked 500

      const result = await importCorpus({
        limit: Math.min(body.limit ?? 200, 500),  // cap at 500 for edge function timeout
        dryRun: body.dryRun ?? false,
        source: body.source ?? "both",
        batchSize: body.batchSize ?? 100,
      });

      return json(result);
    }

    // ----------------------------------------------------------------
    // GET /api/preferences — return current user's preferences (create default if missing)
    // ----------------------------------------------------------------
    if (req.method === "GET" && path === "/api/preferences") {
      const { data: existing } = await db.from("user_preferences").select("*").eq("user_id", userId).single();
      if (existing) {
        return json({
          defaultPersona: existing.default_persona,
          regionalFocus: existing.regional_focus || [],
          methodologyFocus: existing.methodology_focus || [],
          emailAlertsEnabled: existing.email_alerts_enabled,
        });
      }
      // Return defaults without writing — first POST will create the row
      return json({
        defaultPersona: "jel",
        regionalFocus: [],
        methodologyFocus: [],
        emailAlertsEnabled: true,
      });
    }

    // ----------------------------------------------------------------
    // POST /api/preferences — upsert user preferences
    // ----------------------------------------------------------------
    if (req.method === "POST" && path === "/api/preferences") {
      // deno-lint-ignore no-explicit-any
      const body = await req.json().catch(() => ({} as any)); // malformed body → route validation 400s, not a leaked 500
      const { error: upsertError } = await db.from("user_preferences").upsert({
        user_id: userId,
        default_persona: body.defaultPersona ?? "jel",
        regional_focus: body.regionalFocus ?? [],
        methodology_focus: body.methodologyFocus ?? [],
        email_alerts_enabled: body.emailAlertsEnabled ?? true,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });

      if (upsertError) {
        console.error("[POST /api/preferences] upsert error:", upsertError);
        return json({ error: "Failed to save preferences" }, 500);
      }
      return json({ ok: true });
    }

    // ----------------------------------------------------------------
    // GET /api/saved-papers — papers the user saved (feedback type='save')
    // ----------------------------------------------------------------
    if (req.method === "GET" && path === "/api/saved-papers") {
      const { data: feedbackRows, error: fbError } = await adminClient
        .from("feedback")
        .select("id, work_id, brief_id, created_at")
        .eq("user_id", userId)
        .eq("type", "save")
        .not("work_id", "is", null)
        .order("created_at", { ascending: false });

      if (fbError) return json({ error: "Failed to fetch saved papers" }, 500);
      if (!feedbackRows || feedbackRows.length === 0) return json([]);

      const workIds = [...new Set(feedbackRows.map((r: any) => r.work_id).filter(Boolean))];
      const workRows = await fetchWorksByIds(
        adminClient,
        workIds,
        80,
        "id, title, year, venue, sms_level, canonical_doi, url",
      );

      const worksById: Record<string, any> = {};
      for (const w of (workRows || [])) worksById[w.id] = w;

      return json(feedbackRows.map((fb: any) => {
        const w = worksById[fb.work_id] ?? {};
        return {
          feedbackId: fb.id,
          workId: fb.work_id,
          briefId: fb.brief_id ?? null,
          savedAt: fb.created_at,
          title: w.title ?? "Unknown title",
          year: w.year ?? null,
          venue: w.venue ?? null,
          smsLevel: w.sms_level ?? null,
          canonicalDoi: w.canonical_doi ?? null,
          url: w.url ?? null,
        };
      }));
    }

    // ----------------------------------------------------------------
    // DELETE /api/saved-papers/:feedbackId -- remove one saved paper
    // ----------------------------------------------------------------
    if (req.method === "DELETE" && path.startsWith("/api/saved-papers/")) {
      const feedbackId = decodeURIComponent(path.split("/")[3] || "");
      if (!feedbackId) return json({ error: "feedbackId is required" }, 400);

      const { error: deleteError } = await adminClient
        .from("feedback")
        .delete()
        .eq("id", feedbackId)
        .eq("user_id", userId)
        .eq("type", "save")
        .not("work_id", "is", null);

      if (deleteError) return json({ error: "Failed to remove saved paper" }, 500);
      logUsageEvent({
        tenantId: req.headers.get("x-tenant-id") || userId, userId,
        eventType: "saved.deleted", targetType: "feedback", targetId: feedbackId,
        status: "completed", payload: {},
      });
      return json({ ok: true });
    }

    // ----------------------------------------------------------------
    // GET /api/my-weights — current user's domain weights
    // ----------------------------------------------------------------
    if (req.method === "GET" && path === "/api/my-weights") {
      const { data, error } = await db
        .from("domain_weights")
        .select("*")
        .eq("user_id", userId)
        .order("domain");
      if (error) return json({ error: "Failed to fetch weights" }, 500);
      return json((data || []).map(mapDomainWeight));
    }

    // ----------------------------------------------------------------
    // DELETE /api/alerts/subscriptions/:id — remove a subscription
    // ----------------------------------------------------------------
    if (req.method === "DELETE" && path.startsWith("/api/alerts/subscriptions/")) {
      const subId = path.split("/").pop();
      const { error: delError } = await db
        .from("subscriptions")
        .delete()
        .eq("id", subId)
        .eq("user_id", userId);
      if (delError) return json({ error: "Failed to delete subscription" }, 500);
      logUsageEvent({
        tenantId: req.headers.get("x-tenant-id") || userId, userId,
        eventType: "subscription.deleted", targetType: "subscription", targetId: subId,
        status: "completed", payload: {},
      });
      return json({ ok: true });
    }

    // ----------------------------------------------------------------
    // GET /api/follow/digest — per-subscription weekly digest
    //
    // Two lanes per subscription:
    //   - Evidence: corpus papers from the lookback window, ranked by
    //     SMS desc → publication recency → citation count.
    //   - Signals: open-web items via Exa (news/blogs/X) from the same window.
    //
    // Query params (all optional):
    //   windowDays    — lookback window in days (default 7, max 90)
    //   limit         — items per lane per subscription (default 5, max 20)
    //   methodology   — comma-separated MethodologyDesign values (evidence)
    //   regions       — comma-separated geo terms (evidence; matched in title/abstract)
    //   tiers         — comma-separated SMS levels or "A,B,C" (evidence)
    //   sources       — comma-separated source-type filter applied across BOTH lanes:
    //                   journals → keep evidence lane; news/blogs/x → keep matching
    //                   signal source-types. Empty = include everything.
    // ----------------------------------------------------------------
    if (req.method === "GET" && path === "/api/follow/digest") {
      const params = url.searchParams;
      const windowDays = Math.min(90, Math.max(1, parseInt(params.get("windowDays") || "7", 10) || 7));
      const perSubLimit = Math.min(20, Math.max(1, parseInt(params.get("limit") || "5", 10) || 5));
      const methodologyFilter = (params.get("methodology") || "").split(",").map((s) => s.trim()).filter(Boolean);
      const regionsFilter = (params.get("regions") || "").split(",").map((s) => s.trim()).filter(Boolean);
      const tiersFilter = (params.get("tiers") || "").split(",").map((s) => s.trim()).filter(Boolean);
      const sourcesFilter = (params.get("sources") || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

      const sourcesActive = sourcesFilter.length > 0;
      const wantJournals = !sourcesActive || sourcesFilter.includes("journals");
      const wantPolicyPapers = !sourcesActive
        || sourcesFilter.includes("policy_papers")
        || sourcesFilter.includes("policy");
      const wantWorkingPapers = !sourcesActive
        || sourcesFilter.includes("working_papers")
        || sourcesFilter.includes("working");
      const wantEvidence = wantJournals || wantPolicyPapers || wantWorkingPapers;
      const wantSignals = !sourcesActive || sourcesFilter.includes("signals");
      // Kept for downstream Signals filtering (RSS lane only emits "blog" today).
      const wantedSignalTypes: FollowSignalSource[] = wantSignals ? ["news", "blog", "x"] : [];

      // Classify a work into one of three evidence buckets so we can filter
      // by the Source chips. Order matters: working-paper checks first, then
      // policy, else default to journal.
      const WORKING_PAPER_HINTS = [
        "nber", "iza", "ssrn", "repec", "working paper", "discussion paper",
        "wp series", "cesifo", "cepr", "bonn", "ifo working",
      ];
      const POLICY_PAPER_HINTS = [
        "iadb", "inter-american development", "world bank", "imf", "international monetary",
        "oecd", "cgd", "center for global development", "brookings", "ilo",
        "international labour", "un.org", "unctad", "unicef", "paho", "who",
        "cepal", "eclac", "ifpri", "3ie", "caf",
      ];
      const classifyEvidence = (work: any): "journal" | "policy" | "working" => {
        const text = `${work?.venue ?? ""} ${work?.source ?? ""}`.toLowerCase();
        if (WORKING_PAPER_HINTS.some((h) => text.includes(h))) return "working";
        if (POLICY_PAPER_HINTS.some((h) => text.includes(h))) return "policy";
        return "journal";
      };

      const { data: subRows } = await db
        .from("subscriptions")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

      const subscriptions = subRows || [];
      const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

      // SMS tier filter: accept "A","B","C" (Tier-A=SMS 5, Tier-B=SMS 4, Tier-C=SMS 1-3)
      // OR raw integer SMS levels.
      const smsLevels: number[] = [];
      for (const t of tiersFilter) {
        const upper = t.toUpperCase();
        if (upper === "A") smsLevels.push(5);
        else if (upper === "B") smsLevels.push(4);
        else if (upper === "C") smsLevels.push(1, 2, 3);
        else {
          const n = parseInt(t, 10);
          if (!Number.isNaN(n)) smsLevels.push(n);
        }
      }

      const buildQueryForSub = (sub: any) => {
        let q = adminClient
          .from("works")
          .select("*")
          .eq("excluded", false)
          // Exclude corpus noise (2026-07-09): the Follow digest queried `works`
          // directly and only checked `excluded`, so is_noise=true rows (junk
          // deposits, journal apparatus) leaked into Follow even though the main
          // retrieval path drops them. `not.is.true` keeps false AND null.
          .not("is_noise", "is", true)
          .gte("publication_date", sinceIso.slice(0, 10));

        const text = (sub.query || sub.topic || sub.label || "").trim();
        if (sub.type === "author" && sub.author_id) {
          q = q.contains("authors", [sub.author_id]);
        } else if (text) {
          // 2026-07-09: was a verbatim-phrase ILIKE (`%<whole subscription>%`),
          // which matched ~nothing — "Education and long term outcomes" hit 0
          // papers corpus-wide, so the papers lane was permanently empty.
          // websearch FTS drops stopwords and ANDs the remaining terms with
          // word-boundary matching (short tokens like "AI" work). Verified on
          // the live subscriptions: 4-5 matches per 7-day window each.
          const safeText = text.replace(/[%,]/g, " ").trim();
          if (safeText) {
            q = q.textSearch("fts_vector", safeText, { type: "websearch" });
          }
        }

        if (methodologyFilter.length > 0) q = q.in("methodology_design", methodologyFilter);
        if (smsLevels.length > 0) q = q.in("sms_level", smsLevels);
        // Use the geography array column (overlaps = has at least one match).
        // Falls back to title ILIKE for works without tagged geography.
        if (regionsFilter.length > 0) {
          q = q.overlaps("geography", regionsFilter);
        }

        return q
          .order("sms_level", { ascending: false, nullsFirst: false })
          .order("publication_date", { ascending: false, nullsFirst: false })
          .order("citation_count", { ascending: false, nullsFirst: false })
          // Pull a buffer so the post-fetch evidence-type filter still yields perSubLimit.
          .limit(perSubLimit * 5);
      };

      // Run each subscription's two lanes (evidence + signals) in parallel.
      // One failure on either lane shouldn't sink the rest of the digest.
      const digestPerSub = await Promise.all(
        subscriptions.map(async (sub: any) => {
          const subQueryText = (sub.query || sub.topic || sub.label || "").trim();
          const [evidenceResult, signalsResult] = await Promise.allSettled([
            wantEvidence
              ? buildQueryForSub(sub)
              : Promise.resolve({ data: [], error: null } as any),
            wantSignals && subQueryText
              ? fetchFollowSignalsRss(subQueryText, { windowDays, limit: perSubLimit * 3 })
              : Promise.resolve([] as any[]),
          ]);

          const evidenceWorks = (() => {
            if (evidenceResult.status !== "fulfilled") {
              console.error("[follow-digest] evidence lane failed:", sub.id, evidenceResult.reason);
              return [];
            }
            const r: any = evidenceResult.value;
            if (r?.error) {
              console.error("[follow-digest] evidence query error:", sub.id, r.error.message);
              return [];
            }
            const allWorks = (r?.data || []).map(mapWork);
            // Dedup corpus twins (2026-07-09): the corpus carries oa:/DOI shadows
            // and Zenodo multi-deposits (consecutive DOIs, identical title), so the
            // same paper could appear 2×. Collapse by canonical_work_id, else
            // canonical DOI, else normalized title. Rows arrive rank-ordered
            // (SMS→recency→citations), so the first occurrence kept is the best one.
            const seenKeys = new Set<string>();
            const deduped = allWorks.filter((w: any) => {
              const key = w.canonicalWorkId
                || (w.canonicalDoi ? `doi:${String(w.canonicalDoi).toLowerCase()}` : "")
                || `title:${String(w.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
              if (!key || key === "title:") return true; // no usable key → don't drop
              if (seenKeys.has(key)) return false;
              seenKeys.add(key);
              return true;
            });
            // Apply post-fetch evidence-type filter (journals / policy / working).
            const filtered = deduped.filter((w: any) => {
              const cls = classifyEvidence(w);
              if (cls === "journal" && wantJournals) return true;
              if (cls === "policy" && wantPolicyPapers) return true;
              if (cls === "working" && wantWorkingPapers) return true;
              return false;
            });
            return filtered.slice(0, perSubLimit);
          })();

          const signals = (() => {
            if (signalsResult.status !== "fulfilled") {
              console.error("[follow-digest] signals lane failed:", sub.id, signalsResult.reason);
              return [];
            }
            const items = signalsResult.value as any[];
            return items
              .filter((it) => wantedSignalTypes.includes(it.sourceType))
              .slice(0, perSubLimit);
          })();

          return {
            subscription: mapSubscription(sub),
            updates: evidenceWorks,
            signals,
            totalThisWeek: evidenceWorks.length + signals.length,
          };
        }),
      );

      return json({
        windowDays,
        generatedAt: new Date().toISOString(),
        subscriptions: digestPerSub,
      });
    }

    // ----------------------------------------------------------------
    // POST /api/jel-papers — queue a JEL paper generation job
    // ----------------------------------------------------------------
    if (req.method === "POST" && path === "/api/jel-papers") {
      // deno-lint-ignore no-explicit-any
      const body = await req.json().catch(() => ({} as any)); // malformed body → route validation 400s, not a leaked 500
      const planId: string | null = body.planId ?? null;

      // ── Generate from a curated plan ────────────────────────────────
      if (planId) {
        const { data: planRow, error: planErr } = await db
          .from("jel_papers")
          .select("*")
          .eq("id", planId)
          .eq("tenant_id", userId)
          .single();
        if (planErr || !planRow) return json({ error: "Paper plan not found" }, 404);
        // 'planning' = first generation; 'error' = retry after a failed or
        // deploy-interrupted run. Previously an errored plan-paper was
        // permanently stuck: nothing ever reset status back to 'planning', so
        // the user's entire curation was stranded with DELETE as the only exit.
        if (planRow.status !== "planning" && planRow.status !== "error") {
          return json({ error: `Plan is not in 'planning' status (currently '${planRow.status}')` }, 409);
        }
        const planObj = planRow.plan ?? {};
        const curated: string[] = planObj.curatedWorkIds ?? [];
        if (curated.length === 0) return json({ error: "Plan has no curated evidence" }, 400);
        if (!planRow.search_run_id) return json({ error: "Plan has no associated search run" }, 400);

        // Reuse the SAME row: planning/error → queued. Clear preview sections +
        // stale outline + old error. The .in() status guard doubles as a
        // compare-and-swap: a concurrent double-submit loses the race (0 rows
        // updated) and gets a 409 instead of spawning a second job that would
        // interleave section writes with the first on the same row.
        const { data: queued, error: updErr } = await db
          .from("jel_papers")
          .update({ status: "queued", sections: [], outline: null, error_message: null })
          .eq("id", planId)
          .eq("tenant_id", userId)
          .in("status", ["planning", "error"])
          .select("*")
          .single();
        if (updErr || !queued) {
          console.error("[POST /api/jel-papers planId] queue failed (DB error or lost a concurrent race):", updErr);
          return json({ error: "Could not queue generation — the plan may already be generating." }, 409);
        }

        // Write-first Generate Now: stamp the mode + autoExpand flag onto the plan
        // object the job reads. The actual creative-planner expansion runs INSIDE
        // runJelPaperJob (so the 202 returns immediately; the expand is covered by
        // the 'running' status + polling, not a blocking request).
        const generateMode: 'deep' | 'standard' = body?.generateMode === 'deep' ? 'deep' : 'standard';
        planObj.generateMode = generateMode;
        planObj.autoExpand = body?.autoExpand === true;

        // Fire-and-forget plan-aware generation. The .catch is load-bearing: an
        // escaped rejection from a detached job is an unhandled rejection that
        // can terminate the whole Deno process (killing every concurrent job).
        (async () => {
          await runJelPaperJob(planId, planRow.search_run_id, userId, adminClient, planObj, planRow.brief_id);
        })().catch(async (e) => {
          console.error("[POST /api/jel-papers planId] background job escaped:", e);
          try {
            await adminClient.from("jel_papers")
              .update({ status: "error", error_message: "Generation failed unexpectedly. Re-generate to retry." })
              .eq("id", planId);
          } catch { /* watchdog resets orphans on restart */ }
        });

        return json(mapJelPaper(queued), 202);
      }
      // ── Legacy: generate from a search run (unchanged below) ─────────
      const searchRunId: string = body.searchRunId;
      const briefId: string | null = body.briefId ?? null;
      if (!searchRunId) return json({ error: "searchRunId is required" }, 400);

      // Verify the search run belongs to this tenant
      const { data: run } = await db
        .from("search_runs")
        .select("id, query")
        .eq("id", searchRunId)
        .single();
      if (!run) return json({ error: "Search run not found" }, 404);

      // Create the job row
      const { data: job, error: insertErr } = await db
        .from("jel_papers")
        .insert({
          tenant_id: userId,
          search_run_id: searchRunId,
          brief_id: briefId,
          status: "queued",
          query: run.query,
          sections: [],
        })
        .select("*")
        .single();

      if (insertErr || !job) {
        console.error("[POST /api/jel-papers] insert failed:", insertErr);
        return json({ error: "Failed to create paper job" }, 500);
      }

      // Fire-and-forget — pipeline runs in background, updates DB incrementally.
      // .catch is load-bearing: see the planId branch above (process-crash risk).
      (async () => {
        await runJelPaperJob(job.id, searchRunId, userId, adminClient);
      })().catch(async (e) => {
        console.error("[POST /api/jel-papers] background job escaped:", e);
        try {
          await adminClient.from("jel_papers")
            .update({ status: "error", error_message: "Generation failed unexpectedly. Re-generate to retry." })
            .eq("id", job.id);
        } catch { /* watchdog resets orphans on restart */ }
      });

      return json(mapJelPaper(job), 202);
    }

    // ----------------------------------------------------------------
    // GET /api/jel-papers — list papers for this tenant
    // ----------------------------------------------------------------
    if (req.method === "GET" && path === "/api/jel-papers") {
      const { data, error } = await db
        .from("jel_papers")
        .select("id, tenant_id, search_run_id, brief_id, status, query, outline, sections, bibliography, word_count, citation_count, error_message, created_at, completed_at")
        .eq("tenant_id", userId)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) return json({ error: "Failed to fetch papers" }, 500);
      return json((data || []).map(mapJelPaper));
    }

    // ----------------------------------------------------------------
    // GET /api/jel-papers/:id — fetch one paper (full sections)
    // ----------------------------------------------------------------
    if (req.method === "GET" && path.startsWith("/api/jel-papers/")) {
      const paperId = path.split("/").pop();
      const { data, error } = await db
        .from("jel_papers")
        .select("*")
        .eq("id", paperId)
        .eq("tenant_id", userId)
        .single();
      if (error || !data) return json({ error: "Paper not found" }, 404);
      // Embed the corpus Work rows for the bibliography workIds so the client's
      // "Export evidence table (CSV)" can show the rich attributes (SMS,
      // methodology, region, citations) that aren't stored on JelBibEntry.
      const mapped: any = mapJelPaper(data);
      const bibIds = (mapped.bibliography ?? []).map((b: any) => b.workId).filter(Boolean);
      if (bibIds.length > 0) {
        const workRows = await fetchWorksByIds(adminClient, bibIds);
        mapped.evidenceWorks = workRows.map(mapWork).filter(Boolean);
      }
      return json(mapped);
    }

    // ----------------------------------------------------------------
    // PATCH /api/jel-papers/:id — rename (update query / display title)
    // ----------------------------------------------------------------
    if (req.method === "PATCH" && path.startsWith("/api/jel-papers/")) {
      const paperId = path.split("/").pop();
      // deno-lint-ignore no-explicit-any
      const body = await req.json().catch(() => ({} as any)); // malformed body → route validation 400s, not a leaked 500
      const newTitle = typeof body.query === "string" ? body.query.trim() : null;
      if (!newTitle) return json({ error: "query is required" }, 400);

      const { data, error } = await db
        .from("jel_papers")
        .update({ query: newTitle })
        .eq("id", paperId)
        .eq("tenant_id", userId)
        .select("*")
        .single();
      if (error || !data) return json({ error: "Paper not found or update failed" }, 404);
      logUsageEvent({
        tenantId: req.headers.get("x-tenant-id") || userId, userId,
        eventType: "paper.renamed", targetType: "paper", targetId: paperId,
        status: "completed", payload: { title: newTitle },
      });
      return json(mapJelPaper(data));
    }

    // ----------------------------------------------------------------
    // DELETE /api/jel-papers/:id — delete paper + feed entries
    // ----------------------------------------------------------------
    if (req.method === "DELETE" && path.startsWith("/api/jel-papers/")) {
      // Robust id extraction — drop any query string / trailing slash so a
      // malformed URL can't silently turn into a 404.
      const paperId = decodeURIComponent(
        (path.split("/").pop() || "").split("?")[0].trim(),
      );
      if (!paperId) return json({ error: "paperId is required" }, 400);

      // Ownership check + delete via the service-role adminClient (NOT the RLS
      // client `db`). jel_papers historically had a DELETE *policy* but no
      // DELETE *grant* for `authenticated`, so deleting through `db` failed with
      // "permission denied for table jel_papers" for EVERY user — including the
      // owner — leaving errored/stuck papers undeletable. adminClient bypasses
      // RLS + grants; we enforce ownership explicitly here. (Migration
      // 20260608000001 also grants the privilege so the RLS path is correct.)
      const { data: paper, error: ownErr } = await adminClient
        .from("jel_papers")
        .select("id, tenant_id")
        .eq("id", paperId)
        .maybeSingle();
      if (ownErr) {
        console.error("[DELETE /api/jel-papers] lookup failed:", ownErr.message);
        return json({ error: "Lookup failed" }, 500);
      }
      if (!paper) return json({ error: "Paper not found" }, 404);
      if (paper.tenant_id !== userId) {
        return json({ error: "This paper belongs to another account" }, 403);
      }

      // Remove feed entries linked to this paper (best-effort).
      await adminClient
        .from("feed")
        .delete()
        .eq("linked_entity_id", paperId);

      // Delete the paper and confirm a row was actually removed — never report
      // success on a 0-row delete (the old code returned {ok:true} blindly).
      const { data: deleted, error: delErr } = await adminClient
        .from("jel_papers")
        .delete()
        .eq("id", paperId)
        .select("id");
      if (delErr) {
        console.error("[DELETE /api/jel-papers] delete failed:", delErr.message);
        return json({ error: "Delete failed" }, 500);
      }
      if (!deleted || deleted.length === 0) {
        return json({ error: "Paper could not be deleted" }, 500);
      }

      logUsageEvent({
        tenantId: req.headers.get("x-tenant-id") || userId, userId,
        eventType: "paper.deleted", targetType: "paper", targetId: paperId,
        status: "completed", payload: {},
      });

      return json({ ok: true });
    }

    // ----------------------------------------------------------------
    // POST /api/paper-plans — create a draft paper plan from a search run
    // ----------------------------------------------------------------
    if (req.method === "POST" && path === "/api/paper-plans") {
      // deno-lint-ignore no-explicit-any
      const body = await req.json().catch(() => ({} as any)); // malformed body → route validation 400s, not a leaked 500
      const searchRunId: string = body.searchRunId;
      const briefId: string | null = body.briefId ?? null;
      if (!searchRunId) return json({ error: "searchRunId is required" }, 400);

      // Owner filter required for plugin keys (adminClient bypasses RLS) — see
      // GET /api/search-runs/:id. Without it a plugin key could seed a plan from
      // another tenant's run (copying their query + evidence set).
      let runQ = db
        .from("search_runs")
        .select("id, query, evidence_work_ids")
        .eq("id", searchRunId);
      if (viaPluginKey) runQ = runQ.eq("user_id", userId);
      const { data: run } = await runQ.single();
      if (!run) return json({ error: "Search run not found" }, 404);

      const ordered = Array.isArray(body.curatedWorkIdsOverride) && body.curatedWorkIdsOverride.length
        ? body.curatedWorkIdsOverride.filter((id: string) => (run.evidence_work_ids ?? []).includes(id))
        : (run.evidence_work_ids ?? []);

      const seededPlan = {
        workingQuestion: run.query,
        scope: { include: [], exclude: [] },
        curatedWorkIds: ordered,
        removedWorkIds: [],
        uploads: [],
        emphasis: { themes: [], audience: "technical", targetWords: 5000 }, // 10 pages — aligns with PAGE_PRESETS [5,10] × WORDS_PER_PAGE 500
        outlinePreview: null,
      };

      const { data: planRow, error: insertErr } = await db
        .from("jel_papers")
        .insert({
          tenant_id: userId,
          search_run_id: searchRunId,
          brief_id: briefId,
          status: "planning",
          query: run.query,
          sections: [],
          plan: seededPlan,
        })
        .select("*")
        .single();

      if (insertErr || !planRow) {
        console.error("[POST /api/paper-plans] insert failed:", insertErr);
        return json({ error: "Failed to create paper plan" }, 500);
      }
      logUsageEvent({
        tenantId: req.headers.get("x-tenant-id") || userId, userId,
        eventType: "paper_plan.created", targetType: "plan", targetId: planRow.id,
        status: "completed",
        payload: { searchRunId, briefId, curatedCount: (run.evidence_work_ids ?? []).length },
      });
      return json(mapJelPaper(planRow), 201);
    }

    // GET /api/paper-plans/:id  (bare path only — sub-resources like /bundle
    // are handled by their own routes below; without this length guard this
    // handler would swallow them and 404 on the sub-resource name as an id)
    if (req.method === "GET" && path.startsWith("/api/paper-plans/") && path.split("/").length === 4) {
      const planId = path.split("/").pop();
      const { data, error } = await db
        .from("jel_papers")
        .select("*")
        .eq("id", planId)
        .eq("tenant_id", userId)
        .single();
      if (error || !data) return json({ error: "Paper plan not found" }, 404);
      return json(mapJelPaper(data));
    }

    // PATCH /api/paper-plans/:id — shallow-merge plan fields
    if (req.method === "PATCH" && path.startsWith("/api/paper-plans/")) {
      const planId = path.split("/").pop();
      // deno-lint-ignore no-explicit-any
      const body = await req.json().catch(() => ({} as any)); // malformed body → route validation 400s, not a leaked 500
      if (!body.plan || typeof body.plan !== "object") {
        return json({ error: "plan object required" }, 400);
      }
      // 🔒 Plugin keys may PATCH ONLY evidence-curation fields — never workingQuestion,
      // emphasis, uploads, etc. (least-privilege: a leaked key can re-curate the user's
      // own plan's evidence ids but cannot rewrite generation intent).
      if (viaPluginKey) {
        const ALLOWED = new Set(["curatedWorkIds", "discoveredWorkIds", "removedWorkIds"]);
        const disallowed = Object.keys(body.plan).filter((k) => !ALLOWED.has(k));
        if (disallowed.length) {
          return json({ error: `Plugin keys may only patch evidence-curation fields (curatedWorkIds, discoveredWorkIds, removedWorkIds); rejected: ${disallowed.join(", ")}` }, 403);
        }
        for (const k of Object.keys(body.plan)) {
          if (!Array.isArray(body.plan[k]) || body.plan[k].some((v: unknown) => typeof v !== "string")) {
            return json({ error: `Plugin-key plan.${k} must be a string array` }, 400);
          }
        }
      }
      const { data: existing } = await db
        .from("jel_papers")
        .select("plan, query")
        .eq("id", planId)
        .eq("tenant_id", userId)
        .single();
      if (!existing) return json({ error: "Paper plan not found" }, 404);

      const mergedPlan = { ...(existing.plan || {}), ...body.plan };
      const { data, error } = await db
        .from("jel_papers")
        .update({ plan: mergedPlan })
        .eq("id", planId)
        .eq("tenant_id", userId)
        .select("*")
        .single();
      if (error || !data) return json({ error: "Update failed" }, 404);

      // Positive learning (fire-and-forget): papers the user ADDED to the plan
      // (curated/discovered growth vs the stored plan) are a per-query endorsement.
      // Record them as type='add' feedback with the plan's query embedded so a
      // future similar query boosts them (promoteFilter.ts). type='add' is IGNORED
      // by the methodology-weight agent → this learning is independent of weights.
      // 🔒 Writes feedback only, never `works`.
      (async () => {
        try {
          const oldSet = new Set<string>([
            ...((existing.plan?.curatedWorkIds as string[]) ?? []),
            ...((existing.plan?.discoveredWorkIds as string[]) ?? []),
          ]);
          const newIds = [
            ...((mergedPlan.curatedWorkIds as string[]) ?? []),
            ...((mergedPlan.discoveredWorkIds as string[]) ?? []),
          ].filter((id) => typeof id === "string" && !oldSet.has(id));
          const added = [...new Set(newIds)].slice(0, 25);
          if (added.length === 0) return;
          const queryText: string | null = mergedPlan.workingQuestion || existing.plan?.workingQuestion || existing.query || null;
          if (!queryText) return;
          const ec = createEmbeddingClient();
          const emb = ec ? await ec.embedText(queryText, "query") : null;
          const embStr = emb ? `[${emb.join(",")}]` : null;
          await adminClient.from("feedback").insert(
            added.map((workId) => ({
              user_id: userId, brief_id: null, work_id: workId,
              type: "add", reason: "plan_add",
              query_embedding: embStr, query_text: queryText,
            })),
          );
        } catch (err) {
          console.warn("[plan-add] failed to record positive signals:", (err as Error).message);
        }
      })();

      return json(mapJelPaper(data));
    }

    // POST /api/paper-plans/:id/clarify — adaptive questions + workingQuestion + draftOutline
    if (req.method === "POST" && path.startsWith("/api/paper-plans/") && path.endsWith("/clarify")) {
      const planId = path.split("/")[3];
      const { data: planRow } = await db
        .from("jel_papers")
        .select("id, query, brief_id, plan")
        .eq("id", planId)
        .eq("tenant_id", userId)
        .single();
      if (!planRow) return json({ error: "Paper plan not found" }, 404);

      const plan = planRow.plan ?? {};
      const workIds: string[] = plan.curatedWorkIds ?? [];

      // Load curated works (batched, mirrors the JEL pipeline fetch)
      const works: any[] = [];
      for (let i = 0; i < workIds.length; i += 80) {
        const { data } = await db
          .from("works")
          .select("id, title, year, sms_level, methodology_design, geography, citation_count")
          .in("id", workIds.slice(i, i + 80));
        if (data) works.push(...data);
      }

      // Optional brief synthesis for framing
      let briefAbstract: string | null = null;
      let briefBullets: string[] = [];
      if (planRow.brief_id) {
        const { data: brief } = await db
          .from("briefs").select("sections").eq("id", planRow.brief_id).single();
        const s = brief?.sections ?? {};
        briefAbstract = s.abstractSummary ?? null;
        briefBullets = Array.isArray(s.summaryBullets) ? s.summaryBullets : [];
      }

      const result = await generateClarification(
        plan.workingQuestion || planRow.query,
        briefAbstract,
        briefBullets,
        works,
      );

      // NOTE: we deliberately DO NOT persist draftOutline here. The outline is
      // now on-demand (the user opts in via "Preview & edit sections" in the UI),
      // so generation free-builds the outline unless the user explicitly confirms
      // one. The draftOutline is still returned so the client can seed that
      // preview instantly when requested, without another LLM call.
      return json(result);
    }

    // POST /api/paper-plans/:id/outline-preview — regenerate the live outline from current plan
    if (req.method === "POST" && path.startsWith("/api/paper-plans/") && path.endsWith("/outline-preview")) {
      const planId = path.split("/")[3];
      const { data: planRow } = await db
        .from("jel_papers")
        .select("id, query, plan")
        .eq("id", planId)
        .eq("tenant_id", userId)
        .single();
      if (!planRow) return json({ error: "Paper plan not found" }, 404);

      const plan = planRow.plan ?? {};
      const workIds: string[] = plan.curatedWorkIds ?? [];
      const works: any[] = [];
      for (let i = 0; i < workIds.length; i += 80) {
        const { data } = await db
          .from("works")
          .select("id, title, year, sms_level, methodology_design, geography, citation_count")
          .in("id", workIds.slice(i, i + 80));
        if (data) works.push(...data);
      }

      const { outline, degraded } = await generateOutlinePreview(
        plan.workingQuestion || planRow.query,
        plan.scope ?? { include: [], exclude: [] },
        plan.emphasis ?? {},
        works,
      );

      if (outline) {
        const mergedPlan = { ...plan, outlinePreview: outline };
        const { error: updateErr } = await db.from("jel_papers").update({ plan: mergedPlan }).eq("id", planId).eq("tenant_id", userId);
        if (updateErr) console.error("[POST /api/paper-plans/:id/outline-preview] outlinePreview persist failed:", updateErr);
      }
      // Telemetry: the user regenerated / changed the outline (vs accepting the
      // draft as-is). paper.outline_accepted is emitted from the frontend when
      // the user confirms an outline without further edits.
      logUsageEvent({
        tenantId: req.headers.get("x-tenant-id") || userId, userId,
        eventType: "paper.outline_revised", targetType: "plan", targetId: planId,
        status: degraded ? "failed" : "completed",
        error: degraded ? "outline_degraded" : undefined,
        payload: { sectionCount: Array.isArray(outline?.sections) ? outline.sections.length : 0, degraded },
      });
      return json({ outlinePreview: outline, degraded });
    }

    // POST /api/paper-plans/:id/expand-evidence — grounded creative planner adds
    // corpus papers the channel-built table missed. Read-only; persists nothing.
    if (req.method === "POST" && path.startsWith("/api/paper-plans/") && path.endsWith("/expand-evidence")) {
      const planId = path.split("/")[3];
      if (!planId) return json({ error: "Plan id required" }, 400);
      const body = await req.json().catch(() => ({}));
      const planner: "gemini" | "qwen" = body?.planner === "qwen" ? "qwen" : "gemini";
      const cap = Math.max(1, Math.min(50, Number(body?.cap) || 15));
      const t0 = Date.now();

      const { data: planRow } = await db.from("jel_papers").select("id, query, plan").eq("id", planId).eq("tenant_id", userId).single();
      if (!planRow) return json({ error: "Plan not found" }, 404);
      const plan = (planRow.plan as any) ?? {};
      const removed: string[] = plan.removedWorkIds ?? [];
      const baseIds: string[] = (plan.curatedWorkIds ?? []).filter((w: string) => !removed.includes(w));
      if (baseIds.length === 0) return json({ error: "Plan has no curated evidence" }, 400);

      // Anchor titles = the current evidence table, in order (≤80 per .in() chunk).
      const titleById = new Map<string, string>();
      for (let i = 0; i < baseIds.length; i += 80) {
        const { data: rows } = await adminClient.from("works").select("id, title").in("id", baseIds.slice(i, i + 80));
        for (const r of rows ?? []) titleById.set(r.id, r.title ?? "");
      }
      const anchorTitles = baseIds.map((wid) => titleById.get(wid)).filter((t): t is string => !!t);
      const query = plan.workingQuestion || planRow.query || "";
      const tenantId = req.headers.get("x-tenant-id") || userId;

      // Resolve the caller's BYOK provider (null => app-default Gemini) and bind it
      // so the creative planner's Gemini path delegates to the owner's key.
      let epCfg = null;
      try { epCfg = await resolveProviderConfig(adminClient, userId); }
      catch (e) { if (e instanceof ProviderCallError) return json({ error: "Your team's synthesis key is unavailable — contact your admin." }, 503); throw e; }

      const creativePlan = await synthCtxStore.run({ providerCfg: epCfg, tenantId: userId }, () => runCreativePlan(query, planner, anchorTitles, tenantId));
      const { candidates, evaporated } = await groundPlan(creativePlan);
      // Gate on TRUE query·paper cosine, not the probe similarity — see
      // rescoreByTrueQueryCosine. Without this, off-topic-but-probe-similar papers
      // (and contentless stubs, dropped in selectAdds) leak into the evidence pool.
      const rescored = await rescoreByTrueQueryCosine(candidates, query, adminClient);
      const { added, dropped } = selectAdds(rescored, new Set(baseIds), cap, PLANNER_REL_THRESHOLD);

      const addedPapers = added.map((c) => ({
        id: c.id, title: c.title, authors: toArr(c.authors), year: c.year, venue: c.venue,
        citationCount: c.citationCount, smsLevel: c.smsLevel, similarity: +c.similarity.toFixed(3),
        via: c.via, why: c.via.includes("named") ? "named seminal work" : c.via.includes("lit") ? "missing sub-literature" : "expanded sub-query", tier: c.tier,
      }));

      // Telemetry — persist WHY the planner added what it did (the drop audit is
      // otherwise returned only to the client and lost). Lets us answer "why were
      // 0 papers added?" after the fact: a high `evaporated` count = the planner
      // hallucinated unmatched named works; `low_relevance`-heavy = on-topic gate
      // bit; all `already_in_table` = the table already had them. A grounding
      // failure (GPU/embedding timeouts) shows as candidates=0 with proposals>0.
      // Fire-and-forget, fail-safe; raw query text stays in our own Postgres.
      const dropAll = [...dropped, ...evaporated];
      const dropByReason: Record<string, number> = {};
      for (const d of dropAll) dropByReason[d.reason] = (dropByReason[d.reason] ?? 0) + 1;
      logUsageEvent({
        tenantId, userId,
        eventType: "paper.evidence_expanded", targetType: "plan", targetId: planId,
        status: "completed", latencyMs: Date.now() - t0,
        payload: {
          planner, model: creativePlan.model, query,
          proposals: { subQueries: creativePlan.subQueries.length, literatures: creativePlan.literatures.length, namedWorks: creativePlan.namedWorks.length },
          candidatesGrounded: rescored.length,
          added: addedPapers.length,
          dropped: dropAll.length,
          dropByReason,
          relThreshold: PLANNER_REL_THRESHOLD, cap,
        },
      });

      return json({
        planner, model: creativePlan.model, query,
        added: addedPapers,
        dropped: dropAll,
        plan: { subQueries: creativePlan.subQueries, literatures: creativePlan.literatures, namedWorks: creativePlan.namedWorks.length },
      });
    }

    // GET /api/paper-plans/:id/bundle — read-only export for the Claude Code
    // plugin. Returns the plan north-star/emphasis + the curated evidence rows
    // RESOLVED to full metadata, so the analyst's local Claude can draft the
    // paper on their own subscription. 🔒 Read-only; never writes works.
    if (req.method === "GET" && path.startsWith("/api/paper-plans/") && path.endsWith("/bundle")) {
      const planId = path.split("/")[3];
      if (!planId) return json({ error: "Plan id required" }, 400);
      const { data: planRow } = await db
        .from("jel_papers")
        .select("id, query, search_run_id, plan")
        .eq("id", planId).eq("tenant_id", userId).single();
      if (!planRow) return json({ error: "Plan not found" }, 404);
      const plan = (planRow.plan as any) ?? {};
      const removed: string[] = plan.removedWorkIds ?? [];
      const curatedIds: string[] = (plan.curatedWorkIds ?? []).filter((w: string) => !removed.includes(w));
      if (curatedIds.length === 0) return json({ error: "Plan has no curated evidence" }, 400);

      // Resolve curated ids → metadata, preserving curated order (≤80 per .in()).
      const byId = new Map<string, any>();
      for (let i = 0; i < curatedIds.length; i += 80) {
        const { data: rows } = await adminClient
          .from("works")
          .select("id, title, authors, year, sms_level, methodology_design, geography, abstract, canonical_doi, citation_count, venue, abs_rating, repec_percentile, url, source_family")
          .in("id", curatedIds.slice(i, i + 80));
        for (const r of rows ?? []) byId.set(r.id, r);
      }
      const evidence = curatedIds.map((id) => byId.get(id)).filter(Boolean).map((r: any) => ({
        workId: r.id, title: r.title, authors: toArr(r.authors), year: r.year,
        smsLevel: r.sms_level, methodology: r.methodology_design, geography: toArr(r.geography),
        abstract: r.abstract ?? null, doi: r.canonical_doi ?? null, citationCount: r.citation_count ?? null, venue: r.venue ?? null,
        absRating: r.abs_rating ?? null, repecPercentile: r.repec_percentile ?? null, url: r.url ?? null, sourceFamily: r.source_family ?? null,
      }));
      return json({
        planId: planRow.id,
        workingQuestion: plan.workingQuestion || planRow.query || "",
        scope: plan.scope ?? null,
        emphasis: plan.emphasis ?? null,
        clarifyAnswers: plan.clarifyAnswers ?? [],
        outlinePreview: plan.outlinePreview ?? null,
        evidence,
      });
    }

    // POST /api/paper-plans/:id/ground — corroborate LLM-PROPOSED candidates
    // against the corpus, WITHOUT a server-side planner LLM. The analyst's local
    // Claude (their subscription) does the proposing and posts the CreativePlan
    // shape here; the corpus "disposes" (grounds + applies kill rules). 🔒 Read-only.
    // Body: { subQueries?: string[], literatures?: string[], namedWorks?: NamedWork[], cap?: number }
    if (req.method === "POST" && path.startsWith("/api/paper-plans/") && path.endsWith("/ground")) {
      const planId = path.split("/")[3];
      if (!planId) return json({ error: "Plan id required" }, 400);
      const body = await req.json().catch(() => ({}));
      const cap = Math.max(1, Math.min(50, Number(body?.cap) || 15));

      const { data: planRow } = await db.from("jel_papers").select("id, query, plan").eq("id", planId).eq("tenant_id", userId).single();
      if (!planRow) return json({ error: "Plan not found" }, 404);
      const plan = (planRow.plan as any) ?? {};
      const removed: string[] = plan.removedWorkIds ?? [];
      const baseIds: string[] = (plan.curatedWorkIds ?? []).filter((w: string) => !removed.includes(w));
      const groundQuery = plan.workingQuestion || planRow.query || "";

      // Build a CreativePlan from the CLIENT's proposals (model=null: not a server LLM call).
      const strs = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : [];
      const creativePlan = {
        subQueries: strs(body?.subQueries).slice(0, 8),
        literatures: strs(body?.literatures).slice(0, 6),
        namedWorks: (Array.isArray(body?.namedWorks) ? body.namedWorks : []).filter((w: any) => w && typeof w === "object").slice(0, 12).map((w: any) => ({
          title: typeof w.title === "string" ? w.title.trim() : "",
          description: typeof w.description === "string" ? w.description.trim() : "",
          author: typeof w.author === "string" ? w.author.trim() : "",
          year: Number(w.year) || undefined,
        })),
        model: null as null,
      };
      if (!creativePlan.subQueries.length && !creativePlan.literatures.length && !creativePlan.namedWorks.length) {
        return json({ error: "Provide at least one of subQueries, literatures, namedWorks" }, 400);
      }

      const { candidates, evaporated } = await groundPlan(creativePlan);
      const rescored = await rescoreByTrueQueryCosine(candidates, groundQuery, adminClient);
      const { added, dropped } = selectAdds(rescored, new Set(baseIds), cap, PLANNER_REL_THRESHOLD);
      const addedPapers = added.map((c) => ({
        workId: c.id, title: c.title, authors: toArr(c.authors), year: c.year, venue: c.venue,
        citationCount: c.citationCount, smsLevel: c.smsLevel, similarity: +c.similarity.toFixed(3),
        via: c.via, why: c.via.includes("named") ? "named seminal work" : c.via.includes("lit") ? "missing sub-literature" : "expanded sub-query",
      }));
      return json({ added: addedPapers, dropped: [...dropped, ...evaporated] });
    }

    // POST /api/resolve-paper — resolve a DOI/URL or pasted text to paper metadata.
    // Read-only: no DB writes. Used by BriefView "Add paper" panel.
    // Body: { doiOrUrl?: string, pastedText?: string }
    if (req.method === "POST" && path === "/api/resolve-paper") {
      // deno-lint-ignore no-explicit-any
      const body = await req.json().catch(() => ({} as any)); // malformed body → route validation 400s, not a leaked 500
      if (!body.doiOrUrl && !body.pastedText) {
        return json({ error: "doiOrUrl or pastedText is required" }, 400);
      }
      const uploadId = crypto.randomUUID();
      try {
        const result = await resolveUpload(adminClient, {
          doiOrUrl: body.doiOrUrl,
          pastedText: body.pastedText,
        }, uploadId);
        return json(result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Resolution failed";
        console.error("[POST /api/resolve-paper] error:", msg);
        return json({ error: msg }, 500);
      }
    }

    // POST /api/paper-plans/:id/uploads — resolve an upload to a preview card;
    // with confirm:true, attach to plan.uploads + write a dual signal.
    // Body: { doiOrUrl?: string, pastedText?: string, confirm?: boolean, uploadId?: string }
    if (req.method === "POST" && path.startsWith("/api/paper-plans/") && path.endsWith("/uploads")) {
      const planId = path.split("/")[3];
      // deno-lint-ignore no-explicit-any
      const body = await req.json().catch(() => ({} as any)); // malformed body → route validation 400s, not a leaked 500
      if (!body.doiOrUrl && !body.pastedText) {
        return json({ error: "Provide doiOrUrl or pastedText" }, 400);
      }
      const { data: planRow } = await db
        .from("jel_papers")
        .select("id, search_run_id, plan")
        .eq("id", planId)
        .eq("tenant_id", userId)
        .single();
      if (!planRow) return json({ error: "Paper plan not found" }, 404);

      const plan = planRow.plan ?? {};
      const existing: any[] = plan.uploads ?? [];

      // Stable uploadId so a preview and its confirm refer to the same item.
      const uploadId = body.uploadId ?? `up_${crypto.randomUUID()}`;
      // Cap counts NET-NEW adds: re-confirming an existing uploadId (edit/replace)
      // is not blocked even on a full plan. Checked before the expensive resolve.
      const deduped = existing.filter((u: any) => u.uploadId !== uploadId);
      if (body.confirm && deduped.length >= 3) {
        return json({ error: "Upload limit reached (3 per paper)" }, 409);
      }

      const upload = await resolveUpload(db, { doiOrUrl: body.doiOrUrl, pastedText: body.pastedText }, uploadId);
      const inCorpus = !!upload.matchedWorkId;
      const kind = inCorpus ? "add_existing" : "add_new";
      const preview = { upload, inCorpus, kind, alreadyInPlan: isAlreadyInPlan(plan, upload) };

      if (!body.confirm) return json(preview); // preview only — nothing persisted

      // Confirm: if client sends body.upload (user-edited object), merge it in while
      // preserving server-resolved authoritative fields (matchedWorkId, card, smsLevel).
      const finalUpload = body.upload
        ? { ...upload, ...body.upload, uploadId, matchedWorkId: upload.matchedWorkId, card: upload.card, smsLevel: upload.smsLevel }
        : upload;

      // Attach to plan.uploads (dedup by uploadId) + write the dual signal.
      const mergedPlan = { ...plan, uploads: [...deduped, finalUpload] };
      const { error: updErr } = await db
        .from("jel_papers").update({ plan: mergedPlan }).eq("id", planId).eq("tenant_id", userId);
      if (updErr) {
        console.error("[POST /uploads] attach failed:", updErr);
        return json({ error: "Failed to attach upload" }, 500);
      }
      const { error: sigErr } = await db.from("paper_upload_signals").insert({
        tenant_id: userId,
        plan_id: planId,
        search_run_id: planRow.search_run_id,
        kind,
        matched_work_id: upload.matchedWorkId,
        upload: finalUpload,
      });
      if (sigErr) console.error("[POST /uploads] signal insert failed:", sigErr);

      logUsageEvent({
        tenantId: req.headers.get("x-tenant-id") || userId, userId,
        eventType: "paper.upload", targetType: "plan", targetId: planId,
        status: "completed",
        payload: { kind, inCorpus, uploadId, source: body.doiOrUrl ? "doi_or_url" : "pasted_text" },
      });

      return json({ ...preview, attached: true }, 201);
    }

    // GET /api/paper-uploads — this tenant's uploaded papers (≤50, most-recent)
    // for the Library "My uploaded papers" list + reuse. Deduped by doi/title.
    if (req.method === "GET" && path === "/api/paper-uploads") {
      const { data, error } = await db
        .from("paper_upload_signals")
        .select("id, kind, matched_work_id, upload, created_at")
        .eq("tenant_id", userId)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) {
        console.error("[GET /api/paper-uploads] query failed:", error);
        return json({ error: "Failed to load uploads" }, 500);
      }
      // Dedup by doi (fallback title) keeping the most-recent.
      const seen = new Set<string>();
      const uploads = (data ?? []).filter((r: any) => {
        const key = (r.upload?.doi || r.upload?.title || r.id).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).map((r: any) => ({
        ...r.upload,
        kind: r.kind,
        matchedWorkId: r.matched_work_id,
        uploadedAt: r.created_at,
      }));
      return json({ uploads });
    }

    // POST /api/jel-papers/:id/revise — talk-to-the-draft: re-draft targeted
    // section(s). Capped at 2 regenerations per paper. Body: { instruction }
    if (req.method === "POST" && path.startsWith("/api/jel-papers/") && path.endsWith("/revise")) {
      const paperId = path.split("/")[3];
      // deno-lint-ignore no-explicit-any
      const body = await req.json().catch(() => ({} as any)); // malformed body → route validation 400s, not a leaked 500
      const instruction: string = (body.instruction ?? "").trim();
      if (!instruction) return json({ error: "instruction is required" }, 400);

      const { data: paper } = await db
        .from("jel_papers")
        .select("id, status, regenerations_used")
        .eq("id", paperId)
        .eq("tenant_id", userId)
        .single();
      if (!paper) return json({ error: "Paper not found" }, 404);
      if (paper.status !== "done") {
        return json({ error: `Paper is not ready to revise (status '${paper.status}')` }, 409);
      }
      if ((paper.regenerations_used ?? 0) >= 2) {
        return json({ error: "Revision limit reached (2 per paper)" }, 409);
      }

      // The .eq("status","done") makes this flip a compare-and-swap: two
      // concurrent revises (double-click) can't both win — the loser updates 0
      // rows and gets a 409 instead of spawning a second job that would
      // interleave section writes and double-consume the regeneration budget.
      const { data: running, error: updErr } = await db
        .from("jel_papers").update({ status: "running" })
        .eq("id", paperId).eq("tenant_id", userId).eq("status", "done").select("*").single();
      if (updErr || !running) {
        // 0 rows → lost the race (already revising) rather than a hard failure.
        return json({ error: "A revision is already in progress for this paper." }, 409);
      }

      logUsageEvent({
        tenantId: req.headers.get("x-tenant-id") || userId, userId,
        eventType: "paper.revised", targetType: "paper", targetId: paperId,
        status: "started", payload: { instruction, regenerationsUsed: paper.regenerations_used ?? 0 },
      });
      // .catch is load-bearing (process-crash risk — see POST /api/jel-papers).
      // Escaped revision → revert to done: paper content is intact, budget unconsumed.
      (async () => { await runJelPaperRevision(paperId, userId, adminClient, instruction); })().catch(async (e) => {
        console.error("[POST /revise] background revision escaped:", e);
        try {
          await adminClient.from("jel_papers").update({ status: "done" }).eq("id", paperId);
        } catch { /* watchdog resets orphans on restart */ }
      });
      return json(mapJelPaper(running), 202);
    }

    // ----------------------------------------------------------------
    // 404
    // ----------------------------------------------------------------
    return json({ error: "Not found" }, 404);

  } catch (error) {
    console.error("[api] Unhandled error:", error);
    // Phase 3 visibility — capture to Sentry (no-op without SENTRY_DSN). Tags
    // are non-identifying; no request body / query text is sent.
    try {
      captureServerException(error instanceof Error ? error : new Error(String(error)), { scope: "api-handler" });
    } catch {
      // Never let observability break the error path.
    }
    // Generic body only: raw error messages leaked internals (Postgres/PostgREST
    // errors carry table/column names). Full detail is logged + in Sentry above.
    return json({ error: "Internal server error" }, 500);
  }
}
