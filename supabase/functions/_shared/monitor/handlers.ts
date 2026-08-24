// handlers.ts — monitor endpoint handlers. Read-only assembly over usage_events +
// llm_calls, scoped to the SCL roster, delegating all metric logic to the pure modules.
import { getRoster, rosterOrFilter } from "./roster.ts";
import { computeCompletionHealth, type UsageEventRow } from "./health.ts";
import { checkProse, findDuplicates, computeRelevance } from "./quality.ts";
import { computeCost, computeBudget, type CostRow } from "./cost.ts";
import { computeAlerts, type AlertThresholds } from "./alerts.ts";

const WINDOW_DAYS = 7;
const nowMs = () => Date.now();
function sinceIso(days: number): string { return new Date(Date.now() - days * 86_400_000).toISOString(); }

function envNum(key: string): number {
  // deno-lint-ignore no-explicit-any
  const raw = (globalThis as any).Deno?.env?.get?.(key) ?? (globalThis as any).process?.env?.[key];
  return Number(raw ?? 0);
}
function budgets(): Record<string, number> {
  const g = envNum("PROVIDER_BUDGET_GEMINI_USD");
  const c = envNum("PROVIDER_BUDGET_CLAUDE_USD");
  const out: Record<string, number> = {};
  if (g > 0) out.gemini = g;
  if (c > 0) out.claude = c;
  return out;
}
export const THRESHOLDS: AlertThresholds = { failRate: 0.5, fallbackRate: 0.3, budgetWarnPct: 80, budgetCritPct: 95 };

// deno-lint-ignore no-explicit-any
async function usageRows(adminClient: any, days: number): Promise<UsageEventRow[]> {
  const orf = rosterOrFilter(getRoster());
  if (!orf) return [];
  const { data } = await adminClient.from("usage_events")
    .select("id,ts,event_type,status,error,latency_ms,target_type,target_id,user_id,tenant_id,payload")
    .or(orf).gte("ts", sinceIso(days)).order("ts", { ascending: false }).limit(5000);
  return (data ?? []) as UsageEventRow[];
}
// deno-lint-ignore no-explicit-any
async function llmRows(adminClient: any, days: number): Promise<Array<CostRow & { status?: string }>> {
  const orf = rosterOrFilter(getRoster());
  if (!orf) return [];
  const { data } = await adminClient.from("llm_calls")
    .select("model,operation,tenant_id,user_id,ts,tokens_in,tokens_out,cache_read_tokens,cache_write_tokens,thinking_tokens,status")
    .or(orf).gte("ts", sinceIso(days)).limit(20000);
  return (data ?? []) as Array<CostRow & { status?: string }>;
}

// deno-lint-ignore no-explicit-any
export async function overview(adminClient: any) {
  const rows = await usageRows(adminClient, WINDOW_DAYS);
  const health = computeCompletionHealth(rows, nowMs());
  const byUser: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const u = r.tenant_id ?? r.user_id ?? "unknown";
    byUser[u] ??= {};
    byUser[u][r.event_type] = (byUser[u][r.event_type] ?? 0) + 1;
  }
  return { roster: getRoster(), health, byUser, windowDays: WINDOW_DAYS };
}

// deno-lint-ignore no-explicit-any
export async function activity(adminClient: any, url: URL) {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
  const rows = await usageRows(adminClient, WINDOW_DAYS);
  return { events: rows.slice(0, limit) };
}

// deno-lint-ignore no-explicit-any
export async function cost(adminClient: any) {
  const rows = await llmRows(adminClient, WINDOW_DAYS);
  const c = computeCost(rows, nowMs());
  const budget = computeBudget(c.byProvider, budgets(), WINDOW_DAYS);
  return { cost: c, budget };
}

// deno-lint-ignore no-explicit-any
export async function quality(adminClient: any, days: number = WINDOW_DAYS) {
  const rows = await llmRows(adminClient, days);
  // Authoritative fallback signal: brief_synthesis logs status 'ok'|'fallback' ONCE per
  // brief (synthesis.ts). A Gemini error/timeout on the inner gemini_synthesis call
  // surfaces here as 'fallback', so counting ONLY brief_synthesis gives one row per brief
  // (no dilution) and captures the error path. status 'error'/'timeout' kept defensively.
  const briefCalls = rows.filter((r) => r.operation === "brief_synthesis");
  const fb = briefCalls.filter((r) => r.status === "fallback" || r.status === "error" || r.status === "timeout").length;
  const fallbackRate = briefCalls.length ? fb / briefCalls.length : 0;
  return { fallbackRate, briefCallCount: briefCalls.length };
}

// UUID → short display name (email local-part) for the info-level activity alerts.
// Resolved via the auth admin API, cached per process; fail-safe to a shortened UUID.
const nameCache = new Map<string, string>();
// deno-lint-ignore no-explicit-any
async function displayName(adminClient: any, uuid: string): Promise<string> {
  const hit = nameCache.get(uuid);
  if (hit) return hit;
  let name = uuid.slice(0, 8);
  try {
    const { data } = await adminClient.auth.admin.getUserById(uuid);
    const email = data?.user?.email;
    if (email) name = String(email).split("@")[0];
  } catch { /* fail-safe: keep the shortened uuid */ }
  nameCache.set(uuid, name);
  return name;
}

/** Per-roster-user first activity of the current UTC day (info-alert input). */
// deno-lint-ignore no-explicit-any
async function rosterActivityToday(adminClient: any, rows: UsageEventRow[]) {
  const dayStart = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const roster = new Set(getRoster());
  const byUser = new Map<string, { firstTs: string; types: Record<string, number> }>();
  for (const r of rows) {
    if (!r.ts || r.ts.slice(0, 10) !== dayStart) continue;
    const u = r.tenant_id ?? r.user_id ?? "";
    if (!roster.has(u)) continue;
    const cur = byUser.get(u) ?? { firstTs: r.ts, types: {} };
    if (r.ts < cur.firstTs) cur.firstTs = r.ts;
    cur.types[r.event_type ?? "?"] = (cur.types[r.event_type ?? "?"] ?? 0) + 1;
    byUser.set(u, cur);
  }
  const out = [];
  for (const [uuid, v] of byUser) {
    const summary = Object.entries(v.types).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([t, n]) => (n > 1 ? `${t}×${n}` : t)).join(", ");
    out.push({ user: await displayName(adminClient, uuid), firstTs: v.firstTs, summary });
  }
  return out.sort((a, b) => a.firstTs.localeCompare(b.firstTs));
}

// deno-lint-ignore no-explicit-any
export async function alerts(adminClient: any) {
  const uRows = await usageRows(adminClient, 1);
  const health = computeCompletionHealth(uRows, nowMs());
  const q = await quality(adminClient, 1); // align fallback window with the 1-day health window
  const c = await cost(adminClient);
  // day = UTC date so activity fingerprints reset daily (and dedup state stays small).
  const day = new Date().toISOString().slice(0, 10);
  const activity = await rosterActivityToday(adminClient, uRows);
  const list = computeAlerts({ health, fallbackRate: q.fallbackRate, budgets: c.budget, thresholds: THRESHOLDS, day, activity });
  return { alerts: list };
}

// --- Per-entity quality drill-down (on-demand, not on the poll path) ---

// Local string[] coercion — authors can be a JSON-encoded string on some works rows.
// deno-lint-ignore no-explicit-any
function toArr(v: any): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : (x?.name ?? String(x)))).filter(Boolean);
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("[")) { try { const p = JSON.parse(s); return Array.isArray(p) ? toArr(p) : []; } catch { /* fall through */ } }
    return s ? [s] : [];
  }
  return [];
}

// deno-lint-ignore no-explicit-any
export async function qualityForRun(adminClient: any, runId: string) {
  const { data: run } = await adminClient.from("search_runs")
    .select("id,evidence_work_ids,work_segments,top_cosine,mean_cosine").eq("id", runId).maybeSingle();
  if (!run) return { error: "run not found" };
  const ids: string[] = run.evidence_work_ids ?? [];
  const { data: works } = await adminClient.from("works")
    .select("id,title,year,authors").in("id", ids.slice(0, 200));
  // deno-lint-ignore no-explicit-any
  const papers = (works ?? []).map((w: any) => ({ id: w.id, title: w.title ?? "", year: w.year ?? null, authors: toArr(w.authors) }));
  const dups = findDuplicates(papers);
  // Strip the special `_core` concept string before computing the off-ratio.
  const { _core, ...segs } = (run.work_segments ?? {}) as Record<string, string>;
  const offTitles: Record<string, string> = {};
  for (const w of works ?? []) if (segs[w.id] === "off") offTitles[w.id] = w.title ?? w.id;
  const relevance = computeRelevance({
    runId,
    topCosine: run.top_cosine ?? null,
    meanCosine: run.mean_cosine ?? null,
    // deno-lint-ignore no-explicit-any
    segments: segs as any,
    offTitles,
    floor: 0.45,
  });
  return { duplicates: dups, relevance };
}

// deno-lint-ignore no-explicit-any
export async function qualityForPaper(adminClient: any, paperId: string) {
  const { data: paper } = await adminClient.from("jel_papers").select("id,sections").eq("id", paperId).maybeSingle();
  if (!paper) return { error: "paper not found" };
  // deno-lint-ignore no-explicit-any
  const sections: Array<{ title: string; body: string }> = (paper.sections ?? []).map((s: any) => ({
    title: s.title ?? s.heading ?? "section",
    body: s.body ?? s.content ?? "",
  }));
  return { proseIssues: checkProse(paperId, sections) };
}
