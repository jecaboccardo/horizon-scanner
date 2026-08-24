// Smoke for revise kickoff + cap. Prereqs: local Deno API ($API_BASE), $TEST_BEARER,
// and $TEST_DONE_PAPER_ID = a jel_papers id with status='done' for that tenant.
const API = process.env.API_BASE || "http://127.0.0.1:3002";
const token = process.env.TEST_BEARER, paperId = process.env.TEST_DONE_PAPER_ID;
if (!token || !paperId) { console.error("Set TEST_BEARER and TEST_DONE_PAPER_ID"); process.exit(2); }
const h = { "content-type": "application/json", authorization: `Bearer ${token}` };
function assert(c, m) { if (!c) { console.error("FAIL:", m); process.exit(1); } }

// Missing instruction → 400
const bad = await fetch(`${API}/api/jel-papers/${paperId}/revise`, { method: "POST", headers: h, body: "{}" });
assert(bad.status === 400, `empty instruction expected 400, got ${bad.status}`);

// Valid kickoff → 202 + status running
const res = await fetch(`${API}/api/jel-papers/${paperId}/revise`, {
  method: "POST", headers: h, body: JSON.stringify({ instruction: "Make the introduction more concise." }),
});
assert(res.status === 202 || res.status === 409, `revise expected 202 (or 409 if cap/again), got ${res.status}`);
if (res.status === 202) {
  const job = await res.json();
  assert(job.id === paperId && job.status === "running", "expected same row, status running");
  console.log(`smoke-paper-revise: PASS (202, regen so far ${job.regenerationsUsed ?? 0})`);
} else {
  console.log("smoke-paper-revise: PASS (409 — cap reached or busy; gate works)");
}
