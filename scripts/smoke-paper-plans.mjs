// Integration smoke for the paper-plans endpoints.
// Prereqs:
//   - local Deno API running (npm run start:api) on $API_BASE (default :3002)
//   - $TEST_BEARER: a valid Supabase access token for a tenant
//   - $TEST_SEARCH_RUN_ID: an existing search_runs.id for that tenant with evidence
const API = process.env.API_BASE || "http://127.0.0.1:3002";
const token = process.env.TEST_BEARER;
const runId = process.env.TEST_SEARCH_RUN_ID;
if (!token || !runId) {
  console.error("Set TEST_BEARER and TEST_SEARCH_RUN_ID env vars"); process.exit(2);
}
const h = { "content-type": "application/json", authorization: `Bearer ${token}` };
function assert(cond, msg) { if (!cond) { console.error("FAIL:", msg); process.exit(1); } }

const createRes = await fetch(`${API}/api/paper-plans`, {
  method: "POST", headers: h, body: JSON.stringify({ searchRunId: runId }),
});
assert(createRes.status === 201, `POST /api/paper-plans expected 201, got ${createRes.status}`);
const plan = await createRes.json();
assert(plan.status === "planning", `expected status=planning, got ${plan.status}`);
assert(plan.plan && Array.isArray(plan.plan.curatedWorkIds) && plan.plan.curatedWorkIds.length > 0,
  "expected seeded curatedWorkIds from the run's evidence");
assert(plan.plan.emphasis.audience === "policy", "expected default audience=policy");
assert(plan.plan.workingQuestion && plan.plan.workingQuestion.length > 0, "expected workingQuestion seeded from query");

const getRes = await fetch(`${API}/api/paper-plans/${plan.id}`, { headers: h });
assert(getRes.status === 200, `GET expected 200, got ${getRes.status}`);

const patchRes = await fetch(`${API}/api/paper-plans/${plan.id}`, {
  method: "PATCH", headers: h,
  body: JSON.stringify({ plan: { emphasis: { themes: ["cost-effectiveness"], audience: "technical", targetWords: 16000 } } }),
});
assert(patchRes.status === 200, `PATCH expected 200, got ${patchRes.status}`);
const patched = await patchRes.json();
assert(patched.plan.emphasis.audience === "technical", "expected patched audience=technical");
assert(patched.plan.curatedWorkIds.length === plan.plan.curatedWorkIds.length,
  "expected curatedWorkIds preserved through shallow merge");

console.log("smoke-paper-plans: PASS");
