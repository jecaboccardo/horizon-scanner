// scripts/jel-survey/pin-eval-search-runs.ts
//
// Pins canonical `search_run_id`s for the JEL eval fixture so downstream
// skills (#2 evidence coding, #3 prior-survey positioning, #4 section drafter)
// can hold retrieval constant during model A/Bs.
//
// Bypasses the HTTP API to skip the auth gate: imports retrieveWorks directly
// and inserts the search_run row via the admin client (service role).
// search_runs.user_id is NOT NULL → uses the first admin email's auth user
// (or --user-id / EVAL_USER_ID override).
//
// Usage:
//   deno run --allow-net --allow-env --allow-read --allow-write --allow-sys \
//     --env-file=.env --config=server-deno/deno.json \
//     scripts/jel-survey/pin-eval-search-runs.ts [flags]
//
// Flags:
//   --only <id>      Pin only this query id (default: all unpinned)
//   --force          Repin even if pinnedSearchRunId is already set
//   --dry-run        Print plan, don't insert or write fixture
//   --user-id <uuid> Use this user_id (overrides env + auto-discovery)

import { adminClient } from "../../supabase/functions/_shared/supabase.ts";
import { planSearchIntent, retrieveWorks, type CoverageStats } from "../../supabase/functions/_shared/retrieval.ts";

const FIXTURE_PATH = new URL("../../evals/jel-survey-queries.json", import.meta.url);

const ADMIN_EMAILS = ["", ""];

interface FixtureQuery {
  id: string;
  query: string;
  filters?: Record<string, unknown>;
  pinnedSearchRunId: string | null;
  [k: string]: unknown;
}

interface Fixture {
  queries: FixtureQuery[];
  [k: string]: unknown;
}

function parseArgs(argv: string[]): {
  only: string | null;
  force: boolean;
  dryRun: boolean;
  userIdOverride: string | null;
} {
  const out = { only: null as string | null, force: false, dryRun: false, userIdOverride: null as string | null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--only") { out.only = next ?? null; i++; }
    else if (flag === "--force") { out.force = true; }
    else if (flag === "--dry-run") { out.dryRun = true; }
    else if (flag === "--user-id") { out.userIdOverride = next ?? null; i++; }
  }
  return out;
}

async function resolveUserId(override: string | null): Promise<string> {
  if (override) return override;
  const envOverride = Deno.env.get("EVAL_USER_ID");
  if (envOverride) return envOverride;

  // Auto-discover: ask supabase admin for the first ADMIN_EMAILS user.
  // listUsers paginates 50 at a time — for our project that's plenty.
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (adminClient.auth.admin as any).listUsers({ page: 1, perPage: 200 });
  if (error) throw new Error(`auth.admin.listUsers failed: ${error.message}`);
  // deno-lint-ignore no-explicit-any
  const users: any[] = data?.users ?? [];
  for (const email of ADMIN_EMAILS) {
    const u = users.find((x) => String(x.email || "").toLowerCase() === email);
    if (u?.id) {
      console.log(`[pin] resolved user_id from ${email} → ${u.id}`);
      return u.id;
    }
  }
  throw new Error(`No admin user found in auth.users matching: ${ADMIN_EMAILS.join(", ")}. Set EVAL_USER_ID or pass --user-id.`);
}

async function loadFixture(): Promise<Fixture> {
  const raw = await Deno.readTextFile(FIXTURE_PATH);
  return JSON.parse(raw) as Fixture;
}

async function writeFixture(fixture: Fixture): Promise<void> {
  // Atomic write: tmp file + rename.
  const tmp = new URL(FIXTURE_PATH.href + ".tmp");
  const text = JSON.stringify(fixture, null, 2) + "\n";
  await Deno.writeTextFile(tmp, text);
  await Deno.rename(tmp, FIXTURE_PATH);
}

// deno-lint-ignore no-explicit-any
function buildClassificationMap(retrieved: any): Record<string, unknown> | null {
  // Mirrors supabase/functions/api/index.ts:514-553.
  // deno-lint-ignore no-explicit-any
  const map: Record<string, any> = {};
  const source = [...(retrieved.candidates ?? []), ...(retrieved.evidence ?? [])];
  for (const w of source) {
    if (!w?.id || !w?.evidenceMatch) continue;
    map[w.id] = {
      classification: w.classification,
      evidenceMatch: w.evidenceMatch,
      facetScores: w.facetScores,
      gmRequired: w.gmRequired,
      facetsMatched: w.facetsMatched ?? [],
      facetsMissed: w.facetsMissed ?? [],
      geographyMatched: w.geographyMatched,
      surfacedFromHyde: w.surfacedFromHyde === true,
      hydeSimilarity: typeof w.hydeSimilarity === "number" ? w.hydeSimilarity : undefined,
      llmRationale: typeof w.llmRationale === "string" ? w.llmRationale : undefined,
      trainedProbs: Array.isArray(w.trainedProbs) ? w.trainedProbs : undefined,
    };
  }
  return Object.keys(map).length > 0 ? map : null;
}

async function pinOne(q: FixtureQuery, userId: string, dryRun: boolean): Promise<string | null> {
  console.log(`\n[pin] ${q.id}`);
  console.log(`  query: ${q.query}`);
  // deno-lint-ignore no-explicit-any
  const filters: any = q.filters ?? {};
  const intent = planSearchIntent(q.query, filters);

  const t0 = Date.now();
  const retrieved = await retrieveWorks(q.query, filters, { supabaseClient: adminClient, userId });
  const dt = Date.now() - t0;

  const cov: CoverageStats = retrieved.coverage;
  console.log(`  retrieved in ${dt}ms — candidates=${retrieved.candidates?.length ?? 0} evidence=${retrieved.evidence?.length ?? 0} signals=${retrieved.signals?.length ?? 0}`);
  console.log(`  coverage: universe=${cov.universeCount ?? "?"} retrieved=${cov.retrievedCount ?? "?"} admissible=${cov.admissibleCount ?? "?"} evidence=${cov.evidenceCount ?? "?"}`);

  if (dryRun) {
    console.log(`  [dry-run] skipping insert`);
    return null;
  }

  const classificationMap = buildClassificationMap(retrieved);
  const { data: row, error } = await adminClient
    .from("search_runs")
    .insert({
      user_id: userId,
      query: q.query,
      filters,
      intent,
      // deno-lint-ignore no-explicit-any
      candidate_work_ids: (retrieved.candidates ?? []).map((w: any) => w.id),
      // deno-lint-ignore no-explicit-any
      evidence_work_ids: (retrieved.evidence ?? []).map((w: any) => w.id),
      // deno-lint-ignore no-explicit-any
      signal_work_ids: (retrieved.signals ?? []).map((w: any) => w.id),
      coverage: retrieved.coverage,
      retrieval_notes: retrieved.retrievalNotes,
      evidence_classification: classificationMap,
      // deno-lint-ignore no-explicit-any
      query_facets: (retrieved as any).facets ?? null,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`insert failed for ${q.id}: ${error.message}`);
  }
  console.log(`  ✓ inserted search_run id=${row.id}`);
  return row.id as string;
}

async function main() {
  const args = parseArgs(Deno.args);
  const userId = await resolveUserId(args.userIdOverride);

  const fixture = await loadFixture();
  const queries = fixture.queries ?? [];
  const targets = args.only
    ? queries.filter((q) => q.id === args.only)
    : queries.filter((q) => args.force || !q.pinnedSearchRunId);

  if (targets.length === 0) {
    console.log(args.only
      ? `No query matches --only=${args.only}.`
      : `All queries already pinned. Use --force to repin.`);
    return;
  }

  console.log(`Pinning ${targets.length} of ${queries.length} queries (user_id=${userId}, dry-run=${args.dryRun}, force=${args.force}).`);

  const results: Array<{ id: string; pinned: string | null; error?: string }> = [];
  for (const q of targets) {
    try {
      const newId = await pinOne(q, userId, args.dryRun);
      if (newId) q.pinnedSearchRunId = newId;
      results.push({ id: q.id, pinned: newId });
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`  ✗ ${q.id}: ${msg}`);
      results.push({ id: q.id, pinned: null, error: msg });
    }
  }

  if (!args.dryRun) {
    await writeFixture(fixture);
    console.log(`\nFixture updated: ${FIXTURE_PATH.pathname}`);
  } else {
    console.log(`\n[dry-run] fixture not written`);
  }

  console.log(`\nSummary:`);
  for (const r of results) {
    if (r.error) console.log(`  ✗ ${r.id} — ${r.error}`);
    else if (r.pinned) console.log(`  ✓ ${r.id} — ${r.pinned}`);
    else console.log(`  · ${r.id} — (dry-run)`);
  }
}

main().catch((err) => {
  console.error("[pin] fatal:", err);
  Deno.exit(1);
});
