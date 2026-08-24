export type ActionKind = "search" | "brief" | "chat" | "paper";

export function eventActionKind(eventType: string): ActionKind | null {
  if (eventType === "brief.chat") return "chat";
  if (eventType.startsWith("search.")) return "search";
  if (eventType.startsWith("brief.")) return "brief";
  if (eventType.startsWith("paper.generation_")) return "paper";
  return null;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export interface UsageEventRow {
  id: string; ts: string; event_type: string; status: string | null;
  error: string | null; latency_ms: number | null;
  target_type: string | null; target_id: string | null;
  user_id?: string | null; tenant_id?: string | null;
}
export interface FailureDetail { targetId: string | null; ts: string; error: string | null; }
export interface StuckJob { targetId: string | null; startedTs: string; ageMs: number; }
export interface ActionHealth {
  action: ActionKind; attempts: number; completed: number; failed: number;
  successRate: number | null; stuck: StuckJob[]; failures: FailureDetail[];
  p50: number | null; p95: number | null;
}

const STUCK_MS: Record<ActionKind, number> = {
  paper: 15 * 60_000, brief: 3 * 60_000, search: 90_000, chat: 90_000,
};
const isStarted = (s: string | null, et: string) => s === "started" || et.endsWith("_started");
const isCompleted = (s: string | null, et: string) => s === "completed" || s === "ok" || et.endsWith("_completed") || et === "brief.generated" || et === "brief.regenerated" || et === "search.submitted" || et === "brief.chat";
const isFailed = (s: string | null, et: string) => s === "failed" || et.endsWith("_failed");

export function computeCompletionHealth(rows: UsageEventRow[], now: number): ActionHealth[] {
  const kinds: ActionKind[] = ["search", "brief", "chat", "paper"];
  return kinds.map((action) => {
    const evs = rows.filter((r) => eventActionKind(r.event_type) === action);
    const completedEvs = evs.filter((r) => isFailed(r.status, r.event_type) ? false : isCompleted(r.status, r.event_type));
    const failedEvs = evs.filter((r) => isFailed(r.status, r.event_type));
    const startedEvs = evs.filter((r) => isStarted(r.status, r.event_type));
    const terminalIds = new Set([...completedEvs, ...failedEvs].map((r) => r.target_id));
    const stuck: StuckJob[] = startedEvs
      .filter((r) => !terminalIds.has(r.target_id) && (now - Date.parse(r.ts)) > STUCK_MS[action])
      .map((r) => ({ targetId: r.target_id, startedTs: r.ts, ageMs: now - Date.parse(r.ts) }));
    const completed = completedEvs.length, failed = failedEvs.length;
    const denom = completed + failed;
    const lats = completedEvs.map((r) => r.latency_ms).filter((n): n is number => typeof n === "number");
    return {
      action,
      attempts: startedEvs.length || (completed + failed),
      completed, failed,
      successRate: denom === 0 ? null : completed / denom,
      stuck,
      failures: failedEvs.map((r) => ({ targetId: r.target_id, ts: r.ts, error: r.error })),
      p50: percentile(lats, 50), p95: percentile(lats, 95),
    };
  });
}
