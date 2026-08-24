import { assertEquals, assert } from "jsr:@std/assert";
import { enforceCitationIntegrity } from "./citationIntegrity.ts";

const PAPERS = [
  { workId: "10.1017/lar.2023.3", authors: ["Cesar B. Martinez-Alvarez", "José María Rodriguez-Valadez"], year: 2023 },
  { workId: "10.1177/00104140211047410", authors: ["Alicia Dailey Cooperman"], year: 2022 },
  { workId: "10.1016/j.jpubeco.2021.104579", authors: ["Philip Keefer", "Carlos Scartascini", "Razvan Vlaicu"], year: 2022 },
  { workId: "10.1086/590458", authors: ["Christine Möser"], year: 2008 },
  { workId: "10.18235/0008261", authors: ["Inter-American Development Bank"], year: 2008 },
  { workId: "10.1257/pol.20220066", authors: ["Alejandro del Valle"], year: 2024 },
];

Deno.test("wrong author name next to a valid bracket is rewritten from works.authors", () => {
  const body =
    "Evidence from Mexico City demonstrates local effects (Flores-Macías and Sánchez-Talanquer 2023) [10.1017/lar.2023.3].";
  const { body: out, stats } = enforceCitationIntegrity(body, PAPERS);
  assertEquals(stats.renamed, 1);
  assert(out.includes("(Martinez-Alvarez and Rodriguez-Valadez 2023) [10.1017/lar.2023.3]"), out);
  assert(!out.includes("Flores-Macías"), out);
});

Deno.test("narrative wrong name before bracket is rewritten", () => {
  const body =
    "Flores-Macías and Zarkin (2023) [10.1017/lar.2023.3] show that disaster response shapes vote shares.";
  const { body: out, stats } = enforceCitationIntegrity(body, PAPERS);
  assertEquals(stats.renamed, 1);
  assert(out.startsWith("Martinez-Alvarez and Rodriguez-Valadez (2023) [10.1017/lar.2023.3]"), out);
});

Deno.test("correct names are left untouched (diacritics-insensitive)", () => {
  const body =
    "Difference-in-differences analysis in Madagascar (Möser 2008) [10.1086/590458] shows patronage effects. " +
    "Cooperman (2022) [10.1177/00104140211047410] documents electoral cycles.";
  const { body: out, stats } = enforceCitationIntegrity(body, PAPERS);
  assertEquals(stats.renamed, 0);
  assertEquals(out, body);
});

Deno.test("three-plus authors render as 'et al.'", () => {
  const body = "As shown by Wrongperson and Fake (2022) [10.1016/j.jpubeco.2021.104579], trust matters.";
  const { body: out, stats } = enforceCitationIntegrity(body, PAPERS);
  assertEquals(stats.renamed, 1);
  assert(out.includes("Keefer et al. (2022) [10.1016/j.jpubeco.2021.104579]"), out);
});

Deno.test("bracketless parenthetical phantom matching no evidence work is removed", () => {
  const body = "Prevention faces political barriers (Cole et al. 2012), though electorates stay attentive.";
  const { body: out, stats } = enforceCitationIntegrity(body, PAPERS);
  assertEquals(stats.removed, 1);
  assert(!out.includes("Cole"), out);
  assert(out.includes("barriers, though"), out);
});

Deno.test("bracketless parenthetical citation matching an evidence work is auto-linked", () => {
  const body = "Politicians exploit drought ambiguity for electoral gain (Cooperman 2022).";
  const { body: out, stats } = enforceCitationIntegrity(body, PAPERS);
  assertEquals(stats.linked, 1);
  assert(out.includes("(Cooperman 2022) [10.1177/00104140211047410]"), out);
});

Deno.test("bracketless narrative citation matching an evidence work is auto-linked", () => {
  const body = "Möser (2008) examines how elections induce governments to deviate from poverty goals.";
  const { body: out, stats } = enforceCitationIntegrity(body, PAPERS);
  assertEquals(stats.linked, 1);
  assert(out.includes("Möser (2008) [10.1086/590458]"), out);
});

Deno.test("bracketless narrative phantom is left in place but counted unresolved", () => {
  const body = "Ashworth et al. (2019) argue accountability is structurally limited.";
  const { body: out, stats } = enforceCitationIntegrity(body, PAPERS);
  assertEquals(stats.unresolved, 1);
  assertEquals(stats.removed, 0);
  assert(out.includes("Ashworth et al. (2019)"), out);
});

Deno.test("ambiguous surname+year (two Keefer 2022 papers) is never removed", () => {
  const papers = [
    ...PAPERS,
    { workId: "10.18235/0004212", authors: ["Keefer, Philip", "Scartascini, Carlos", "Vlaicu, Razvan"], year: 2022 },
  ];
  const body = "Mistrust dampens demand for investment (Keefer et al. 2022).";
  const { body: out, stats } = enforceCitationIntegrity(body, papers);
  assertEquals(stats.removed, 0);
  assertEquals(stats.unresolved, 1);
  assert(out.includes("(Keefer et al. 2022)"), out);
});

Deno.test("display-string authors still match (stringified-authors shape)", () => {
  const papers = [{ workId: "10.1093/ei/cbg023", authors: "Thomas A. Garrett, Russell S. Sobel", year: 2003 }];
  const body = "Relief allocation follows political influence (Garrett and Sobel 2003).";
  const { body: out, stats } = enforceCitationIntegrity(body, papers);
  assertEquals(stats.removed, 0);
  assertEquals(stats.linked, 1);
  assert(out.includes("[10.1093/ei/cbg023]"), out);
});

Deno.test("semicolon list: every item resolves — each gets its own [workId], list not deleted", () => {
  const body = "Several studies agree (Möser 2008; Cooperman 2022) on timing effects.";
  const { body: out, stats } = enforceCitationIntegrity(body, PAPERS);
  assertEquals(stats.linked, 2);
  assert(out.includes("(Möser 2008 [10.1086/590458]; Cooperman 2022 [10.1177/00104140211047410])"), out);
});

Deno.test("semicolon list: unresolved item is left as-is, resolved item still gets linked", () => {
  const body = "Findings vary (Möser 2008; Totally Fabricated 2019) across contexts.";
  const { body: out, stats } = enforceCitationIntegrity(body, PAPERS);
  assertEquals(stats.linked, 1);
  assertEquals(stats.unresolved, 1);
  assert(out.includes("Möser 2008 [10.1086/590458]"), out);
  assert(out.includes("Totally Fabricated 2019"), out); // left in place, not deleted
});

Deno.test("semicolon list: zero items resolve — whole parenthetical left untouched", () => {
  const body = "Several studies agree (Nobody Real 2008; Nobody Else 2000) on timing effects.";
  const { body: out, stats } = enforceCitationIntegrity(body, PAPERS);
  assertEquals(stats.linked, 0);
  assertEquals(stats.unresolved, 2);
  assertEquals(out, body);
});

Deno.test("semicolon list: compound multi-word surnames + '&' pairs resolve", () => {
  const papers = [
    ...PAPERS,
    { workId: "10.1000/garcia-arias.2024", authors: ["García Arias"], year: 2024 },
    { workId: "10.1000/hasbun-sousa.2018", authors: ["Hasbun", "Sousa"], year: 2018 },
  ];
  const body = "Recent work confirms this (García Arias, 2024; Hasbun & Sousa, 2018).";
  const { body: out, stats } = enforceCitationIntegrity(body, papers);
  assertEquals(stats.linked, 2);
  assert(out.includes("[10.1000/garcia-arias.2024]"), out);
  assert(out.includes("[10.1000/hasbun-sousa.2018]"), out);
});

Deno.test("statistical parentheticals are not treated as citations", () => {
  const body = "The sample covers most municipalities (N = 2012) in the panel.";
  const { body: out, stats } = enforceCitationIntegrity(body, PAPERS);
  assertEquals(out, body);
  assertEquals(stats.removed, 0);
});

Deno.test("particle surnames match via reverse containment", () => {
  const body = "Valle (2024) shows indexed funds save lives.";
  const { body: out, stats } = enforceCitationIntegrity(body, PAPERS);
  assertEquals(stats.linked, 1);
  assert(out.includes("[10.1257/pol.20220066]"), out);
});

Deno.test("already-linked citations are not double-bracketed", () => {
  const body = "Cooperman (2022) [10.1177/00104140211047410] documents electoral cycles.";
  const { body: out, stats } = enforceCitationIntegrity(body, PAPERS);
  assertEquals(stats.linked, 0);
  assertEquals(out, body);
});
