#!/usr/bin/env node
/**
 * scripts/pilot-monitor.mjs — SCL pilot monitor CLI.
 *
 * Modes: (default) one-shot snapshot | --watch [--interval 60] | --alerts | --judge <paperId>
 * Talks to the admin monitor endpoints (/api/admin/monitor/*). Requires:
 *   MONITOR_API_BASE   e.g. https://your-app/api   (or http://localhost:3002/api)
 *   MONITOR_ADMIN_JWT  an admin session token (Authorization: Bearer)
 *   SLACK_MONITOR_WEBHOOK_URL  (optional) — --alerts posts here; else prints
 *
 * RUN:
 *   node --env-file=.env scripts/pilot-monitor.mjs [--watch|--alerts|--judge <id>]
 */
const API = process.env.MONITOR_API_BASE;
const JWT = process.env.MONITOR_ADMIN_JWT;
const SLACK = process.env.SLACK_MONITOR_WEBHOOK_URL;

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

async function api(path, method = "GET") {
  if (!API || !JWT) throw new Error("Set MONITOR_API_BASE and MONITOR_ADMIN_JWT");
  const r = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${JWT}` } });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

async function postSlack(text) {
  if (!SLACK) { console.warn("SLACK_MONITOR_WEBHOOK_URL not set — printing instead:\n" + text); return; }
  await fetch(SLACK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
}

async function snapshot() {
  const [ov, cost] = await Promise.all([api("/admin/monitor/overview"), api("/admin/monitor/cost")]);
  console.log("=== Who is using it ===");
  for (const u of ov.roster) {
    const c = ov.byUser[u] || {};
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    console.log(`  ${u.slice(0, 8)}…  ${total === 0 ? "DORMANT" : total + " events"}`);
  }
  console.log("\n=== Completion health ===");
  for (const h of ov.health) {
    console.log(`  ${h.action.padEnd(7)} attempts=${h.attempts} success=${h.successRate == null ? "—" : Math.round(h.successRate * 100) + "%"} failed=${h.failed} stuck=${h.stuck.length}`);
  }
  console.log("\n=== Cost (7d) ===");
  console.log(`  total $${cost.cost.total.toFixed(2)} · projected 30d $${cost.cost.projected30d.toFixed(2)}`);
  for (const b of cost.budget) {
    console.log(`  ${b.provider}: $${b.spentUsd.toFixed(2)}/$${b.budgetUsd.toFixed(2)} (${Math.round(b.pctConsumed)}%) ETA ${b.etaDays?.toFixed(1) ?? "—"}d`);
  }
}

async function alertsMode() {
  // Cron path: auth via the shared MONITOR_CRON_SECRET (no expiring JWT). Hits the
  // pre-auth /monitor-alerts endpoint (alert list only — user display names for the
  // info-level activity alerts, never query text).
  if (!API) throw new Error("Set MONITOR_API_BASE");
  const r = await fetch(`${API}/monitor-alerts`, { headers: { "x-monitor-secret": process.env.MONITOR_CRON_SECRET || "" } });
  if (!r.ok) throw new Error(`/monitor-alerts → ${r.status} ${await r.text()}`);
  const { alerts } = await r.json();
  if (!alerts.length) { console.log("No alerts firing."); return 0; }
  const criticalOnly = has("--critical-only"); // backup crons: never duplicate warn/info posts
  let toPost;
  const stateFile = process.env.MONITOR_STATE_FILE;
  if (stateFile) {
    // Primary path (VPS systemd timer): dedup by fingerprint. Fingerprints carry the UTC
    // day, so warn/info post ONCE per fingerprint per day; criticals re-post hourly while
    // they keep firing. State = { fingerprint: lastPostedMs }, pruned after 3 days.
    const fs = await import("node:fs");
    let state = {};
    try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { /* first run */ }
    const now = Date.now();
    toPost = alerts.filter((a) => {
      if (criticalOnly && a.severity !== "critical") return false;
      const last = state[a.fingerprint];
      if (a.severity === "critical") return !last || now - last > 55 * 60_000;
      return !last;
    });
    for (const a of toPost) state[a.fingerprint] = now;
    for (const [k, v] of Object.entries(state)) if (now - v > 3 * 86_400_000) delete state[k];
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } else {
    // Stateless fallback (GitHub Actions backup): criticals every cycle; warns/infos only
    // in the first 5-min window of each hour. NOTE GitHub throttles `schedule:` to a
    // best-effort ~1-2h cadence, so warn/info delivery is unreliable here — that is why
    // the VPS timer (with MONITOR_STATE_FILE) is the primary path.
    const minute = new Date().getUTCMinutes();
    toPost = alerts.filter((a) => a.severity === "critical" || (!criticalOnly && minute < 5));
  }
  if (!toPost.length) { console.log(`${alerts.length} alert(s) firing but all suppressed this cycle (already posted / throttled).`); return 0; }
  const worst = toPost.some((a) => a.severity === "critical") ? ":rotating_light:" : toPost.some((a) => a.severity === "warn") ? ":warning:" : ":bell:";
  const text = `${worst} Horizon Scanner pilot — ${toPost.length} alert(s):\n` +
    toPost.map((a) => `• [${a.severity}] ${a.title} — ${a.detail}${a.entities.length ? ` (${a.entities.slice(0, 5).join(", ")})` : ""}`).join("\n");
  await postSlack(text);
  console.log(text);
  // Exit 0 even when alerts fire — the Slack post IS the signal. A non-zero exit is
  // reserved for real script failures (exit 2 in the top-level catch), so the cron only
  // goes red when the monitor itself breaks, not during every incident it's reporting.
  return 0;
}

async function judgeMode(paperId) {
  const review = await api(`/admin/monitor/judge/${paperId}`, "POST");
  console.log(`Overall: ${review.overall} (${review.model})`);
  for (const f of review.findings || []) console.log(`  [${f.severity}] ${f.dimension} §${f.section}: ${f.note}\n    "${f.quote}"`);
}

(async () => {
  try {
    if (has("--judge")) { await judgeMode(val("--judge")); return; }
    if (has("--alerts")) { process.exitCode = await alertsMode(); return; }
    if (has("--watch")) {
      const interval = Number(val("--interval", "60")) * 1000;
      for (;;) { console.clear(); console.log(new Date().toISOString()); await snapshot(); await new Promise((r) => setTimeout(r, interval)); }
    }
    await snapshot();
  } catch (e) { console.error("pilot-monitor error:", e.message); process.exitCode = 2; }
})();
