// supabase/functions/_shared/relevanceBackbone.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { gateThreshold, passesGate, deriveLabel, lacFromGeography } from "./relevanceBackbone.ts";

Deno.test("gateThreshold: strong query clamps to ABS_FLOOR", () => assertEquals(gateThreshold(0.90), 0.50));
Deno.test("gateThreshold: mid query rides topCos-0.18", () => assertEquals(Number(gateThreshold(0.62).toFixed(2)), 0.44));
Deno.test("gateThreshold: weak query clamps to MIN_FLOOR", () => assertEquals(gateThreshold(0.40), 0.32));

Deno.test("passesGate: on-topic real vector passes", () =>
  assertEquals(passesGate({ cosine: 0.80, citations: 57, year: 2018, topCos: 0.80, isSynthetic: false, fts: 0 }), true));
Deno.test("passesGate: off-topic mega-cite fails (Frames of Mind)", () =>
  assertEquals(passesGate({ cosine: 0.385, citations: 13737, year: 1983, topCos: 0.80, isSynthetic: false, fts: 0 }), false));
Deno.test("passesGate: near-dup mega-cite low-cite fails", () =>
  assertEquals(passesGate({ cosine: 0.447, citations: 13, year: 1983, topCos: 0.80, isSynthetic: false, fts: 0 }), false));
Deno.test("passesGate: seminal pre-2020 just under floor escapes (default delta 0.10)", () =>
  assertEquals(passesGate({ cosine: 0.42, citations: 1029, year: 2010, topCos: 0.80, isSynthetic: false, fts: 0 }), true));
Deno.test("passesGate: tightened escape (0.05) rejects the 0.42 borderline", () =>
  assertEquals(passesGate({ cosine: 0.42, citations: 1029, year: 2010, topCos: 0.80, isSynthetic: false, fts: 0 }, 0.05), false));
Deno.test("passesGate: synthetic channel always passes", () =>
  assertEquals(passesGate({ cosine: 0.55, citations: 0, year: 2022, topCos: 0.80, isSynthetic: true, fts: 0 }), true));
Deno.test("passesGate: fts-only (cos<=0) passes", () =>
  assertEquals(passesGate({ cosine: 0, citations: 0, year: 2021, topCos: 0.80, isSynthetic: false, fts: 0.4 }), true));

Deno.test("lacFromGeography: Mexico → true", () => assertEquals(lacFromGeography(["Mexico", "LAC"]), true));
Deno.test("lacFromGeography: USA only → false", () => assertEquals(lacFromGeography(["United States"]), false));
Deno.test("lacFromGeography: empty → false", () => assertEquals(lacFromGeography([]), false));

Deno.test("deriveLabel: strong cosine + LAC → direct-lac", () =>
  assertEquals(deriveLabel({ cosine: 0.80, topCos: 0.80, citations: 57, year: 2018, lac: true }), "direct-lac"));
Deno.test("deriveLabel: strong cosine + non-LAC → direct-global", () =>
  assertEquals(deriveLabel({ cosine: 0.80, topCos: 0.80, citations: 57, year: 2018, lac: false }), "direct-global"));
Deno.test("deriveLabel: adjacency band → indirect", () =>
  assertEquals(deriveLabel({ cosine: 0.45, topCos: 0.80, citations: 10, year: 2019, lac: false }), "indirect"));
Deno.test("deriveLabel: below adjacency → excluded", () =>
  assertEquals(deriveLabel({ cosine: 0.385, topCos: 0.80, citations: 13737, year: 1983, lac: false }), "excluded"));
Deno.test("deriveLabel: seminal escape stays direct-global", () =>
  assertEquals(deriveLabel({ cosine: 0.42, topCos: 0.80, citations: 1029, year: 2010, lac: false }), "direct-global"));
Deno.test("gateThreshold: non-finite topCos → MIN_FLOOR (NaN treated as ABS_FLOOR before REL_DELTA clamp)", () => assertEquals(gateThreshold(NaN), 0.32));
Deno.test("passesGate: negative cosine treated as fts-only/no-vector → passes", () =>
  assertEquals(passesGate({ cosine: -0.01, citations: 0, year: 2021, topCos: 0.80, isSynthetic: false, fts: 0 }), true));

import { rerankHybrid, backboneConfig } from "./rerank.ts";

Deno.test("backboneConfig: master flag enables both gates", () => {
  Deno.env.set("RELEVANCE_BACKBONE", "1");
  const c = backboneConfig();
  Deno.env.delete("RELEVANCE_BACKBONE");
  assertEquals(c.gateJoint && c.gateFloors, true);
});

Deno.test("backboneConfig: sub-flags independent + escape tighten", () => {
  Deno.env.set("RB_GATE_JOINT", "1");
  Deno.env.set("RB_ESCAPE_TIGHT", "1");
  const c = backboneConfig();
  Deno.env.delete("RB_GATE_JOINT");
  Deno.env.delete("RB_ESCAPE_TIGHT");
  assertEquals([c.gateJoint, c.gateFloors, c.escapeDelta], [true, false, 0.05]);
});

Deno.test("rerankHybrid + RB_GATE_JOINT: off-topic mega-cite sinks below on-topic LAC RCT", () => {
  const papers = [
    { id: "offtopic", similarity: 0.385, citation_count: 13737, year: 1983, sms_level: 0, classification: "direct-global", geography: [], _retrievalSource: "vector" },
    { id: "dehoyos", similarity: 0.795, citation_count: 57, year: 2018, sms_level: 5, classification: "direct-lac", geography: ["Mexico", "LAC"], _retrievalSource: "vector" },
  ];
  Deno.env.set("RB_GATE_JOINT", "1");
  const out = rerankHybrid(papers, { regions: ["LAC"] }, "returns to schooling information", ["causal", "foundational", "lac"], 50);
  Deno.env.delete("RB_GATE_JOINT");
  assertEquals(out.findIndex((p) => p.id === "dehoyos") < out.findIndex((p) => p.id === "offtopic"), true);
});

import { rerankUnified, BOOST_PROFILES, orderByChannel } from "./rerank.ts";

Deno.test("rerankUnified: off-topic mega-cite sinks below on-topic LAC RCT (boost, no drop)", () => {
  const papers = [
    { id: "off", realCosine: 0.385, citation_count: 13737, year: 1983, sms_level: 0, geography: [] },
    { id: "dehoyos", realCosine: 0.772, citation_count: 57, year: 2018, sms_level: 5, geography: ["Mexico","LAC"] },
  ];
  const out = rerankUnified(papers, { regions: ["LAC"] }, ["causal","foundational"], "moderate");
  assertEquals(out[0].id, "dehoyos");
  assertEquals(out.length, 2);          // NOT dropped — still present
  assertEquals(out[1].id, "off");
});

Deno.test("rerankUnified: non-region paper NOT dropped, only loses the region boost", () => {
  const papers = [
    { id: "global", realCosine: 0.70, citation_count: 10, year: 2021, sms_level: 3, geography: ["United States"] },
    { id: "lac", realCosine: 0.70, citation_count: 10, year: 2021, sms_level: 3, geography: ["Brazil","LAC"] },
  ];
  const out = rerankUnified(papers, { regions: ["LAC"] }, ["causal"], "moderate");
  assertEquals(out.length, 2);
  assertEquals(out[0].id, "lac");
});

Deno.test("BOOST_PROFILES has the three named profiles", () => {
  assertEquals(Object.keys(BOOST_PROFILES).sort(), ["aggressive","conservative","moderate"]);
});

Deno.test("orderByChannel: single causal → by SMS desc", () => {
  const ev = [{ id: "a", sms_level: 3, _unifiedScore: 0.9 }, { id: "b", sms_level: 5, _unifiedScore: 0.5 }];
  assertEquals(orderByChannel(ev, ["causal"]).map((p) => p.id), ["b", "a"]);
});
Deno.test("orderByChannel: single foundational → by citations desc", () => {
  const ev = [{ id: "a", citation_count: 10, _unifiedScore: 0.9 }, { id: "b", citation_count: 999, _unifiedScore: 0.5 }];
  assertEquals(orderByChannel(ev, ["foundational"]).map((p) => p.id), ["b", "a"]);
});
Deno.test("orderByChannel: single recent → by year desc", () => {
  const ev = [{ id: "a", year: 2018, _unifiedScore: 0.9 }, { id: "b", year: 2024, _unifiedScore: 0.5 }];
  assertEquals(orderByChannel(ev, ["recent"]).map((p) => p.id), ["b", "a"]);
});
Deno.test("orderByChannel: multi-channel → by unified score", () => {
  const ev = [{ id: "a", sms_level: 5, _unifiedScore: 0.4 }, { id: "b", sms_level: 1, _unifiedScore: 0.9 }];
  assertEquals(orderByChannel(ev, ["causal","foundational"]).map((p) => p.id), ["b", "a"]);
});
