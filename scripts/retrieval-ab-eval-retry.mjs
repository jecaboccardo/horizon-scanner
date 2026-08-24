/**
 * Retry the Q1+CrossEncoder combination that got a 502
 */

import * as fs from "fs";
import * as path from "path";

const API_BASE = "https://v0-horizon-scanner-iadb.vercel.app";
const TENANT_ID = "iadb-demo";
const USER_JWT = fs.readFileSync(path.resolve(process.cwd(), ".eval-token.txt"), "utf8").trim();

const query = "What policies effectively reduce labor market informality in Latin America?";
const body = { crossEncoder: true, crossEncoderTopN: 50 };

console.log(`Retrying Q1 + CrossEncoder...`);
const t0 = Date.now();
try {
  const res = await fetch(`${API_BASE}/api/search-runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tenant-id": TENANT_ID,
      "Authorization": `Bearer ${USER_JWT}`,
    },
    body: JSON.stringify({ query, filters: {}, ...body }),
  });
  const latency = Date.now() - t0;
  console.log(`Status: ${res.status}, Latency: ${latency}ms`);
  if (res.ok) {
    const data = await res.json();
    const works = data.works || [];
    console.log(`Works returned: ${works.length}, evidenceWorkIds: ${data.evidenceWorkIds?.length}`);

    // Save to a retry file
    fs.writeFileSync("reports/retrieval-ab-eval-q1-crossencoder-retry.json", JSON.stringify({
      latencyMs: latency,
      worksCount: works.length,
      works: works.slice(0, 25).map((w, i) => ({
        rank: i + 1,
        workId: w.workId || w.id || w.doi,
        title: (w.title || "").slice(0, 120),
        similarity: w.similarity ?? w.compositeScore ?? null,
        smsLevel: w.smsLevel ?? w.methodology?.smsLevel ?? null,
        classification: w.classification || w.directIndirectClass || null,
      })),
    }, null, 2));
    console.log("Saved retry result.");
  } else {
    console.log("Error:", await res.text().then(t => t.slice(0, 300)));
  }
} catch (err) {
  console.error("Error:", err.message);
}
