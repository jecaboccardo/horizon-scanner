// ---------------------------------------------------------------------------
// Citation-name integrity enforcement (2026-07-15, Sebastian-feedback P0).
//
// The JEL drafter writes citations as free-text "Author (year) [workId]".
// Only the [workId] bracket was ever machine-verified (fenceBodyToEvidence /
// extractCitedIds) — the author-year prose was never compared to
// works.authors, so hallucinated names ("Flores-Macías and Sánchez-Talanquer"
// over a Martinez-Alvarez workId) and bracketless phantom citations
// ("(Cole et al. 2012)" matching no evidence work) shipped verbatim.
//
// This module closes both holes deterministically (no LLM):
//   Pass 1 — phantom scan: author-year citations with NO [workId] bracket.
//     • If surname+year uniquely matches an evidence paper → append its
//       [workId] (auto-repair; the claim then enters the audit + cited flag).
//     • Parenthetical phantoms matching nothing → the parenthetical is
//       removed (grammatically safe).
//     • Narrative phantoms matching nothing → left in place but counted as
//       unresolved (removing a sentence subject is not safe surgery).
//     • Semicolon-delimited multi-citation lists ("(A 2008; B 2000)") are
//       split and each item verified independently — added 2026-07-22, was
//       previously excluded wholesale (a fabricated name in this exact shape
//       shipped unverified). Never deletes a list item, only links or leaves.
//   Pass 2 — name check adjacent to every valid [workId] bracket: if none of
//     the work's author surnames appear in the preceding window, the
//     author-year text is rewritten from works.authors (canonical short form).
//
// Runs AFTER fenceBodyToEvidence, BEFORE extractCitedIds, at every place a
// section body is normalized (initial draft, Devil's Advocate, revision).
// ---------------------------------------------------------------------------

export interface CitationPaperMeta {
  workId: string;
  authors?: unknown;
  year?: number | null;
}

export interface CitationIntegrityStats {
  renamed: number;    // wrong author names next to a valid bracket, rewritten
  linked: number;     // bracketless citations auto-linked to an evidence work
  removed: number;    // parenthetical phantoms stripped
  unresolved: number; // suspicious citations left as-is (logged upstream)
}

// Tolerant `authors` coercion — mirrors toAuthorArr in jelPaperPipeline.ts
// (kept local so this module stays importable in isolation for tests).
function toAuthors(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === "string" && v.trim()) {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p.map(String).filter(Boolean);
    } catch { /* plain text */ }
    // Plain display string — "Given Surname, Given Surname2" or the inverted
    // "Surname, Given, Surname2, Given2". Splitting on commas puts every real
    // surname into the alias set either way (given names become harmless
    // extra aliases). Matching must survive this degraded shape: a missed
    // match here can delete a legitimate citation.
    return v.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Surname of one author name — "Keefer, Philip" → "Keefer"; "Philip Keefer" → "Keefer". */
function surnameOf(name: string): string {
  const n = String(name).trim();
  if (!n) return "";
  if (n.includes(",")) return n.split(",")[0].trim();
  const parts = n.split(/\s+/);
  return parts[parts.length - 1] ?? "";
}

interface PaperIdx {
  workId: string;
  year: number | null;
  surnames: string[];      // original case, for rendering
  surnamesNorm: string[];  // normalized, for matching
  short: string | null;    // canonical short name: "A", "A and B", "A et al."
}

function buildIndex(papers: CitationPaperMeta[]): Map<string, PaperIdx> {
  const idx = new Map<string, PaperIdx>();
  for (const p of papers) {
    if (!p?.workId) continue;
    const names = toAuthors(p.authors);
    const surnames = names.map(surnameOf).filter(Boolean);
    // Sole author with a 3+-word, comma-less name is ambiguous between a
    // person ("Alicia Dailey Cooperman") and an institution ("Inter-American
    // Development Bank") — render the full name; the last token alone could
    // be wrong for institutions.
    const soleLong = names.length === 1 && !names[0].includes(",") &&
      names[0].trim().split(/\s+/).length >= 3;
    const short = surnames.length === 0 ? null
      : soleLong ? names[0].trim()
      : surnames.length === 1 ? surnames[0]
      : surnames.length === 2 ? `${surnames[0]} and ${surnames[1]}`
      : `${surnames[0]} et al.`;
    // Matching aliases: last-token surnames AND full author names, so both
    // "Cooperman (2022)" and "Inter-American Development Bank (2008)" match.
    const aliases = [...new Set([...surnames.map(norm), ...names.map((n) => norm(n.trim()))])]
      .filter(Boolean);
    idx.set(p.workId, {
      workId: p.workId,
      year: p.year ?? null,
      surnames,
      surnamesNorm: aliases,
      short,
    });
  }
  return idx;
}

const YEAR_SRC = "(?:19|20)\\d{2}[a-z]?";

// Narrative: "Surname (2022)", "Surname and Other (2022)", "Surname et al. (2022)"
// — deliberately NO comma-lists (avoids eating preceding prose on rewrite).
const NAME_SRC = "\\p{Lu}[\\p{L}'’\\-]+";
const LIST_SRC = `${NAME_SRC}(?:\\s+(?:and|&)\\s+${NAME_SRC})?(?:\\s+et\\s+al\\.?)?`;

// Semicolon-list item name: allows compound multi-word surnames ("García
// Arias") and a second multi-word author ("Hasbun & Sousa"), unlike LIST_SRC
// (kept narrow for the single-citation rewrite path). Used only to identify
// and verify each item WITHIN a semicolon list — never for prose rewriting.
const ITEM_NAME_SRC =
  `${NAME_SRC}(?:\\s+${NAME_SRC})*(?:\\s+(?:and|&)\\s+${NAME_SRC}(?:\\s+${NAME_SRC})*)?(?:\\s+et\\s+al\\.?)?`;

function yearNum(y: string): number { return parseInt(y.slice(0, 4), 10); }

/** Evidence papers matching a name fragment + year.
 *  `hit` is set only on a UNIQUE match; `candidates` distinguishes a confirmed
 *  zero-match (safe to treat as phantom) from an ambiguous one (leave alone).
 *  `unknowable` is true when a same-year paper has no author metadata at all —
 *  the citation could refer to it, so nothing may be removed. */
function matchPaper(
  idx: Map<string, PaperIdx>,
  nameText: string,
  year: number,
): { hit: PaperIdx | null; candidates: number; unknowable: boolean } {
  const n = norm(nameText);
  const sameYear = [...idx.values()].filter((p) => p.year === year);
  const unknowable = sameYear.some((p) => p.surnamesNorm.length === 0);
  const pool = sameYear.filter((p) => p.surnamesNorm.length > 0);
  const byFirst = pool.filter((p) => n.includes(p.surnamesNorm[0]));
  if (byFirst.length >= 1) {
    return { hit: byFirst.length === 1 ? byFirst[0] : null, candidates: byFirst.length, unknowable };
  }
  // Reverse containment covers particles the name grammar can't capture
  // ("Valle (2024)" vs stored surname "del Valle").
  const byAny = pool.filter((p) =>
    p.surnamesNorm.some((s) => n.includes(s) || (n.length >= 4 && s.includes(n)))
  );
  return { hit: byAny.length === 1 ? byAny[0] : null, candidates: byAny.length, unknowable };
}

function cleanupSpacing(s: string): string {
  return s.replace(/\s+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ");
}

export function enforceCitationIntegrity(
  body: string,
  papers: CitationPaperMeta[],
): { body: string; stats: CitationIntegrityStats } {
  const stats: CitationIntegrityStats = { renamed: 0, linked: 0, removed: 0, unresolved: 0 };
  if (!body) return { body, stats };
  const idx = buildIndex(papers);
  if (idx.size === 0) return { body, stats };
  let text = body;

  // ---- Pass 1a: narrative phantoms — "Name (2022)" with no [workId] after ----
  const narrativeRe = new RegExp(`\\b(${LIST_SRC})\\s*\\(\\s*(${YEAR_SRC})\\s*\\)(?!\\s*\\[)`, "gu");
  text = text.replace(narrativeRe, (m, nameText: string, year: string) => {
    const res = matchPaper(idx, nameText, yearNum(year));
    if (res.hit) { stats.linked++; return `${m} [${res.hit.workId}]`; }
    stats.unresolved++;
    return m; // narrative subject — not safe to delete
  });

  // ---- Pass 1b: multi-citation semicolon lists — "(A 2008; B 2000)" ----
  // Previously skipped entirely (see the `;` exclusion below in Pass 1c) —
  // shipped verbatim with zero verification. Splits on ';', verifies each
  // item independently, appends [workId] only to items that resolve
  // uniquely. Never deletes an item — removing one citation out of a list
  // the drafter may have meant as a unit is not safe surgery the way a
  // single stray phantom parenthetical is; unmatched items are left as-is
  // and counted unresolved so they're visible in stats instead of silently
  // unverified. 2026-07-22: closes a real gap found via manual audit — 8
  // narrative/semicolon-list citations in a live JEL paper were never
  // machine-verified (all happened to resolve to real papers on manual
  // check, but a fabricated one in this exact shape would have shipped).
  const semicolonListRe = new RegExp(`\\(([^()\\[\\]]*;[^()\\[\\]]*)\\)(?!\\s*\\[)`, "gu");
  text = text.replace(semicolonListRe, (m, content: string) => {
    const parts = content.split(";").map((p: string) => p.trim()).filter(Boolean);
    if (parts.length < 2) return m;
    const itemRe = new RegExp(`^(${ITEM_NAME_SRC})\\s*,?\\s*(${YEAR_SRC})$`, "u");
    let changed = false;
    const rewritten = parts.map((part: string) => {
      const im = part.match(itemRe);
      if (!im) return part; // not citation-shaped (e.g. a stray note) — leave
      const [, nameText, year] = im;
      const res = matchPaper(idx, nameText, yearNum(year));
      if (res.hit) { stats.linked++; changed = true; return `${part} [${res.hit.workId}]`; }
      stats.unresolved++;
      return part; // zero/ambiguous match — leave the list item untouched
    });
    return changed ? `(${rewritten.join("; ")})` : m;
  });

  // ---- Pass 1c: parenthetical phantoms — "(Name 2022)" with no [workId] ----
  const parentheticalRe = new RegExp(`\\(([^()\\[\\]]{2,90}?)\\s+(${YEAR_SRC})\\)(?!\\s*\\[)`, "gu");
  text = text.replace(parentheticalRe, (m, content: string, year: string) => {
    const c = content.trim();
    // Only touch citation-shaped content: starts uppercase, no stats/multi-cite noise.
    if (!/^\p{Lu}/u.test(c)) return m;
    if (/[;=%]/.test(c) || /\d{4}/.test(c)) return m; // residual semicolon lists Pass 1b
    const res = matchPaper(idx, c, yearNum(year));   // couldn't fully verify, or stats — leave
    if (res.hit) { stats.linked++; return `${m} [${res.hit.workId}]`; }
    if (res.candidates > 1 || res.unknowable) { stats.unresolved++; return m; } // ambiguous — never delete
    stats.removed++;
    return ""; // phantom parenthetical — matches no evidence work in any year
  });

  // ---- Pass 2: author names adjacent to each valid bracket ----
  // Right-to-left so replacements don't shift earlier offsets.
  const brackets = [...text.matchAll(/\[([^\]]+)\]/g)];
  for (let i = brackets.length - 1; i >= 0; i--) {
    const b = brackets[i];
    const meta = idx.get(b[1].trim());
    if (!meta || meta.surnamesNorm.length === 0) continue;
    const start = b.index ?? 0;
    const winStart = Math.max(0, start - 110);
    const window = text.slice(winStart, start);
    const w = norm(window);
    if (meta.surnamesNorm.some((s) => s && w.includes(s))) continue; // name is right

    // Wrong/missing name — rewrite the citation phrase at the window's tail.
    const year = meta.year ?? null;
    let replaced = false;
    const apply = (re: RegExp, render: (y: string) => string) => {
      if (replaced) return;
      const m = window.match(re);
      if (!m || m.index === undefined) return;
      const abs = winStart + m.index;
      text = text.slice(0, abs) + render(m[m.length - 1] as string) + text.slice(start);
      replaced = true;
    };
    // "(Wrong Name 2023) [id]"
    apply(
      new RegExp(`\\(([^()\\[\\]]{2,90}?)\\s+(${YEAR_SRC})\\)\\s*$`, "u"),
      (y) => `(${meta.short} ${year ?? y}) `,
    );
    // "Wrong and Name (2023) [id]"
    apply(
      new RegExp(`\\b(${LIST_SRC})\\s*\\(\\s*(${YEAR_SRC})\\s*\\)\\s*$`, "u"),
      (y) => `${meta.short} (${year ?? y}) `,
    );
    // "Wrong Name 2023 [id]" (inside a multi-citation parenthetical)
    apply(
      new RegExp(`\\b(${LIST_SRC})\\s+(${YEAR_SRC})\\s*$`, "u"),
      (y) => `${meta.short} ${year ?? y} `,
    );
    if (replaced) stats.renamed++;
    else stats.unresolved++; // e.g. "see [id]" with no adjacent citation phrase
  }

  return { body: cleanupSpacing(text), stats };
}
