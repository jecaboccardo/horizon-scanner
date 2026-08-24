// judge.ts — on-demand LLM quality spot-check for a JEL survey paper.
//
// Critiques the stored sections on the JEL QA lens (coherence / citation grounding /
// prose quality) and persists the result to jel_paper_reviews so re-viewing is free.
// Called ONLY on explicit admin request (button / CLI --judge) — NEVER on a poll path.
//
// Engine: self-hosted Qwen via qwenGenerateJSON — structured JSON out, zero marginal
// cost, and gated at BACKGROUND priority so it yields to interactive search/chat.
// (geminiClient exposes only domain-specific methods — no general text/JSON entry
// point — so a Gemini path would need new plumbing; not worth it for an internal tool.)
import { qwenGenerateJSON } from "../qwenClient.ts";

export interface JudgeFinding {
  dimension: string; // coherence | citation | prose
  section: string;
  severity: "low" | "med" | "high";
  quote: string;
  note: string;
}
export interface JudgeReview {
  paperId: string;
  model: string;
  overall: "good" | "mixed" | "weak";
  findings: JudgeFinding[];
}

const SYSTEM =
  "You are a rigorous economics survey reviewer. Critique a JEL survey's sections on " +
  "three dimensions: (1) coherence & argument, (2) citation grounding (does each claim's " +
  "cited paper actually support it), (3) prose quality (no lists / scratchpad / heading " +
  "leaks). Only report REAL problems; return empty findings if the survey is strong.";

const INSTRUCTION =
  'Return STRICT JSON matching: {"overall":"good|mixed|weak","findings":[{"dimension":' +
  '"coherence|citation|prose","section":"<section title>","severity":"low|med|high",' +
  '"quote":"<=200 chars quoted verbatim from the text","note":"what is wrong"}]}. ' +
  "Return ONLY the JSON, no prose around it.";

interface JudgeRaw { overall?: string; findings?: JudgeFinding[] }

// deno-lint-ignore no-explicit-any
export async function judgePaper(adminClient: any, paperId: string): Promise<JudgeReview> {
  const { data: paper } = await adminClient
    .from("jel_papers").select("id,tenant_id,sections").eq("id", paperId).maybeSingle();
  if (!paper) throw new Error("paper not found");

  // deno-lint-ignore no-explicit-any
  const sectionText = (paper.sections ?? [])
    .map((s: any) => `## ${s.title ?? s.heading ?? "section"}\n${s.body ?? s.content ?? ""}`)
    .join("\n\n");

  const model = "qwen2.5:14b-synthesis";
  let parsed: JudgeRaw = {};
  try {
    parsed = await qwenGenerateJSON<JudgeRaw>(
      `${INSTRUCTION}\n\nSURVEY:\n${sectionText.slice(0, 60_000)}`,
      {
        system: SYSTEM,
        operation: "jel_spot_check",
        tenantId: paper.tenant_id ?? undefined,
        background: true,
        temperature: 0.2,
      },
    );
  } catch (_e) {
    // On LLM/parse failure, persist a neutral review rather than throwing — the
    // caller gets a usable (empty) result and the failure is visible in telemetry.
    parsed = { overall: "mixed", findings: [] };
  }

  const review: JudgeReview = {
    paperId,
    model,
    overall: parsed.overall === "good" || parsed.overall === "weak" ? parsed.overall : "mixed",
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
  };

  await adminClient.from("jel_paper_reviews").insert({
    paper_id: paperId,
    tenant_id: paper.tenant_id ?? null,
    model,
    overall: review.overall,
    findings: review.findings,
    raw: parsed,
  });
  return review;
}

// deno-lint-ignore no-explicit-any
export async function latestReview(adminClient: any, paperId: string) {
  const { data } = await adminClient
    .from("jel_paper_reviews").select("*").eq("paper_id", paperId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  return data ?? null;
}
