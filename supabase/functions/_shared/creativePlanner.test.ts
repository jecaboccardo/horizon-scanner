import { assertEquals } from "jsr:@std/assert";
import { jaccard, surname, verifyAgainst, selectAdds } from "./creativePlanner.ts";
import type { GroundedCandidate } from "./creativePlanner.ts";
const cand = (id: string, similarity: number, via = "subq"): GroundedCandidate =>
  ({ id, title: id, authors: ["A. Author"], year: null, citationCount: null, smsLevel: null, venue: null, similarity, via });

Deno.test("surname extracts last token, lowercased", () => {
  assertEquals(surname("Esther Duflo"), "duflo");
  assertEquals(surname("Clotfelter"), "clotfelter");
  assertEquals(surname(""), "");
});

Deno.test("jaccard token overlap", () => {
  assertEquals(jaccard("teacher retention bonuses", "teacher retention bonuses"), 1);
  assertEquals(jaccard("teacher bonuses", "unrelated climate paper") < 0.1, true);
});

Deno.test("verifyAgainst — strong title match resolves", () => {
  const cands = [{ id: "x", title: "Effective Teacher Retention Bonuses", authors: ["Matthew Wiswall"], year: 2013 }];
  const w = { title: "Effective Teacher Retention Bonuses", description: "", author: "Wiswall", year: 2013 };
  const v = verifyAgainst(cands, w);
  assertEquals(v?.by, "title");
});

Deno.test("verifyAgainst — fabricated name evaporates", () => {
  const cands = [{ id: "x", title: "Climate adaptation in coastal cities", authors: ["A. Other"], year: 2019 }];
  const w = { title: "Teacher pay reform", description: "teacher salary RCT", author: "Smith", year: 2015 };
  assertEquals(verifyAgainst(cands, w), null);
});

Deno.test("selectAdds — caps, dedups against base table, records all drops", () => {
  const candidates = [cand("a", 0.7), cand("b", 0.65), cand("inbase", 0.8), cand("lowrel", 0.40)];
  const { added, dropped } = selectAdds(candidates, new Set(["inbase"]), 1, 0.50);
  assertEquals(added.map((a) => a.id), ["a"]);                                  // cap 1, highest survivor
  assertEquals(dropped.find((d) => d.id === "inbase")?.reason, "already_in_table");
  assertEquals(dropped.find((d) => d.id === "lowrel")?.reason, "low_relevance");
  assertEquals(dropped.find((d) => d.id === "b")?.reason, "over_cap");          // passed rules but over cap
});

Deno.test("selectAdds — content-empty stub (no abstract, no authors) is dropped as low_quality", () => {
  const stub: GroundedCandidate = { id: "stub", title: "Sherwin Rosen Award", authors: [], year: null, citationCount: null, smsLevel: null, venue: null, similarity: 0.9, via: "subq", abstract: null };
  const real: GroundedCandidate = { id: "real", title: "Information and schooling returns", authors: ["R. Jensen"], year: 2010, citationCount: 100, smsLevel: 5, venue: "QJE", similarity: 0.7, via: "subq", abstract: "A field experiment on perceived returns to schooling..." };
  const { added, dropped } = selectAdds([stub, real], new Set(), 15, 0.50);
  assertEquals(added.map((a) => a.id), ["real"]);                 // stub excluded despite higher similarity
  assertEquals(dropped.find((d) => d.id === "stub")?.reason, "low_quality");
});
