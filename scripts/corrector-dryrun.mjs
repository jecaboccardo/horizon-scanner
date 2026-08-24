// scripts/corrector-dryrun.mjs  — run with: deno run -A --env-file=.env scripts/corrector-dryrun.mjs <paperId>
import { createClient } from "npm:@supabase/supabase-js@2";
import { runCorrectorPass, buildDryRunMarkdown } from "../supabase/functions/_shared/corrector.ts";

const paperId = Deno.args[0] ?? "e07546b6-9037-48ec-b059-4e836d6296ac";
const sb = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const { data: paper } = await sb.from("jel_papers").select("sections, outline, search_run_id").eq("id", paperId).single();
if (!paper) { console.error("paper not found"); Deno.exit(1); }
const o = paper.outline ?? {};
const findings = {
  auditReport: o.auditReport, reviewReport: o.reviewReport,
  krisReport: o.krisReport, coherenceReport: o.coherenceReport, daRevisions: o.daRevisions ?? [],
};
// Build a coding.papers shim from the run's FULL evidence set (so corpusGaps +
// re-attribute have candidates) PLUS any cited ids; fall back to cited-only.
let evidenceIds = [];
if (paper.search_run_id) {
  const { data: run } = await sb.from("search_runs").select("evidence_work_ids").eq("id", paper.search_run_id).single();
  evidenceIds = run?.evidence_work_ids ?? [];
}
const citedIds = (paper.sections ?? []).flatMap((s) => s.citedWorkIds ?? []);
const uniq = [...new Set([...evidenceIds, ...citedIds])];
const papers = [];
for (let i = 0; i < uniq.length; i += 40) {
  const { data } = await sb.from("works").select("id,title,abstract,year").in("id", uniq.slice(i, i + 40));
  for (const w of (data ?? [])) papers.push({ workId: w.id, title: w.title, abstract: w.abstract, year: w.year });
}
const validIds = new Set(uniq);
console.log(`[dryrun] evidence set: ${evidenceIds.length} from run, ${citedIds.length} cited → ${uniq.length} unique papers`);

const { correctorReport, sectionResults } = await runCorrectorPass(
  paper.sections ?? [], { papers }, validIds, findings,
  { log: (m) => console.log("[dryrun]", m), dryRun: true },
);

const md = buildDryRunMarkdown(paperId, sectionResults, correctorReport);
await Deno.writeTextFile(`reports/corrector-dryrun-${paperId.slice(0,8)}.md`, md);
await Deno.writeTextFile(`reports/corrector-dryrun-${paperId.slice(0,8)}.json`, JSON.stringify({ correctorReport, sectionResults }, null, 2));
console.log("wrote reports/corrector-dryrun-" + paperId.slice(0,8) + ".{md,json}");
