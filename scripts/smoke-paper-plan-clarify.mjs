// Integration smoke for the clarify + outline-preview endpoints.
// Prereqs:
//   - local Deno API running (npm run start:api) on $API_BASE (default :3002)
//   - $TEST_BEARER: a valid Supabase access token for a tenant
//   - $TEST_SEARCH_RUN_ID: an existing search_runs.id for that tenant with evidence
// NOTE: this asserts the CONTRACT, which holds even when the LLM is unreachable
//   (the degrade path returns 200 with the staples + workingQuestion = query).
const API = process.env.API_BASE || "http://127.0.0.1:3002";
const token = process.env.TEST_BEARER;
const runId = process.env.TEST_SEARCH_RUN_ID;
if (!token || !runId) { console.error("Set TEST_BEARER and TEST_SEARCH_RUN_ID"); process.exit(2); }
const h = { "content-type": "application/json", authorization: `Bearer ${token}` };
function assert(c, m) { if (!c) { console.error("FAIL:", m); process.exit(1); } }

// Seed a plan
const created = await (await fetch(`${API}/api/paper-plans`, {
  method: "POST", headers: h, body: JSON.stringify({ searchRunId: runId }),
})).json();
assert(created.id, "plan create failed");

// Clarify
const clarRes = await fetch(`${API}/api/paper-plans/${created.id}/clarify`, { method: "POST", headers: h });
assert(clarRes.status === 200, `clarify expected 200, got ${clarRes.status}`);
const clar = await clarRes.json();
assert(Array.isArray(clar.clarifyingQuestions) && clar.clarifyingQuestions.length <= 3, "0–3 clarifying questions");
assert(clar.alwaysAsk && Array.isArray(clar.alwaysAsk.audience) && clar.alwaysAsk.audience.includes("policy"), "audience staple present");
assert(Array.isArray(clar.alwaysAsk.lengthOptions) && clar.alwaysAsk.lengthOptions.length >= 2, "length options present");
assert(typeof clar.workingQuestion === "string" && clar.workingQuestion.length > 0, "workingQuestion present");
assert(typeof clar.degraded === "boolean", "degraded flag present");
console.log(`clarify: ${clar.degraded ? "DEGRADED (no LLM)" : "LLM"} · ${clar.clarifyingQuestions.length} Qs · outline=${clar.draftOutline ? clar.draftOutline.sections.length + " sections" : "none"}`);

// Outline preview
const opRes = await fetch(`${API}/api/paper-plans/${created.id}/outline-preview`, { method: "POST", headers: h });
assert(opRes.status === 200, `outline-preview expected 200, got ${opRes.status}`);
const op = await opRes.json();
assert(typeof op.degraded === "boolean", "outline-preview degraded flag");
assert(op.outlinePreview === null || (op.outlinePreview.title && Array.isArray(op.outlinePreview.sections)), "outlinePreview shape");
console.log(`outline-preview: ${op.degraded ? "DEGRADED" : (op.outlinePreview.sections.length + " sections")}`);

// If the LLM produced an outline, confirm it persisted on the plan
if (clar.draftOutline || op.outlinePreview) {
  const fetched = await (await fetch(`${API}/api/paper-plans/${created.id}`, { headers: h })).json();
  assert(fetched.plan.outlinePreview, "outlinePreview persisted on the plan");
}

console.log("smoke-paper-plan-clarify: PASS");
