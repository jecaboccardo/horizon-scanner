// supabase/functions/_shared/evidenceFloors.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyBalancedIndirectFloor, applyFoundationalCiteFloor, applyRegionFloor } from "./evidenceFloors.ts";

Deno.test("balanced indirect floor: swaps direct for indirect up to floor", () => {
  const composite = [
    { id: "d1", classification: "direct-global" }, { id: "d2", classification: "direct-global" },
    { id: "i1", classification: "indirect" }, { id: "i2", classification: "indirect" },
  ];
  const evidence = [{ id: "d1", classification: "direct-global" }, { id: "d2", classification: "direct-global" }];
  applyBalancedIndirectFloor(evidence, composite, { floor: 2 });
  const ids = new Set(evidence.map((p) => p.id));
  assertEquals(ids.has("i1") && ids.has("i2"), true);
  assertEquals(evidence.length, 2);
});

Deno.test("foundational floor gate OFF: injects top-cited on-topic even low cosine (the bug)", () => {
  const composite = [
    { id: "lo", citation_count: 9000, similarity: 0.30, year: 1983, classification: "direct-global", _retrievalSource: "vector" },
    { id: "keep", citation_count: 10, similarity: 0.8, year: 2019, classification: "direct-global", _retrievalSource: "vector" },
  ];
  const evidence = [{ id: "keep", citation_count: 10, similarity: 0.8, year: 2019, classification: "direct-global", _retrievalSource: "vector" }];
  applyFoundationalCiteFloor(evidence, composite, { gateOn: false, escapeDelta: 0.10, topCos: 0.8, floorN: 10, minCites: 75 });
  assertEquals(evidence.some((p) => p.id === "lo"), true);
});

Deno.test("foundational floor gate ON: blocks low-cosine mega-cite injection", () => {
  const composite = [
    { id: "lo", citation_count: 9000, similarity: 0.30, year: 1983, classification: "direct-global", _retrievalSource: "vector" },
    { id: "keep", citation_count: 10, similarity: 0.8, year: 2019, classification: "direct-global", _retrievalSource: "vector" },
  ];
  const evidence = [{ id: "keep", citation_count: 10, similarity: 0.8, year: 2019, classification: "direct-global", _retrievalSource: "vector" }];
  applyFoundationalCiteFloor(evidence, composite, { gateOn: true, escapeDelta: 0.10, topCos: 0.8, floorN: 10, minCites: 75 });
  assertEquals(evidence.some((p) => p.id === "lo"), false);
});

Deno.test("region floor: fills in-region up to 60% cap, never evicts canon/indirect", () => {
  const composite = [
    { id: "us1", geography: ["United States"], citation_count: 5, classification: "direct-global", similarity: 0.7, year: 2021 },
    { id: "mx1", geography: ["Mexico"], citation_count: 5, classification: "direct-global", similarity: 0.7, year: 2021 },
    { id: "mx2", geography: ["Mexico"], citation_count: 5, classification: "direct-global", similarity: 0.7, year: 2021 },
  ];
  const evidence = [{ id: "us1", geography: ["United States"], citation_count: 5, classification: "direct-global", similarity: 0.7, year: 2021 }];
  applyRegionFloor(evidence, composite, { regions: ["LAC"], cap: 2, gateOn: false, escapeDelta: 0.10, topCos: 0.7 });
  // cap=2 → floor=round(2*0.6)=1; one in-region already? us1 is NOT in-region; have=0<1 → add 1 mx, evict us1.
  assertEquals(evidence.some((p) => /mx/.test(p.id)), true);
});

Deno.test("region floor: never evicts foundational canon (cit>=75) even if out-of-region", () => {
  // Evidence has: canon (cit=500, US, evictable-by-region but protected), noncanon (cit=5, US, evictable).
  // Composite also has mx1 (in-region LAC). cap=3 → floor=round(3*0.6)=2, have=0.
  // Floor wants 2 in-region; toAdd=[mx1] (only 1 available). Loop evicts noncanon (not canon-protected).
  // Result: canon stays, noncanon gone, mx1 added. Canon must NOT be evicted.
  const composite = [
    { id: "canon", geography: ["United States"], citation_count: 500, classification: "direct-global", similarity: 0.7, year: 2005 },
    { id: "noncanon", geography: ["United States"], citation_count: 5, classification: "direct-global", similarity: 0.7, year: 2021 },
    { id: "mx1", geography: ["Mexico"], citation_count: 5, classification: "direct-global", similarity: 0.7, year: 2021 },
  ];
  const evidence = [
    { id: "canon", geography: ["United States"], citation_count: 500, classification: "direct-global", similarity: 0.7, year: 2005 },
    { id: "noncanon", geography: ["United States"], citation_count: 5, classification: "direct-global", similarity: 0.7, year: 2021 },
  ];
  applyRegionFloor(evidence, composite, { regions: ["LAC"], cap: 3, gateOn: false, escapeDelta: 0.10, topCos: 0.7 });
  // noncanon evicted to make room for mx1; canon (cit≥75) must NOT be evicted → both canon and mx1 present.
  assertEquals(evidence.some((p) => p.id === "canon"), true);
  assertEquals(evidence.some((p) => p.id === "mx1"), true);
});
