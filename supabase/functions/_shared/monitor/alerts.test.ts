import { assertEquals } from "jsr:@std/assert";
import { computeAlerts } from "./alerts.ts";
import type { ActionHealth } from "./health.ts";
import type { BudgetBurn } from "./cost.ts";

const health = (o: Partial<ActionHealth>): ActionHealth => ({ action: "paper", attempts: 0, completed: 0, failed: 0, successRate: null, stuck: [], failures: [], p50: null, p95: null, ...o });

Deno.test("fires failure-rate, stuck, and budget alerts with fingerprints", () => {
  const alerts = computeAlerts({
    health: [
      health({ action: "brief", completed: 2, failed: 8, successRate: 0.2 }),
      health({ action: "paper", stuck: [{ targetId: "p3", startedTs: "2026-07-10T11:30:00Z", ageMs: 1_800_000 }] }),
    ],
    fallbackRate: 0.6,
    budgets: [{ provider: "gemini", budgetUsd: 200, spentUsd: 190, remainingUsd: 10, pctConsumed: 95, burnPerDay: 20, etaDays: 0.5 } as BudgetBurn],
    thresholds: { failRate: 0.5, fallbackRate: 0.3, budgetWarnPct: 80, budgetCritPct: 95 },
  });
  const ids = alerts.map((a) => a.id).sort();
  assertEquals(ids.includes("failrate:brief"), true);
  assertEquals(ids.includes("stuck:paper"), true);
  assertEquals(ids.includes("fallback"), true);
  assertEquals(ids.includes("budget:gemini"), true);
  assertEquals(alerts.find((a) => a.id === "budget:gemini")!.severity, "critical");
  assertEquals(typeof alerts[0].fingerprint, "string");
});

Deno.test("info-level activity alerts: one per roster user, per-day fingerprint, no problem-alert coupling", () => {
  const alerts = computeAlerts({
    health: [],
    fallbackRate: 0,
    budgets: [],
    thresholds: { failRate: 0.5, fallbackRate: 0.3, budgetWarnPct: 80, budgetCritPct: 95 },
    day: "2026-07-15",
    activity: [
      { user: "sbauhoff", firstTs: "2026-07-15T09:12:41Z", summary: "search.submitted×2, paper.generation_completed" },
      { user: "dkaplan", firstTs: "2026-07-15T12:06:28Z", summary: "search.submitted" },
    ],
  });
  assertEquals(alerts.length, 2);
  const seb = alerts.find((a) => a.id === "activity:sbauhoff")!;
  assertEquals(seb.severity, "info");
  assertEquals(seb.title, "sbauhoff active today");
  assertEquals(seb.fingerprint, "activity:sbauhoff|2026-07-15");
  assertEquals(seb.detail.includes("09:12 UTC"), true);
});
