import { __testing as dedupInternals } from "../dedup.ts";

export interface ProseIssue { paperId: string; section: string; kinds: string[]; sample: string; }

export function checkProse(paperId: string, sections: Array<{ title: string; body: string }>): ProseIssue[] {
  const out: ProseIssue[] = [];
  for (const s of sections) {
    const body = s.body ?? "";
    const kinds: string[] = [];
    const bulletLines = (body.match(/^\s*[-*•]\s+/gm) || []).length;
    if (bulletLines >= 2) kinds.push("bullets");
    if (/^\s*#{1,6}\s+/m.test(body)) kinds.push("markdown_header");
    if (/scratchpad|let me think|step \d+:/i.test(body)) kinds.push("scratchpad");
    if (/\n\s*(references|works cited|bibliography|cited (papers|works|references)|citations)\s*:?\s*\n/i.test(body)) kinds.push("reference_dump");
    if (kinds.length) {
      const sample = body.split("\n").find((l) => l.trim()) ?? "";
      out.push({ paperId, section: s.title, kinds, sample: sample.slice(0, 160) });
    }
  }
  return out;
}

export interface DupPair { key: string; a: string; b: string; reason: string; }
export interface PaperLike { id: string; title: string; year: number | null; authors: string[]; }

export function findDuplicates(papers: PaperLike[]): DupPair[] {
  const groups = new Map<string, string[]>();
  for (const p of papers) {
    // canonicalKey takes a paper OBJECT (reads .title/.year/.authors). Cast to satisfy its Paper type.
    // deno-lint-ignore no-explicit-any
    const key = dedupInternals.canonicalKey({ title: p.title ?? "", year: p.year ?? null, authors: p.authors ?? [] } as any);
    if (!key) continue;
    const arr = groups.get(key) ?? [];
    if (!arr.includes(p.id)) arr.push(p.id);
    groups.set(key, arr);
  }
  const out: DupPair[] = [];
  for (const [key, ids] of groups) {
    for (let i = 1; i < ids.length; i++) {
      out.push({ key, a: ids[0], b: ids[i], reason: `canonical-key match: ${key}` });
    }
  }
  return out;
}

export interface AddedPaperCheck { ref: string; label: string; inTable: boolean; inBrief: boolean; }

export function checkAddedPapers(
  uploaded: Array<{ ref: string; label: string }>,
  tableRefs: Set<string>,
  briefRefs: Set<string>,
): AddedPaperCheck[] {
  return uploaded.map((u) => ({
    ref: u.ref, label: u.label,
    inTable: tableRefs.has(u.ref),
    inBrief: briefRefs.has(u.ref),
  }));
}

export interface RelevanceInput {
  runId: string; topCosine: number | null; meanCosine: number | null;
  segments: Record<string, "core" | "context" | "off"> | null;
  offTitles: Record<string, string>; floor: number;
}
export interface RelevanceSignal {
  runId: string; topCosine: number | null; meanCosine: number | null;
  offRatio: number | null; coreCount: number; offTitles: string[]; belowFloor: boolean;
}

export function computeRelevance(i: RelevanceInput): RelevanceSignal {
  const segVals = Object.values(i.segments ?? {});
  const off = segVals.filter((s) => s === "off").length;
  const core = segVals.filter((s) => s === "core").length;
  const offRatio = segVals.length ? off / segVals.length : null;
  return {
    runId: i.runId, topCosine: i.topCosine, meanCosine: i.meanCosine,
    offRatio, coreCount: core,
    offTitles: Object.values(i.offTitles).slice(0, 20),
    belowFloor: i.topCosine != null && i.topCosine < i.floor,
  };
}
