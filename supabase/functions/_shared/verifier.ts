/**
 * supabase/functions/_shared/verifier.ts
 *
 * Qwen-based verification layer for Gemini-generated chat answers and brief
 * prose. The evidence table is the source of truth — Qwen receives a structured
 * dossier of every paper (workId, authors, year, methodology, SMS, geography,
 * abstract excerpt) plus Gemini's draft, and rewrites any paper-specific claim
 * that drifts from the dossier.
 *
 * Returns the corrected text. If Qwen fails or times out, returns the original
 * input unchanged (never block on the verifier).
 */

import { qwenGenerateJSON } from "./qwenClient.ts";

interface EvidenceRowLite {
  workId: string;
  title: string;
  authors: string[];
  year: number | null;
  methodologyBadge: string;
  smsLevel: number | null;
  geography: string[];
  finding: string;
}

interface VerifyResult {
  corrected: string;
  changed: boolean;
}

/** Structural slice of SynthClient (synthesisProvider.ts) — only BYOK
 *  provider-backed clients implement generateJSON. Typed structurally to
 *  avoid importing synthesisProvider here. */
interface VerifierClient {
  // deno-lint-ignore no-explicit-any
  generateJSON?: (prompt: string, opts?: { maxTokens?: number; temperature?: number; op?: string; timeoutMs?: number }) => Promise<any>;
}

const VERIFIER_TIMEOUT_MS = 25_000;

function buildDossier(rows: EvidenceRowLite[]): string {
  return rows
    .map((row, i) => {
      const authors =
        row.authors && row.authors.length > 0
          ? `${row.authors.slice(0, 3).join(", ")}${row.authors.length > 3 ? " et al." : ""}`
          : "unknown";
      const sms = row.smsLevel == null ? "unclassified" : `SMS ${row.smsLevel}`;
      const design =
        row.methodologyBadge && row.methodologyBadge !== "Unclassified"
          ? row.methodologyBadge
          : "Unclassified";
      const geo = (row.geography || []).slice(0, 3).join(", ") || "—";
      const abstract = (row.finding || "").slice(0, 800).replace(/\s+/g, " ");
      return `${i + 1}. [${row.workId}] "${row.title}" (${row.year ?? "n.d."})
   Authors: ${authors}
   Design: ${design} | ${sms}
   Geography: ${geo}
   Abstract: ${abstract || "(none)"}`;
    })
    .join("\n\n");
}

/**
 * Verify a chat answer against the evidence table. Qwen returns the corrected
 * text — same as input if no drift detected, or rewritten with table-grounded
 * values where Gemini drifted.
 */
export async function verifyChatAnswer(
  answer: string,
  evidenceRows: EvidenceRowLite[],
  client?: VerifierClient | null,
): Promise<VerifyResult> {
  if (!answer || answer.trim().length === 0 || evidenceRows.length === 0) {
    return { corrected: answer, changed: false };
  }

  // Scope the check to papers the draft actually references. The full
  // 40-row dossier cost ~10k input tokens per chat turn (now billed to BYOK
  // keys), even when the answer discussed 2-3 papers or none. A row counts
  // as referenced when the draft cites its workId in brackets, or mentions
  // an author-name token or the title prefix — the model sometimes cites a
  // raw DOI or bare author-year instead of the workId (forbidden but real),
  // and those claims still need checking. ANY bracketed token counts as a
  // citation attempt (malformed ones like [10.1093/...] must reach the
  // verifier so its drop-unknown-citation rule fires). Over-matching a
  // common surname just adds rows (bounded by the table), never harms
  // correctness. Nothing referenced at all → nothing paper-specific to
  // verify → skip the LLM round-trip entirely.
  const bracketTokens = new Set(
    [...answer.matchAll(/\[([^\[\]]{2,80})\]/g)].map((m) => m[1].trim()),
  );
  const referenced = (r: EvidenceRowLite): boolean => {
    if (bracketTokens.has(r.workId)) return true;
    const firstAuthorTokens = (r.authors?.[0] || "").split(/[\s,.]+/);
    if (firstAuthorTokens.some((t) => t.length >= 4 && answer.includes(t))) return true;
    const titlePrefix = (r.title || "").slice(0, 25);
    return titlePrefix.length >= 15 && answer.toLowerCase().includes(titlePrefix.toLowerCase());
  };
  const scopedRows = evidenceRows.filter(referenced);
  if (bracketTokens.size === 0 && scopedRows.length === 0) {
    return { corrected: answer, changed: false };
  }

  const dossier = scopedRows.length > 0
    ? buildDossier(scopedRows)
    : "(no cited workId matches the table — treat every bracketed citation in the draft as invalid)";
  const validIdList = evidenceRows.map((r) => r.workId).join(", ");

  const prompt = `You are a fact-checker for an evidence-brief chat assistant. The EVIDENCE TABLE below is the ground truth for every paper the draft references — authoritative methodology, SMS level, authors, year, geography, and abstract. The VALID WORK IDS line lists every workId that exists for this brief (papers the draft does not reference are omitted from the table to save space).

Your job: read the DRAFT ANSWER and rewrite ONLY the parts where it makes claims about specific papers that contradict the table. Replace incorrect methodology, SMS levels, years, authors, or invented findings with the table's values. Keep general concept explanations and prose flow intact. If the draft is already correct, return it unchanged.

Rules:
- If the draft says a paper uses "DiD/SMS 4" but the table says "Observational/SMS 2", rewrite to match the table.
- Bracketed citations must be workIds from the VALID WORK IDS list. If the draft cites anything else in brackets (a DOI, URL, author-year, or unknown id): when the paper clearly matches a row in the EVIDENCE TABLE, replace the bracket content with that row's workId; otherwise drop the citation (keep the surrounding sentence if it still makes sense without it).
- If the draft invents an effect size, country, or finding not supported by the abstract in the table, drop or soften the claim.
- If the draft says "this looks like an RCT" or guesses a design from an abstract, replace with the table's classification.
- Do NOT add new content. Do NOT shorten correct sentences. Only correct factual drift.
- Preserve the draft's tone and structure.

VALID WORK IDS: ${validIdList}

EVIDENCE TABLE (ground truth for cited papers):
${dossier}

DRAFT ANSWER:
${answer}

Return JSON only:
{"corrected": "<the full corrected answer text>", "changed": <true if you made any change, false otherwise>}`;

  try {
    // BYOK users: verify on THEIR resolved provider — same key that wrote the
    // answer. Avoids the Qwen GPU as a hidden dependency (a cold/loaded Qwen
    // stalled every BYOK chat turn for the full 25s timeout) and keeps their
    // generation off app infra, consistent with the BYOK contract. App-default
    // users (no generateJSON on the native Gemini client) keep Qwen.
    const result = client?.generateJSON
      ? await client.generateJSON(prompt, {
          temperature: 0.1,
          maxTokens: 4096,
          op: "chat_verifier",
          timeoutMs: VERIFIER_TIMEOUT_MS,
        }) as { corrected: string; changed: boolean }
      : await qwenGenerateJSON<{ corrected: string; changed: boolean }>(
          prompt,
          { temperature: 0.1, timeoutMs: VERIFIER_TIMEOUT_MS },
        );
    if (typeof result?.corrected !== "string" || result.corrected.trim().length === 0) {
      return { corrected: answer, changed: false };
    }
    // Retention guard (mirrors the JEL corrector's MIN_REWRITE_RETENTION /
    // endsCleanly). The verifier is meant to correct localized factual drift,
    // NOT rewrite or truncate the answer. A confused Qwen-14B can return a much
    // shorter or mid-sentence-truncated "correction"; without this guard that
    // replaced an accurate Gemini answer wholesale. Reject → keep the draft.
    const corrected = result.corrected.trim();
    const endsCleanly = /[.!?)"'”’\]]\s*$/.test(corrected);
    const retention = corrected.length / Math.max(1, answer.trim().length);
    if (retention < 0.7 || !endsCleanly) {
      console.warn(`[verifier] chat rewrite rejected (retention=${retention.toFixed(2)}, endsCleanly=${endsCleanly}) — keeping draft`);
      return { corrected: answer, changed: false };
    }
    return {
      corrected: result.corrected,
      changed: !!result.changed && result.corrected !== answer,
    };
  } catch (err) {
    console.error(`[verifier] ${client?.generateJSON ? "provider" : "qwen"} check failed:`, (err as Error).message);
    return { corrected: answer, changed: false };
  }
}

/**
 * Verify brief prose (summaryBullets, abstractSummary) — same dossier-grounded
 * check, applied to a single text field. Returns corrected string.
 */
export async function verifyBriefProse(
  text: string,
  evidenceRows: EvidenceRowLite[],
): Promise<string> {
  const { corrected } = await verifyChatAnswer(text, evidenceRows);
  return corrected;
}

/**
 * Section-level verifier for the generated brief prose. Runs POST-DONE in the
 * SSE handler (never blocks the brief; failures leave the brief untouched).
 *
 * ONE Qwen call covers the paper-claim-bearing prose fields (abstractSummary,
 * summaryBullets, strongestEvidence, methodologyNote, coverageCard.gapSummary)
 * against a dossier scoped to the papers the prose actually references — same
 * scoping as the chat verifier. Deliberately Qwen (app infra), not the BYOK
 * provider: this pass is invisible post-done polish, so it must not bill the
 * team's key, and a Qwen stall costs nothing user-visible.
 *
 * Per-field retention guards mirror verifyChatAnswer: a corrected field that
 * shrinks the text or truncates mid-sentence is rejected field-by-field, so a
 * confused model can degrade at most nothing.
 */
export async function verifyBriefSections(
  sections: Record<string, unknown>,
  evidenceRows: EvidenceRowLite[],
  lang?: 'en' | 'es' | 'pt',
): Promise<{
  changed: boolean;
  sections: {
    abstractSummary?: string;
    summaryBullets?: string[];
    strongestEvidence?: string;
    methodologyNote?: string;
    coverageCard?: Record<string, unknown>;
  };
}> {
  const noChange = { changed: false, sections: {} as Record<string, never> };
  if (evidenceRows.length === 0) return noChange;

  const abstractSummary = typeof sections.abstractSummary === "string" ? sections.abstractSummary : "";
  const summaryBullets = Array.isArray(sections.summaryBullets)
    ? (sections.summaryBullets as unknown[]).filter((b): b is string => typeof b === "string")
    : [];
  const strongestEvidence = typeof sections.strongestEvidence === "string" ? sections.strongestEvidence : "";
  const methodologyNote = typeof sections.methodologyNote === "string" ? sections.methodologyNote : "";
  const coverageCard = (sections.coverageCard ?? {}) as Record<string, unknown>;
  const gapSummary = typeof coverageCard.gapSummary === "string" ? coverageCard.gapSummary : "";

  const combined = [abstractSummary, summaryBullets.join("\n"), strongestEvidence, methodologyNote, gapSummary]
    .join("\n");
  if (combined.trim().length === 0) return noChange;

  // Scope the dossier to papers the prose references (workId citation, author
  // token, or title prefix) — same rationale as verifyChatAnswer's scoping.
  const bracketTokens = new Set(
    [...combined.matchAll(/\[([^\[\]]{2,80})\]/g)].map((m) => m[1].trim()),
  );
  const referenced = (r: EvidenceRowLite): boolean => {
    if (bracketTokens.has(r.workId)) return true;
    const firstAuthorTokens = (r.authors?.[0] || "").split(/[\s,.]+/);
    if (firstAuthorTokens.some((t) => t.length >= 4 && combined.includes(t))) return true;
    const titlePrefix = (r.title || "").slice(0, 25);
    return titlePrefix.length >= 15 && combined.toLowerCase().includes(titlePrefix.toLowerCase());
  };
  const scopedRows = evidenceRows.filter(referenced);
  // Brief prose that references no specific paper has nothing to fact-check.
  if (scopedRows.length === 0) return noChange;

  const langNote = lang === "es"
    ? "The draft is in SPANISH — corrections must stay in Spanish."
    : lang === "pt"
    ? "The draft is in PORTUGUESE — corrections must stay in Portuguese."
    : "";

  const prompt = `You are a fact-checker for a policy evidence brief. The EVIDENCE TABLE below is the ground truth for every paper the draft references — authoritative methodology, SMS level, authors, year, geography, and abstract.

Read each DRAFT FIELD and rewrite ONLY sentences that make claims about specific papers contradicting the table (wrong methodology/SMS/year/authors, invented effect sizes/countries/findings). Keep everything else verbatim — tone, structure, [workId] citations, and length. ${langNote}

Rules:
- If the draft says a paper uses "DiD/SMS 4" but the table says "Observational/SMS 2", rewrite to match the table.
- If the draft invents an effect size, country, or finding not supported by the abstract in the table, drop or soften the claim.
- Do NOT add new content, new citations, or new papers. Do NOT shorten correct sentences.
- summaryBullets: return the FULL corrected array with the SAME number of bullets in the same order.

EVIDENCE TABLE (ground truth for referenced papers):
${buildDossier(scopedRows)}

DRAFT FIELDS:
abstractSummary: ${abstractSummary || "(empty)"}

summaryBullets:
${summaryBullets.map((b, i) => `${i + 1}. ${b}`).join("\n") || "(empty)"}

strongestEvidence: ${strongestEvidence || "(empty)"}

methodologyNote: ${methodologyNote || "(empty)"}

gapSummary: ${gapSummary || "(empty)"}

Return JSON only. Include ONLY the fields you actually corrected (omit fields that are already accurate); set changed=false with no other keys if nothing needed correction:
{"changed": true, "abstractSummary": "...", "summaryBullets": ["...", "..."], "strongestEvidence": "...", "methodologyNote": "...", "gapSummary": "..."}`;

  try {
    const result = await qwenGenerateJSON<{
      changed?: boolean;
      abstractSummary?: unknown;
      summaryBullets?: unknown;
      strongestEvidence?: unknown;
      methodologyNote?: unknown;
      gapSummary?: unknown;
      // Post-done → latency is invisible; give the bigger multi-field prompt
      // more room than the chat verifier's 25s.
    }>(prompt, { temperature: 0.1, timeoutMs: 40_000 });
    if (!result || result.changed === false) return noChange;

    // Per-field acceptance: real string, retains ≥70% of the original length,
    // ends cleanly, and actually differs. Reject-per-field, never wholesale.
    const acceptText = (corrected: unknown, original: string): string | undefined => {
      if (typeof corrected !== "string") return undefined;
      const c = corrected.trim();
      if (!c || c === original.trim() || !original.trim()) return undefined;
      if (c.length / Math.max(1, original.trim().length) < 0.7) return undefined;
      if (!/[.!?)"'”’\]]\s*$/.test(c)) return undefined;
      return c;
    };

    const out: {
      abstractSummary?: string;
      summaryBullets?: string[];
      strongestEvidence?: string;
      methodologyNote?: string;
      coverageCard?: Record<string, unknown>;
    } = {};

    const correctedAbstract = acceptText(result.abstractSummary, abstractSummary);
    if (correctedAbstract) out.abstractSummary = correctedAbstract;

    if (Array.isArray(result.summaryBullets) && summaryBullets.length > 0) {
      const bullets = result.summaryBullets;
      const allStrings = bullets.every((b): b is string => typeof b === "string" && b.trim().length > 0);
      const totalNew = allStrings ? bullets.join("\n").length : 0;
      const totalOld = summaryBullets.join("\n").length;
      if (
        allStrings &&
        bullets.length === summaryBullets.length &&
        totalNew / Math.max(1, totalOld) >= 0.7 &&
        bullets.join("\n") !== summaryBullets.join("\n")
      ) {
        out.summaryBullets = bullets.map((b) => b.trim());
      }
    }

    const correctedStrongest = acceptText(result.strongestEvidence, strongestEvidence);
    if (correctedStrongest) out.strongestEvidence = correctedStrongest;

    const correctedMethodology = acceptText(result.methodologyNote, methodologyNote);
    if (correctedMethodology) out.methodologyNote = correctedMethodology;

    const correctedGap = acceptText(result.gapSummary, gapSummary);
    if (correctedGap) out.coverageCard = { gapSummary: correctedGap };

    const changed = Object.keys(out).length > 0;
    if (changed) {
      console.log(`[verifier] brief sections corrected: ${Object.keys(out).join(", ")}`);
    }
    return { changed, sections: out };
  } catch (err) {
    console.error("[verifier] brief-section check failed (non-blocking):", (err as Error).message);
    return noChange;
  }
}

/**
 * Cheap number-check for the LLM-drafted "so-what" sentences in the
 * methodology and coverage boxes. The deterministic stats (evidenceCount,
 * strongCount, strongShare, lacCount) are ground truth — if Gemini cites a
 * different total or percentage, swap it in place. Conservative: only fixes
 * the most common drift pattern ("N of M papers" where M is wrong, or "N%"
 * where N is far off from the true SMS 4-5 share).
 *
 * Synchronous, sub-millisecond, no LLM call.
 */
export interface SoWhatStats {
  evidenceCount: number;
  strongCount: number; // SMS 4-5 papers
  strongShare: number; // % at SMS 4-5
  lacCount: number;    // papers with LAC country mention
}

export function verifySoWhatNumbers(text: string | null | undefined, stats: SoWhatStats): string {
  if (!text) return "";
  let out = text;

  // "N of M papers" — verify M matches evidenceCount. If not, swap M.
  out = out.replace(/(\d+)\s+of\s+(\d+)\s+papers/gi, (match, nStr, mStr) => {
    const M = parseInt(mStr, 10);
    if (M === stats.evidenceCount) return match;
    // Common drift: Gemini cites a slightly-wrong total. Replace with the truth.
    return `${nStr} of ${stats.evidenceCount} papers`;
  });

  // "N/M papers" — same check (compact form).
  out = out.replace(/(\d+)\/(\d+)\s+papers/gi, (match, nStr, mStr) => {
    const M = parseInt(mStr, 10);
    if (M === stats.evidenceCount) return match;
    return `${nStr}/${stats.evidenceCount} papers`;
  });

  // "N% [are|reach|at] SMS 4(-|–|to )5" → swap N if it disagrees with strongShare by >3pp.
  out = out.replace(
    /(\d+)\s*%\s*(?:of\s+(?:papers|the\s+(?:set|sample|evidence)))?\s*(?:are|reach|at|meet)?\s*SMS\s*4[-–\s]*(?:to\s*)?5/gi,
    (match, nStr) => {
      const N = parseInt(nStr, 10);
      if (Math.abs(N - stats.strongShare) <= 3) return match;
      return match.replace(/\d+\s*%/, `${stats.strongShare}%`);
    },
  );

  // "N LAC[-based]? papers" or "N are LAC[-based]" → swap if disagrees with lacCount.
  out = out.replace(
    /(\d+)\s+(?:are\s+)?LAC(?:-based)?(?:\s+papers)?/gi,
    (match, nStr) => {
      const N = parseInt(nStr, 10);
      if (N === stats.lacCount) return match;
      return match.replace(/\d+/, String(stats.lacCount));
    },
  );

  // "N of M [are|reach] SMS 4-5" → check N == strongCount when M == evidenceCount.
  out = out.replace(
    /(\d+)\s+of\s+(\d+)\s+(?:are|reach|meet|at)\s+SMS\s*4[-–\s]*(?:to\s*)?5/gi,
    (match, nStr, mStr) => {
      const N = parseInt(nStr, 10);
      const M = parseInt(mStr, 10);
      if (M === stats.evidenceCount && N === stats.strongCount) return match;
      return match.replace(/\d+\s+of\s+\d+/, `${stats.strongCount} of ${stats.evidenceCount}`);
    },
  );

  return out;
}

/**
 * Regenerate follow-up questions from the evidence table + deterministic gap
 * analysis. Replaces Gemini's draft entirely so the questions are guaranteed
 * answerable from what we actually retrieved.
 */
export async function regenerateFollowUps(
  query: string,
  evidenceRows: EvidenceRowLite[],
  gapNotes: { regionalGap?: string; thinEvidenceAreas?: string; methodologicalGap?: string },
): Promise<string[] | null> {
  if (evidenceRows.length === 0) return null;

  const dossier = buildDossier(evidenceRows.slice(0, 30));
  const gapBlock = [
    gapNotes.regionalGap ? `LAC evidence: ${gapNotes.regionalGap}` : "",
    gapNotes.thinEvidenceAreas ? `Thin areas: ${gapNotes.thinEvidenceAreas}` : "",
    gapNotes.methodologicalGap ? `Methods needed: ${gapNotes.methodologicalGap}` : "",
  ].filter(Boolean).join("\n");

  const prompt = `You generate follow-up research questions for an evidence brief. Each question MUST be answerable by drilling into the evidence table OR by naming a specific gap that the table reveals. NO speculative questions about studies we did not retrieve.

Original query: ${query}

EVIDENCE TABLE (top 30 papers):
${dossier}

GAP ANALYSIS:
${gapBlock || "(no major gaps detected)"}

Write 3-4 follow-up questions a policy analyst would naturally ask next. Each question should reference either a specific paper from the table (by author + year), a named country/region/topic from the table, or a gap from the analysis. NO generic "what does the literature say about X" — be concrete.

Return JSON only:
{"questions": ["question 1", "question 2", "question 3", "question 4"]}`;

  try {
    const result = await qwenGenerateJSON<{ questions: string[] }>(prompt, {
      temperature: 0.2,
      timeoutMs: VERIFIER_TIMEOUT_MS,
    });
    if (Array.isArray(result?.questions) && result.questions.length > 0) {
      return result.questions.slice(0, 4).filter((q) => typeof q === "string" && q.trim().length > 0);
    }
    return null;
  } catch (err) {
    console.error("[verifier] follow-up regen failed:", (err as Error).message);
    return null;
  }
}
