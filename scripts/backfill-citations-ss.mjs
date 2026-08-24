#!/usr/bin/env node
/**
 * Backfill citation_count from Semantic Scholar for papers where OA has no data.
 * Targets: canonical non-noise papers with citation_count IS NULL and DOI-format IDs.
 * SS batch API: up to 500 DOIs per request, fields=citationCount.
 * Safe to run repeatedly — skips papers already updated (they leave the IS NULL set).
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-citations-ss.mjs
 */
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
const SS_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY || "";
const BATCH = 500;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let processed = 0, updated = 0, missing = 0, errors = 0;
const start = Date.now();
console.log("=== SS Citation backfill ===");
console.log("Key:", SS_KEY ? SS_KEY.slice(0,8)+"..." : "(none)");
let page = 0;
while (true) {
  const { data: rows, error } = await supabase
    .from("works")
    .select("id, canonical_doi")
    .eq("is_noise", false)
    .is("canonical_work_id", null)
    .is("citation_count", null)
    .like("id", "10.%")
    .range(page * BATCH, (page + 1) * BATCH - 1)
    .order("id");
  if (error) { console.error("fetch err:", error.message); break; }
  if (!rows || rows.length === 0) break;
  const ids = rows.map(r => "DOI:" + (r.canonical_doi || r.id));
  let ssData = [];
  try {
    const headers = { "Content-Type": "application/json" };
    if (SS_KEY) headers["x-api-key"] = SS_KEY;
    const res = await fetch(
      "https://api.semanticscholar.org/graph/v1/paper/batch?fields=citationCount",
      { method: "POST", headers, body: JSON.stringify({ ids }), signal: AbortSignal.timeout(30000) }
    );
    if (res.status === 429) { console.log("rate limited, waiting 5s"); await sleep(5000); continue; }
    ssData = await res.json();
    if (!Array.isArray(ssData)) { await sleep(2000); page++; continue; }
  } catch(e) { errors++; await sleep(2000); page++; continue; }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const ss = ssData[i];
    processed++;
    if (!ss || ss.citationCount == null) { missing++; continue; }
    const { error: ue } = await supabase.from("works")
      .update({ citation_count: ss.citationCount })
      .eq("id", row.id);
    if (ue) { errors++; continue; }
    updated++;
  }
  const elapsed = ((Date.now() - start) / 60000).toFixed(1);
  console.log(processed+"/"+rows.length+" | upd="+updated+" miss="+missing+" err="+errors+" "+elapsed+"min");
  page++;
  await sleep(1100);
}
console.log("=== Done ===");
console.log(JSON.stringify({ processed, updated, missing, errors }, null, 2));
