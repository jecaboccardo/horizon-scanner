import {
  callQwen, callGemini, normalizeCitations, fenceBodyToEvidence, extractCitedIds, wordCount, stripLeadingHeadingEcho,
  GEMINI_JEL_QA_MODEL,
} from "./jelPaperPipeline.ts";

const MIN_REWRITE_RETENTION = 0.7; // a rewrite shorter than 70% of the original is treated as truncated
const CITE_RETENTION = 0.6; // reject a rewrite that drops >40% of the section's [workId] citations (citation-integrity guard)

/** A body that doesn't end on terminal punctuation is treated as cut off mid-sentence. */
export function endsCleanly(text: string): boolean {
  return /[.!?'""')\]…]\s*$/.test(String(text ?? "").trim());
}

export type IssueType =
  | "unsupported" | "krisMismatch" | "daRevision"
  | "coherence" | "offTopic" | "corpusGap" | "truncated";

export interface Issue {
  type: IssueType;
  workId?: string;
  sentence?: string;
  detail: string;
  relatedSection?: string;
}

const num = (s: string | number | undefined) => String(s ?? "").replace(/^§/, "").trim();

export function aggregateIssues(
  findings: {
    auditReport?: { claims?: any[] };
    reviewReport?: { unsupportedClaims?: any[]; offTopicThemes?: any[] };
    krisReport?: { mismatches?: any[] };
    coherenceReport?: { issues?: any[] };
    daRevisions?: any[];
  },
  citedIn: Map<string, { section: string }>,
): Map<string, Issue[]> {
  const map = new Map<string, Issue[]>();
  const add = (section: string, issue: Issue) => {
    const k = num(section);
    if (!k || k === "critique" || k === "coherence") return;
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(issue);
  };

  for (const c of findings.auditReport?.claims ?? []) {
    if (c.verdict === "unsupported") {
      add(c.section, { type: "unsupported", workId: c.workId, sentence: c.sentence, detail: c.reason ?? "unsupported by source" });
    }
  }
  for (const u of findings.reviewReport?.unsupportedClaims ?? []) {
    add(u.section, { type: "unsupported", sentence: u.claim, detail: u.reason ?? "flagged by final review" });
  }
  for (const o of findings.reviewReport?.offTopicThemes ?? []) {
    add(o.section, { type: "offTopic", detail: `${o.theme}: ${o.reason ?? "not represented in corpus"}` });
  }
  for (const m of findings.krisReport?.mismatches ?? []) {
    const sec = citedIn.get(m.id)?.section;
    if (sec) add(sec, { type: "krisMismatch", workId: m.id, detail: `local "${m.localTitle}" vs OpenAlex "${m.oaTitle}"` });
  }
  for (const r of findings.daRevisions ?? []) {
    add(r.section, { type: "daRevision", detail: r.instruction });
  }
  for (const issue of findings.coherenceReport?.issues ?? []) {
    const secs = (issue.sections ?? []).map(num).filter(Boolean);
    for (const s of secs) {
      // Pairwise assumption: the coherence report emits exactly 2 sections per issue,
      // so the first "other" section is the related one. (3+ sections would only get the first.)
      const related = secs.find((x: string) => x !== s);
      add(s, { type: "coherence", detail: `${issue.type}: ${issue.description} → ${issue.suggestion ?? ""}`, relatedSection: related });
    }
  }
  return map;
}

function tokens(s: string): Set<string> {
  return new Set(String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t.length > 3));
}
function overlapScore(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0; for (const t of a) if (b.has(t)) shared++;
  return shared / Math.min(a.size, b.size);
}

export function selectCandidatePool(
  section: { heading: string; scope?: string },
  citedWorkIds: string[],
  papers: Array<{ workId: string; title?: string; abstract?: string | null }>,
  k = 8,
): string[] {
  const secTok = tokens(`${section.heading} ${section.scope ?? ""}`);
  const citedSet = new Set(citedWorkIds);
  const scored = papers
    .filter((p) => !citedSet.has(p.workId))
    .map((p) => ({ id: p.workId, s: overlapScore(secTok, tokens(`${p.title ?? ""} ${p.abstract ?? ""}`)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.id);
  return [...citedWorkIds, ...scored];
}

export function assignCorpusGaps(
  gaps: Array<{ workId: string; title?: string; abstract?: string | null; reason?: string }>,
  sections: Array<{ number: string | number; heading: string; scope?: string }>,
  threshold = 0.15,
): Array<{ workId: string; section: string | null; reason?: string }> {
  return gaps.map((g) => {
    const gTok = tokens(`${g.title ?? ""} ${g.abstract ?? ""}`);
    let best: { section: string; s: number } | null = null;
    for (const sec of sections) {
      const s = overlapScore(gTok, tokens(`${sec.heading} ${sec.scope ?? ""}`));
      if (!best || s > best.s) best = { section: String(sec.number), s };
    }
    return { workId: g.workId, reason: g.reason, section: best && best.s >= threshold ? best.section : null };
  });
}

export type TriageAction = "keep" | "soften" | "re-attribute" | "remove";
export interface TriageResult { action: TriageAction; targetWorkId?: string; rationale: string; }

// Batched (2026-07-09): all triageable issues in a section share the same
// section-scoped candidate pool, so they go out as ONE numbered-list call
// (≤TRIAGE_BATCH_SIZE items) instead of one call per issue — same shape as the
// claim-audit batching in jelPaperPipeline.runClaimAudit. The action MENU and
// its wording are IDENTICAL to the former per-issue prompt (do not retune here);
// only the I/O shape changed.
export function buildTriageBatchPrompt(
  issues: Issue[],
  candidatePool: Array<{ workId: string; title?: string; abstract?: string | null; card?: any }>,
): { system: string; user: string } {
  const system = [
    "You triage flagged claims in a JEL survey against the available evidence.",
    "You are given a NUMBERED LIST of flagged claims. All claims share the same",
    "CANDIDATE EVIDENCE pool. For EACH claim independently, return the SINGLE",
    "correct action — deletion is the LAST resort:",
    "  keep         — a cited paper supports the claim AS WRITTEN (false positive).",
    "  soften       — a paper supports only a WEAKER version (claim overstated).",
    "  re-attribute — a DIFFERENT in-set paper supports the claim (right claim, wrong paper) — give its workId.",
    "  remove       — NO in-set paper supports the claim's substance at all.",
    "Judge each claim ONLY on its own merits; never let one claim's action",
    "influence another claim's action.",
    'OUTPUT JSON only: { "triages": [ { "index": <the claim number>, "action": "...", "targetWorkId": "<id, only for re-attribute>", "rationale": "one sentence" } ] }',
    'Return exactly ONE entry per claim, using that claim\'s number as "index".',
  ].join("\n");
  const evidence = candidatePool.map((p) =>
    `[${p.workId}] "${p.title ?? ""}"\n  ${(p.card?.findingShort ? p.card.findingShort + " — " : "")}${(p.abstract ?? "").slice(0, 400)}`
  ).join("\n");
  const claimLines = issues.map((issue, i) =>
    `${i + 1}. FLAGGED CLAIM: "${issue.sentence ?? issue.detail}"\n   WHY FLAGGED: ${issue.detail}`
  ).join("\n");
  const user = [
    "FLAGGED CLAIMS:",
    claimLines,
    "",
    "CANDIDATE EVIDENCE (in-set papers — only these workIds may be targets):",
    evidence || "(none)",
    "",
    "Triage all claims now.",
  ].join("\n");
  return { system, user };
}

const ACTIONS = new Set(["keep", "soften", "re-attribute", "remove"]);
export function parseTriage(raw: any): TriageResult {
  const action = ACTIONS.has(raw?.action) ? raw.action as TriageAction : "keep";
  return { action, targetWorkId: raw?.targetWorkId || undefined, rationale: String(raw?.rationale ?? "") };
}

/**
 * Map a batched triage response back to per-issue results by 1-based "index".
 * Any missing / unparseable / out-of-range entry defaults to "keep" — identical
 * failure semantics to the old per-issue path, where a failed call produced
 * parseTriage(null) = keep (i.e. the issue is left alone, never destructively
 * acted on from a bad parse).
 */
export function parseTriageBatch(raw: any, count: number): TriageResult[] {
  const entries = Array.isArray(raw?.triages) ? raw.triages : Array.isArray(raw) ? raw : [];
  const out: TriageResult[] = Array.from({ length: count }, () => parseTriage(null));
  for (const e of entries) {
    const i = Number(e?.index) - 1;
    if (Number.isInteger(i) && i >= 0 && i < count) out[i] = parseTriage(e);
  }
  return out;
}

export interface PlannedAction { issue: Issue; triage?: TriageResult; }

export function buildRewritePrompt(
  section: { number: string | number; heading: string; body: string },
  actions: PlannedAction[],
  evidence: Array<{ workId: string; title?: string; abstract?: string | null; card?: any }>,
  relatedContext = "",
  addCitations: Array<{ workId: string; title?: string; abstract?: string | null }> = [],
): { system: string; user: string } {
  const isTruncationRepair = actions.some((a) => a.issue.type === "truncated");
  const system = (isTruncationRepair ? [
    "You are COMPLETING one section of a JEL survey whose stored text was CUT OFF mid-sentence (a generation defect). Produce the FULL, finished section.",
    "HARD RULES:",
    "- Preserve all existing valid content and citations, then CONTINUE and COMPLETE the section so it ends as a coherent, finished discussion. It is EXPECTED to be substantially longer than the cut-off input.",
    "- Also apply any other listed actions (coherence / citations) while completing.",
    "- Cite ONLY [workId]s present in the evidence below. Never invent papers/authors/years/workIds. Ground every empirical claim in the evidence.",
    "- Every retained citation MUST keep its [workId] tag in square brackets immediately after the author-year — NEVER reduce a cited claim to plain author-year text by dropping its [workId].",
    "- Return PLAIN PROSE only — no heading, no JSON, no markdown fences.",
  ] : [
    "You revise ONE section of a JEL survey to fix specific flagged issues. Apply ONLY the listed actions.",
    "HARD RULES:",
    "- Minimal change: address ONLY the listed issues; preserve all other valid content and citations verbatim.",
    "- Cite ONLY [workId]s present in the evidence below. Never invent papers/authors/years/workIds.",
    "- Every retained citation MUST keep its [workId] tag in square brackets immediately after the author-year — NEVER reduce a cited claim to plain author-year text by dropping its [workId].",
    "- soften = weaken the claim to exactly what the source supports (causal→associative, universal→qualified), keep the citation.",
    "- re-attribute = swap the citation to the given target [workId]; keep the sentence.",
    "- remove = delete the sentence/clause + its citation; repair surrounding flow.",
    "- add-citation = weave in the given [workId] grounded in its abstract; if it doesn't fit, OMIT it (do not force).",
    "- Return PLAIN PROSE only — no heading, no JSON, no markdown fences.",
  ]).join("\n");
  const actionLines = actions.map((a) => {
    const t = a.triage;
    const tgt = t?.targetWorkId ? ` → target [${t.targetWorkId}]` : "";
    return `- [${a.issue.type}] ${t?.action ?? "fix"}${tgt}: "${a.issue.sentence ?? a.issue.detail}" (${a.issue.detail})`;
  }).join("\n");
  const evidenceBlock = evidence.map((p) => `[${p.workId}] "${p.title ?? ""}": ${(p.abstract ?? p.card?.findingShort ?? "").slice(0, 400)}`).join("\n");
  const addBlock = addCitations.length
    ? "\nADD THESE CITATIONS IF THEY FIT (grounded, else omit):\n" + addCitations.map((p) => `[${p.workId}] "${p.title ?? ""}": ${(p.abstract ?? "").slice(0, 300)}`).join("\n")
    : "";
  const ctxBlock = relatedContext ? `\nRELATED SECTION (READ-ONLY context — do NOT copy, use to de-dup/reconcile):\n${relatedContext.slice(0, 1200)}` : "";
  const user = [
    `SECTION §${section.number} "${section.heading}":\n\n${section.body}`,
    "",
    "ACTIONS TO APPLY:",
    actionLines,
    "",
    "EVIDENCE (only these workIds are valid):",
    evidenceBlock,
    addBlock,
    ctxBlock,
    "",
    "Return the full revised section body as plain prose.",
  ].join("\n");
  return { system, user };
}

export interface SectionResult {
  number: string; heading: string; before: string; after: string;
  actions: Array<{ issue: Issue; triage?: TriageResult; resolved: boolean }>;
  citationsAdded: string[]; citationsDropped: string[];
}

export function buildCorrectorReport(sections: SectionResult[]) {
  const types: IssueType[] = ["unsupported","krisMismatch","daRevision","coherence","offTopic","corpusGap","truncated"];
  const byType: Record<string, { found: number; resolved: number; remaining: number }> = {};
  for (const t of types) byType[t] = { found: 0, resolved: 0, remaining: 0 };
  const remainingIssues: any[] = [];
  for (const s of sections) for (const a of s.actions) {
    const b = byType[a.issue.type]; if (!b) continue;
    b.found++; if (a.resolved) b.resolved++; else { b.remaining++; remainingIssues.push({ section: `§${s.number}`, type: a.issue.type, detail: a.issue.detail }); }
  }
  return { sectionsRewritten: sections.filter((s) => s.before !== s.after).map((s) => s.number), byType, remainingIssues };
}

export function buildDryRunMarkdown(paperId: string, sections: SectionResult[], report: any): string {
  const lines = [`# Corrector dry-run — ${paperId}`, "", `Sections rewritten: ${report.sectionsRewritten.join(", ") || "none"}`, ""];
  for (const s of sections) {
    lines.push(`## §${s.number} ${s.heading}`);
    for (const a of s.actions) lines.push(`- **${a.issue.type} → ${a.triage?.action ?? "fix"}** ${a.resolved ? "✓" : "✗ unresolved"} — ${a.triage?.rationale ?? a.issue.detail}`);
    if (s.citationsAdded.length) lines.push(`- citations added: ${s.citationsAdded.join(", ")}`);
    if (s.citationsDropped.length) lines.push(`- citations dropped: ${s.citationsDropped.join(", ")}`);
    lines.push("", "<details><summary>before → after</summary>", "", "**BEFORE:**", "", s.before, "", "**AFTER:**", "", s.after, "", "</details>", "");
  }
  return lines.join("\n");
}

export interface CorrectorDeps {
  log: (m: string) => void;
  dryRun: boolean;
}

export async function runCorrectorPass(
  draftedSections: any[],
  coding: { papers: any[] },
  validIds: Set<string>,
  findings: any,                 // {auditReport, reviewReport, krisReport, coherenceReport, daRevisions}
  deps: CorrectorDeps,
): Promise<{ sections: any[]; correctorReport: any; sectionResults: SectionResult[] }> {
  const { log, dryRun } = deps;
  const papers = coding.papers;
  const byId = new Map(papers.map((p) => [p.workId, p]));

  // citedIn: workId -> a section it appears in (for Kris routing)
  const citedIn = new Map<string, { section: string }>();
  for (const s of draftedSections) for (const w of (s.citedWorkIds ?? extractCitedIds(s.body, validIds))) if (!citedIn.has(w)) citedIn.set(w, { section: String(s.number) });

  const issueMap = aggregateIssues(findings, citedIn);
  // corpusGaps → assign to sections, then fold into the issue map
  const gapPapers = (findings.reviewReport?.corpusGaps ?? []).map((g: any) => ({ ...g, ...(byId.get(g.workId) ?? {}) }));
  for (const a of assignCorpusGaps(gapPapers, draftedSections)) {
    if (a.section) {
      if (!issueMap.has(a.section)) issueMap.set(a.section, []);
      issueMap.get(a.section)!.push({ type: "corpusGap", workId: a.workId, detail: a.reason ?? "should be cited" });
    } else log(`corpusGap ${a.workId}: no section fit — reported, not inserted`);
  }

  // Truncation repair: a section whose stored body was cut off mid-sentence (a
  // pre-existing generation defect the recovery pass misses — it only retries
  // MISSING sections) gets a full re-draft, even with no other findings.
  for (const s of draftedSections) {
    const k = String(s.number);
    if (k === "critique") continue; // appended DA assessment — leave as-is
    if (s.body && !endsCleanly(s.body)) {
      if (!issueMap.has(k)) issueMap.set(k, []);
      const arr = issueMap.get(k)!;
      if (!arr.some((i) => i.type === "truncated")) {
        arr.push({ type: "truncated", detail: "section body was cut off mid-sentence — complete/re-draft it in full" });
        log(`§${k}: truncated body detected — will attempt full re-draft`);
      }
    }
  }

  const out = [...draftedSections];
  const sectionResults: SectionResult[] = [];

  // Sections are independent — process them concurrently. Within each section,
  // claim-level triage runs as BATCHED calls (≤TRIAGE_BATCH_SIZE issues per call,
  // sharing the section's candidate pool) instead of one call per issue —
  // ~8-25 triage calls per paper down to ~one per section.
  const TRIAGE_BATCH_SIZE = 8;
  await Promise.allSettled([...issueMap.entries()].map(async ([secNum, issues]) => {
    const idx = out.findIndex((s) => String(s.number) === secNum);
    if (idx < 0) return;
    const sec = out[idx];
    const cited = sec.citedWorkIds ?? extractCitedIds(sec.body, validIds);
    const poolIds = selectCandidatePool(sec, cited, papers);
    const pool = poolIds.map((id) => byId.get(id)).filter(Boolean);

    // Claim-level issues (unsupported / krisMismatch / offTopic) get an LLM triage
    // verdict; structural issues (daRevision, coherence, corpusGap, truncated)
    // carry their own action and are added to planned directly without a call.
    const triageable = issues.filter((i) => i.type === "unsupported" || i.type === "krisMismatch" || i.type === "offTopic");
    const structural = issues.filter((i) => !triageable.includes(i));
    const planned: PlannedAction[] = structural.map((issue) => ({ issue }));

    const chunks: Issue[][] = [];
    for (let i = 0; i < triageable.length; i += TRIAGE_BATCH_SIZE) chunks.push(triageable.slice(i, i + TRIAGE_BATCH_SIZE));
    const chunkResults = await Promise.all(chunks.map(async (chunk) => {
      const { system, user } = buildTriageBatchPrompt(chunk, pool as any);
      // ~one JSON verdict line per item + headroom; old per-issue budget was 512.
      const maxTok = 256 + 256 * chunk.length;
      let raw: any = null;
      try { raw = await callQwen(system, user, maxTok); } catch { try { raw = await callGemini(system, user, maxTok, true, "jel_corrector", GEMINI_JEL_QA_MODEL); } catch { /* keep */ } }
      return parseTriageBatch(raw, chunk.length);
    }));
    chunks.forEach((chunk, ci) => chunk.forEach((issue, ii) => {
      const triage = chunkResults[ci][ii];
      if (triage.action === "keep") { log(`§${secNum} ${issue.type}: keep (${triage.rationale})`); return; }
      planned.push({ issue, triage });
    }));
    if (planned.length === 0) return;

    const relatedNum = planned.map((p) => p.issue.relatedSection).find(Boolean);
    const related = relatedNum ? (out.find((s) => String(s.number) === relatedNum)?.body ?? "") : "";
    const addCites = planned.filter((p) => p.issue.type === "corpusGap").map((p) => byId.get(p.issue.workId!)).filter(Boolean);

    const { system, user } = buildRewritePrompt(sec, planned, pool as any, related, addCites as any);
    let newBody = sec.body;
    let resolvedAll = false;
    try {
      // 16384 (not 8192): Gemini's thinking tokens count against maxOutputTokens; 8192
      // truncated long sections mid-sentence, silently dropping their tail citations.
      const revised = await callGemini(system, user, 16384, false, "jel_corrector", GEMINI_JEL_QA_MODEL); // plain prose
      if (typeof revised === "string" && revised.length > 150) {
        const candidate = fenceBodyToEvidence(
          normalizeCitations(stripLeadingHeadingEcho(revised, sec.heading), papers),
          validIds,
        );
        // Truncation guard: a rewrite that returns far shorter than the original, or
        // doesn't end on terminal punctuation, is treated as truncated → soft-fail
        // (keep the original body) so we never silently gut a section's citations.
        // TRADEOFF: a legitimate large `remove`/`trim` could trip the floor; we prefer
        // keeping the original over shipping a truncated section.
        const origWords = wordCount(sec.body);
        const newWords = wordCount(candidate);
        const endsClean = endsCleanly(candidate);
        // Citation-integrity guard: a rewrite that drops most of the section's
        // [workId] tags (e.g. Gemini reduced "(Author 2020) [w1]" to plain
        // "(Author 2020)") would silently break the bibliography. Reject it.
        // (corpusGap adds make afterCount >= beforeCount, so this never trips on
        // a section that legitimately GAINED citations.)
        const beforeCount = new Set(extractCitedIds(sec.body, validIds)).size;
        const afterCount = new Set(extractCitedIds(candidate, validIds)).size;
        const keptCites = afterCount >= CITE_RETENTION * beforeCount;
        if (newWords >= MIN_REWRITE_RETENTION * origWords && endsClean && keptCites) {
          newBody = candidate;
          resolvedAll = true;
        } else {
          log(`§${secNum} corrector rewrite REJECTED (words ${newWords}/${origWords}, endsClean=${endsClean}, cites ${afterCount}/${beforeCount}) — keeping original`);
        }
      }
    } catch (e) { log(`§${secNum} corrector rewrite failed: ${(e as Error).message}`); }

    const beforeCited = new Set(extractCitedIds(sec.body, validIds));
    const afterCited = new Set(extractCitedIds(newBody, validIds));
    sectionResults.push({
      number: secNum, heading: sec.heading, before: sec.body, after: newBody,
      // "resolved" is verified against the POST-rewrite body, not just rewrite
      // acceptance. An accepted rewrite that passes the guards but silently failed
      // to actually perform the fix (e.g. Gemini left the wrong [workId] in place on
      // a re-attribution) must NOT be counted resolved — else correctorReport reports
      // "10/10 resolved" while the unfixed sentence persists. (Bug 2026-06-16.)
      actions: planned.map((p) => {
        const wid = p.issue.workId;
        const act = p.triage?.action;
        let resolved: boolean;
        if (!resolvedAll) {
          resolved = false;
        } else if (p.issue.type === "corpusGap") {
          // corpusGap: its [workId] must actually have landed in the rewrite (the
          // paper may not be in the evidence set → nothing to ground → omitted).
          resolved = !!wid && afterCited.has(wid);
        } else if (act === "re-attribute") {
          // Re-attribution must persist: the target tag present AND the wrong tag
          // gone from the body. (Conservatively under-reports if the wrong tag is
          // legitimately cited elsewhere in the section — safe direction.)
          const target = p.triage?.targetWorkId;
          resolved = !!target && afterCited.has(target) && (!wid || !afterCited.has(wid));
        } else if (act === "remove") {
          // Removal must persist: the offending [workId] must be gone from the body.
          resolved = !wid || !afterCited.has(wid);
        } else {
          // soften / structural (coherence, daRevision) — no reliable token-level
          // signal; trust section-level acceptance.
          resolved = true;
        }
        return { ...p, resolved };
      }),
      citationsAdded: [...afterCited].filter((c) => !beforeCited.has(c)),
      citationsDropped: [...beforeCited].filter((c) => !afterCited.has(c)),
    });

    if (!dryRun && resolvedAll) {
      out[idx] = { ...sec, body: newBody, citedWorkIds: [...afterCited], wordCount: wordCount(newBody) };
    }
  }));

  const correctorReport = buildCorrectorReport(sectionResults);
  log(`corrector: ${correctorReport.sectionsRewritten.length} section(s) ${dryRun ? "would be " : ""}rewritten`);
  return { sections: out, correctorReport, sectionResults };
}
