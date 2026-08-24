// Integration smoke for plan-driven generation kickoff.
// Prereqs: local Deno API (npm run start:api) on $API_BASE (default :3002);
//   $TEST_BEARER (tenant token); $TEST_SEARCH_RUN_ID (a run with evidence).
// Verifies the KICKOFF contract only (202 + status transition), not the full
// multi-minute generation.
const API = process.env.API_BASE || "http://127.0.0.1:3002";
const token = process.env.TEST_BEARER;
const runId = process.env.TEST_SEARCH_RUN_ID;
if (!token || !runId) { console.error("Set TEST_BEARER and TEST_SEARCH_RUN_ID"); process.exit(2); }
const h = { "content-type": "application/json", authorization: `Bearer ${token}` };
function assert(c, m) { if (!c) { console.error("FAIL:", m); process.exit(1); } }

// 1. Seed a plan (status=planning, curatedWorkIds from the run)
const plan = await (await fetch(`${API}/api/paper-plans`, {
  method: "POST", headers: h, body: JSON.stringify({ searchRunId: runId }),
})).json();
assert(plan.id && plan.status === "planning", "plan create failed");
assert(plan.plan.curatedWorkIds.length > 0, "plan seeded with no evidence");

// 2. Kick off generation by planId
const genRes = await fetch(`${API}/api/jel-papers`, {
  method: "POST", headers: h, body: JSON.stringify({ planId: plan.id }),
});
assert(genRes.status === 202, `generate expected 202, got ${genRes.status}`);
const job = await genRes.json();
assert(job.id === plan.id, "expected the SAME row reused (job.id === plan.id)");
assert(job.status === "queued" || job.status === "running", `expected queued/running, got ${job.status}`);

// 3. Second kickoff must 409 (no longer in 'planning')
const dupRes = await fetch(`${API}/api/jel-papers`, {
  method: "POST", headers: h, body: JSON.stringify({ planId: plan.id }),
});
assert(dupRes.status === 409, `re-generate expected 409, got ${dupRes.status}`);

console.log(`smoke-paper-plan-generate: PASS (job ${job.id} → ${job.status})`);
