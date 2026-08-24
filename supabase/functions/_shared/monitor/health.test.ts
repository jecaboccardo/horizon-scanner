import { assertEquals } from "jsr:@std/assert";
import { computeCompletionHealth, eventActionKind, percentile } from "./health.ts";

Deno.test("maps event_type to action kind (chat before brief prefix)", () => {
  assertEquals(eventActionKind("search.submitted"), "search");
  assertEquals(eventActionKind("brief.chat"), "chat");
  assertEquals(eventActionKind("brief.generated"), "brief");
  assertEquals(eventActionKind("brief.regenerated"), "brief");
  assertEquals(eventActionKind("paper.generation_completed"), "paper");
  assertEquals(eventActionKind("paper.generation_started"), "paper");
  assertEquals(eventActionKind("subscription.created"), null);
});
Deno.test("percentile handles empty + interpolates", () => {
  assertEquals(percentile([], 50), null);
  assertEquals(percentile([10], 95), 10);
  assertEquals(percentile([1, 2, 3, 4], 50), 2.5);
});

const NOW = Date.parse("2026-07-10T12:00:00Z");
const row = (o: Partial<any>) => ({ id: o.id ?? "x", ts: o.ts!, event_type: o.event_type!, status: o.status ?? null, error: o.error ?? null, latency_ms: o.latency_ms ?? null, target_type: o.target_type ?? null, target_id: o.target_id ?? null });

Deno.test("computeCompletionHealth: success rate, failures with reason, stuck", () => {
  const rows = [
    row({ event_type: "paper.generation_started",   target_id: "p1", ts: "2026-07-10T11:00:00Z" }),
    row({ event_type: "paper.generation_completed", target_id: "p1", ts: "2026-07-10T11:02:00Z", status: "completed", latency_ms: 120000 }),
    row({ event_type: "paper.generation_started",   target_id: "p2", ts: "2026-07-10T11:10:00Z" }),
    row({ event_type: "paper.generation_failed",    target_id: "p2", ts: "2026-07-10T11:12:00Z", status: "failed", error: "gemini 500" }),
    row({ event_type: "paper.generation_started",   target_id: "p3", ts: "2026-07-10T11:30:00Z" }),
  ];
  const h = computeCompletionHealth(rows as any, NOW).find((x) => x.action === "paper")!;
  assertEquals(h.completed, 1);
  assertEquals(h.failed, 1);
  assertEquals(h.successRate, 0.5);
  assertEquals(h.failures[0].error, "gemini 500");
  assertEquals(h.stuck.map((s) => s.targetId), ["p3"]);
  assertEquals(h.p50, 120000);
});
