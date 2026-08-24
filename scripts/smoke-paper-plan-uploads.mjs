// Integration smoke for uploads (paste path → preview → confirm → list).
// Prereqs: local Deno API (npm run start:api) on $API_BASE (default :3002);
//   $TEST_BEARER (tenant token); $TEST_SEARCH_RUN_ID (a run with evidence).
//   Qwen reachable for paste extraction/SMS; if not, the card has nulls but the
//   attach/signal/list contract still holds (assertions tolerate null metadata).
const API = process.env.API_BASE || "http://127.0.0.1:3002";
const token = process.env.TEST_BEARER, runId = process.env.TEST_SEARCH_RUN_ID;
if (!token || !runId) { console.error("Set TEST_BEARER and TEST_SEARCH_RUN_ID"); process.exit(2); }
const h = { "content-type": "application/json", authorization: `Bearer ${token}` };
function assert(c, m) { if (!c) { console.error("FAIL:", m); process.exit(1); } }

const plan = await (await fetch(`${API}/api/paper-plans`, {
  method: "POST", headers: h, body: JSON.stringify({ searchRunId: runId }),
})).json();
assert(plan.id, "plan create failed");
const before = (plan.plan.uploads ?? []).length;

const paste = "Smith and Doe (2021). A field experiment on teacher incentives in rural schools. We run a randomized controlled trial across 200 schools measuring test-score effects.";

// 1. Preview (no persist)
const prev = await (await fetch(`${API}/api/paper-plans/${plan.id}/uploads`, {
  method: "POST", headers: h, body: JSON.stringify({ pastedText: paste }),
})).json();
assert(prev.upload && prev.upload.uploadId, "preview missing upload card");
assert(typeof prev.inCorpus === "boolean" && (prev.kind === "add_new" || prev.kind === "add_existing"), "preview kind/inCorpus");

// 2. Confirm with the SAME uploadId → attaches + writes signal
const confRes = await fetch(`${API}/api/paper-plans/${plan.id}/uploads`, {
  method: "POST", headers: h,
  body: JSON.stringify({ pastedText: paste, uploadId: prev.upload.uploadId, confirm: true }),
});
assert(confRes.status === 201, `confirm expected 201, got ${confRes.status}`);
const conf = await confRes.json();
assert(conf.attached === true, "confirm did not attach");

// 3. Plan now has one more upload
const fetched = await (await fetch(`${API}/api/paper-plans/${plan.id}`, { headers: h })).json();
assert((fetched.plan.uploads ?? []).length === before + 1, "upload not attached to plan");

// 4. Library list includes it
const list = await (await fetch(`${API}/api/paper-uploads`, { headers: h })).json();
assert(Array.isArray(list.uploads) && list.uploads.some(u => u.uploadId === prev.upload.uploadId), "upload missing from library list");

console.log(`smoke-paper-plan-uploads: PASS (kind=${prev.kind}, sms=${prev.upload.smsLevel})`);
