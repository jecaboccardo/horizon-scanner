/**
 * jel-ab-generate.ts — drive the REAL JEL pipeline once, for the A/B spike.
 *
 * Creates a jel_papers row for a given search run and calls runJelPaperJob
 * directly (no HTTP server). The DOSSIER_ENRICH flag (read inside the pipeline)
 * decides baseline vs treatment behaviour.
 *
 * Run (treatment):
 *   deno run --allow-all --env-file=.env --config server-deno/deno.json \
 *     scripts/jel-ab-generate.ts <searchRunId> [tenantTag]
 *
 * Prints the new paper's jobId + final status. Export to markdown with
 * scripts/export-jel-md.mjs <jobId> <out.md>.
 */
import { createClient } from "@supabase/supabase-js";
import { runJelPaperJob } from "../supabase/functions/_shared/jelPaperPipeline.ts";

const searchRunId = Deno.args[0];
const tenantTag = Deno.args[1] ?? "ab-spike";
if (!searchRunId) {
  console.error("usage: jel-ab-generate.ts <searchRunId> [tenantTag]");
  Deno.exit(1);
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const client = createClient(SUPABASE_URL, SERVICE_KEY);

const enrich = Deno.env.get("DOSSIER_ENRICH") === "1";
console.log(`[ab] DOSSIER_ENRICH=${enrich ? "1 (treatment)" : "0 (baseline)"} run=${searchRunId}`);

const { data: run, error: runErr } = await client
  .from("search_runs").select("id, query, evidence_work_ids").eq("id", searchRunId).single();
if (runErr || !run) { console.error("run fetch failed:", runErr?.message); Deno.exit(1); }
console.log(`[ab] query: ${run.query} | evidence: ${run.evidence_work_ids?.length ?? 0}`);

const tenantId = `${tenantTag}-${enrich ? "treatment" : "baseline"}`;
const { data: job, error: insErr } = await client
  .from("jel_papers")
  .insert({ tenant_id: tenantId, search_run_id: searchRunId, brief_id: null, status: "queued", query: run.query, sections: [] })
  .select("*").single();
if (insErr || !job) { console.error("insert failed:", insErr?.message); Deno.exit(1); }
console.log(`[ab] created jel_papers row ${job.id} (tenant ${tenantId})`);

const t0 = Date.now();
try {
  await runJelPaperJob(job.id, searchRunId, tenantId, client, null, null);
} catch (e) {
  console.error("[ab] runJelPaperJob threw:", (e as Error).message);
}
const { data: final } = await client
  .from("jel_papers").select("status, sections, outline").eq("id", job.id).single();
const secs = Array.isArray(final?.sections) ? final.sections.length : 0;
console.log(`[ab] DONE in ${Math.round((Date.now() - t0) / 1000)}s — status=${final?.status} sections=${secs} title="${final?.outline?.title ?? ""}"`);
console.log(`[ab] jobId=${job.id}`);
