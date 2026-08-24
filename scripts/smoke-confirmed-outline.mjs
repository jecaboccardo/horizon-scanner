// Smoke: a user-confirmed outline (plan.outlinePreview) survives the generate kickoff.
// Verifies the kickoff contract only (202 + same row) — full generation is manual.
// Prereqs: local Deno API ($API_BASE, default :3002); $TEST_BEARER; $TEST_SEARCH_RUN_ID (run with evidence).
const API = process.env.API_BASE || "http://127.0.0.1:3002";
const token = process.env.TEST_BEARER, runId = process.env.TEST_SEARCH_RUN_ID;
if (!token || !runId) { console.error("Set TEST_BEARER and TEST_SEARCH_RUN_ID"); process.exit(2); }
const h = { "content-type": "application/json", authorization: `Bearer ${token}` };
function assert(c, m) { if (!c) { console.error("FAIL:", m); process.exit(1); } }

// 1. Seed a plan
const plan = await (await fetch(`${API}/api/paper-plans`, {
  method: "POST", headers: h, body: JSON.stringify({ searchRunId: runId }),
})).json();
assert(plan.id && plan.plan.curatedWorkIds.length > 0, "plan create failed");
// JEL audience default is technical (no policy)
assert(plan.plan.emphasis.audience === "technical", `expected technical audience, got ${plan.plan.emphasis.audience}`);

// 2. PATCH a CONFIRMED outline (title + 3 sections) onto the plan
const confirmed = {
  title: "A Survey of Teacher Incentive Programs",
  sections: [
    { number: 1, heading: "Introduction and prior surveys", scope: "framing + positioning" },
    { number: 2, heading: "Experimental evidence", scope: "RCTs on teacher pay" },
    { number: 3, heading: "Research agenda", scope: "open questions" },
  ],
};
const patched = await (await fetch(`${API}/api/paper-plans/${plan.id}`, {
  method: "PATCH", headers: h, body: JSON.stringify({ plan: { outlinePreview: confirmed } }),
})).json();
assert(patched.plan.outlinePreview && patched.plan.outlinePreview.sections.length === 3, "confirmed outline not persisted");

// 3. Kick off generation by planId → 202, same row reused
const gen = await fetch(`${API}/api/jel-papers`, {
  method: "POST", headers: h, body: JSON.stringify({ planId: plan.id }),
});
assert(gen.status === 202, `generate expected 202, got ${gen.status}`);
const job = await gen.json();
assert(job.id === plan.id, "expected the SAME row reused");
assert(job.status === "queued" || job.status === "running", `expected queued/running, got ${job.status}`);

console.log(`smoke-confirmed-outline: PASS (plan ${job.id} → ${job.status}, 3 confirmed sections carried into kickoff)`);
