import { assertAlmostEquals } from "jsr:@std/assert";
import { priceCall } from "./pricing.ts";

Deno.test("prices fresh input + output at model rate", () => {
  assertAlmostEquals(priceCall({ model: "gemini-pro-latest", tokens_in: 1_000_000, tokens_out: 0, cache_read_tokens: 0, cache_write_tokens: 0, thinking_tokens: 0 }), 1.25, 1e-9);
});
Deno.test("thinking tokens bill at the OUTPUT rate", () => {
  assertAlmostEquals(priceCall({ model: "gemini-pro-latest", tokens_in: 0, tokens_out: 0, cache_read_tokens: 0, cache_write_tokens: 0, thinking_tokens: 1_000_000 }), 10, 1e-9);
});
Deno.test("claude cache reads bill at 0.1x input, writes 1.25x", () => {
  const usd = priceCall({ model: "claude-sonnet-4-6", tokens_in: 2_000_000, tokens_out: 0, cache_read_tokens: 1_000_000, cache_write_tokens: 1_000_000, thinking_tokens: 0 });
  assertAlmostEquals(usd, 4.05, 1e-9);
});
Deno.test("unknown model prices to 0 (self-hosted / embeddings)", () => {
  assertAlmostEquals(priceCall({ model: "qwen2.5:14b-synthesis", tokens_in: 5_000_000, tokens_out: 5_000_000, cache_read_tokens: 0, cache_write_tokens: 0, thinking_tokens: 0 }), 0, 1e-9);
});
