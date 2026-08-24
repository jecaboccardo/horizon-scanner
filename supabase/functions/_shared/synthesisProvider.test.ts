import { assertEquals, assertThrows } from "jsr:@std/assert";
import {
  normalizeProviderInput,
  callSynthProvider,
  type ProviderConfig,
} from "./synthesisProvider.ts";
import { decideConfigFromRows, makeClaudeClient, makeProviderClient, resolveSynthClientForUser, ProviderCallError } from "./synthesisProvider.ts";

// Hard-error contract: a 401/403/429 from EITHER provider must throw ProviderCallError
// with isKeyFailure=true (so a BYOK key failure blocks generation — never a silent
// fallback). Regression guard for the BYOK-Gemini swallow-to-Ollama bug.
for (const provider of ["gemini", "claude"] as const) {
  Deno.test(`callSynthProvider throws isKeyFailure on 401 (${provider})`, async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response("unauthorized", { status: 401 }))) as typeof fetch;
    try {
      const cfg: ProviderConfig = { provider, apiKey: "bad", model: provider === "claude" ? "claude-sonnet-4-6" : "gemini-2.5-flash", byok: true };
      let caught: unknown = null;
      try { await callSynthProvider("s", "u", { expectJson: false }, cfg); } catch (e) { caught = e; }
      assertEquals(caught instanceof ProviderCallError, true);
      assertEquals((caught as ProviderCallError).isKeyFailure, true);
    } finally { globalThis.fetch = orig; }
  });
}

Deno.test("makeProviderClient tags the provider from cfg (gemini BYOK routes through dispatcher)", () => {
  const g = makeProviderClient({ provider: "gemini", apiKey: "k", model: "gemini-2.5-flash", byok: true });
  assertEquals(g.provider, "gemini");
  assertEquals(g.byok, true);
});

Deno.test("normalizeProviderInput rejects unknown provider", () => {
  assertThrows(() => normalizeProviderInput({ provider: "openai", apiKey: "xxxxxxxx" }));
});

Deno.test("normalizeProviderInput defaults the Claude model to Sonnet", () => {
  const n = normalizeProviderInput({ provider: "claude", apiKey: "sk-ant-xxxxxxxx" });
  assertEquals(n.provider, "claude");
  assertEquals(n.model, "claude-sonnet-4-6");
});

Deno.test("normalizeProviderInput rejects an off-list Claude model", () => {
  assertThrows(() => normalizeProviderInput({ provider: "claude", apiKey: "kkkkkkkk", model: "claude-2" }));
});

Deno.test("callSynthProvider maps a Claude response to JSON", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL, _init?: RequestInit) =>
    Promise.resolve(new Response(
      JSON.stringify({ content: [{ type: "text", text: '{"ok":true}' }], usage: { input_tokens: 3, output_tokens: 5 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ))) as typeof fetch;
  try {
    const cfg: ProviderConfig = { provider: "claude", apiKey: "k", model: "claude-sonnet-4-6" };
    const out = await callSynthProvider("system", "user", { expectJson: true }, cfg);
    assertEquals(out.ok, true);
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("callSynthProvider maps a Gemini response to text", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL) =>
    Promise.resolve(new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "hello" }] } }], usageMetadata: {} }),
      { status: 200 },
    ))) as typeof fetch;
  try {
    const cfg: ProviderConfig = { provider: "gemini", apiKey: "k", model: "gemini-2.5-flash" };
    const out = await callSynthProvider("s", "u", { expectJson: false }, cfg);
    assertEquals(out, "hello");
  } finally {
    globalThis.fetch = orig;
  }
});

Deno.test("decideConfigFromRows returns null when no active grant", () => {
  assertEquals(decideConfigFromRows(null, null, "decrypted"), null);
});

Deno.test("decideConfigFromRows returns BYOK config for an active grant", () => {
  const key = { id: "k1", provider: "claude", model: "claude-opus-4-8", owner_user_id: "rafael", enc_key: "x", enc_iv: "y" };
  // deno-lint-ignore no-explicit-any
  const cfg = decideConfigFromRows(key as any, { id: "g1", key_id: "k1" } as any, "plain-key");
  assertEquals(cfg?.provider, "claude");
  assertEquals(cfg?.apiKey, "plain-key");
  assertEquals(cfg?.byok, true);
  assertEquals(cfg?.ownerId, "rafael");
});

Deno.test("ClaudeClient.generateStructuredBrief returns parsed sections", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response(
    JSON.stringify({ content: [{ type: "text", text: '{"summaryBullets":["a"],"warnings":[]}' }], usage: {} }),
    { status: 200 },
  ))) as typeof fetch;
  try {
    const client = makeClaudeClient({ provider: "claude", apiKey: "k", model: "claude-sonnet-4-6", byok: true });
    const sections = await client.generateStructuredBrief({
      query: "q", evidenceRows: [], persona: "policy",
      coverage: { universeCount: 0, retrievedCount: 0, admissibleCount: 0, evidenceCount: 0, signalCount: 0 },
      promptInputs: {},
    });
    assertEquals(Array.isArray(sections.summaryBullets), true);
  } finally {
    globalThis.fetch = orig;
  }
});
