import { assertAlmostEquals, assertEquals } from "jsr:@std/assert";
import { computeBudget, computeCost, providerOf } from "./cost.ts";

const NOW = Date.parse("2026-07-10T12:00:00Z");
const call = (o: Partial<any>) => ({
  model: o.model!,
  operation: o.operation!,
  tenant_id: o.tenant_id ?? "u1",
  user_id: null,
  ts: o.ts ?? "2026-07-10T11:00:00Z",
  tokens_in: o.tokens_in ?? 0,
  tokens_out: o.tokens_out ?? 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  thinking_tokens: o.thinking_tokens ?? 0,
});

Deno.test("providerOf maps model → provider", () => {
  assertEquals(providerOf("gemini-pro-latest"), "gemini");
  assertEquals(providerOf("claude-opus-4-8"), "claude");
  assertEquals(providerOf("qwen2.5:14b-synthesis"), "self-hosted");
});

Deno.test("computeCost totals by provider/model/user", () => {
  const rows = [
    call({ model: "gemini-pro-latest", operation: "jel_draft", tokens_out: 1_000_000 }),
    call({ model: "gemini-flash-latest", operation: "brief_synthesis", tokens_out: 1_000_000 }),
  ];
  const c = computeCost(rows as any, NOW);
  assertAlmostEquals(c.total, 12.5, 1e-6);
  assertAlmostEquals(c.byProvider["gemini"], 12.5, 1e-6);
});

Deno.test("computeBudget: consumed %, remaining, ETA", () => {
  const b = computeBudget({ gemini: 50 }, { gemini: 200 }, 10);
  const g = b.find((x) => x.provider === "gemini")!;
  assertAlmostEquals(g.pctConsumed, 25, 1e-6);
  assertAlmostEquals(g.remainingUsd, 150, 1e-6);
  assertAlmostEquals(g.burnPerDay, 5, 1e-6);
  assertAlmostEquals(g.etaDays!, 30, 1e-6);
});
