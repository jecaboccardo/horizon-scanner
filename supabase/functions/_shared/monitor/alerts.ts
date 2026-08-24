import type { ActionHealth } from "./health.ts";
import type { BudgetBurn } from "./cost.ts";

export interface Alert { id: string; severity: "info" | "warn" | "critical"; title: string; detail: string; entities: string[]; fingerprint: string; }
export interface AlertThresholds { failRate: number; fallbackRate: number; budgetWarnPct: number; budgetCritPct: number; }
/** One roster user's first activity of the (UTC) day — drives the info-level "user active" alert. */
export interface RosterActivity { user: string; firstTs: string; summary: string; }
export interface AlertInput { health: ActionHealth[]; fallbackRate: number; budgets: BudgetBurn[]; thresholds: AlertThresholds; day?: string; activity?: RosterActivity[]; }

export function computeAlerts(i: AlertInput): Alert[] {
  const out: Alert[] = [];
  const day = i.day ?? "today";
  const fp = (id: string) => `${id}|${day}`;
  // Info-level: first activity of the day per roster user. The fingerprint is
  // per-user-per-day, so a dedup-aware poster (pilot-monitor.mjs with a state file)
  // posts it exactly once per user per day.
  for (const a of i.activity ?? []) {
    out.push({ id: `activity:${a.user}`, severity: "info", title: `${a.user} active today`, detail: `first ${a.firstTs.slice(11, 16)} UTC · ${a.summary}`, entities: [], fingerprint: fp(`activity:${a.user}`) });
  }
  for (const h of i.health) {
    if (h.successRate != null && (h.completed + h.failed) >= 3 && (1 - h.successRate) > i.thresholds.failRate) {
      out.push({ id: `failrate:${h.action}`, severity: "critical", title: `${h.action} failure rate high`, detail: `${h.failed}/${h.completed + h.failed} failed`, entities: h.failures.map((f) => f.targetId ?? "?"), fingerprint: fp(`failrate:${h.action}`) });
    }
    if (h.stuck.length > 0) {
      out.push({ id: `stuck:${h.action}`, severity: "warn", title: `${h.action} job stuck`, detail: `${h.stuck.length} started with no terminal event`, entities: h.stuck.map((s) => s.targetId ?? "?"), fingerprint: fp(`stuck:${h.action}`) });
    }
  }
  if (i.fallbackRate > i.thresholds.fallbackRate) {
    out.push({ id: "fallback", severity: "warn", title: "Brief fallback rate high", detail: `${Math.round(i.fallbackRate * 100)}% of briefs fell back to deterministic`, entities: [], fingerprint: fp("fallback") });
  }
  for (const b of i.budgets) {
    if (b.pctConsumed >= i.thresholds.budgetCritPct) {
      out.push({ id: `budget:${b.provider}`, severity: "critical", title: `${b.provider} budget ${Math.round(b.pctConsumed)}% consumed`, detail: `$${b.spentUsd.toFixed(2)}/$${b.budgetUsd.toFixed(2)}, ~${b.etaDays?.toFixed(1) ?? "?"}d left`, entities: [], fingerprint: fp(`budget:${b.provider}`) });
    } else if (b.pctConsumed >= i.thresholds.budgetWarnPct) {
      out.push({ id: `budget:${b.provider}`, severity: "warn", title: `${b.provider} budget ${Math.round(b.pctConsumed)}% consumed`, detail: `$${b.spentUsd.toFixed(2)}/$${b.budgetUsd.toFixed(2)}`, entities: [], fingerprint: fp(`budget:${b.provider}`) });
    }
  }
  return out;
}
