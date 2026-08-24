// deno-lint-ignore-file no-explicit-any
/**
 * supabase/functions/alert-digest/index.ts
 *
 * Sends weekly/daily email digests to users who have active subscriptions
 * with new matching papers since their last alert.
 *
 * Triggered on a cron schedule (see supabase/config.toml).
 * Can also be triggered manually for testing via a POST request with
 * { "force": true } body.
 */

import { adminClient } from "../_shared/supabase.ts";

const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const FROM_EMAIL = process.env.FROM_EMAIL ?? "alerts@horizonscanner.iadb.org";

interface SubscriptionRow {
  id: string;
  user_id: string;
  type: string;
  label: string;
  cadence: string;
  query?: string;
  topic?: string;
  last_sent_at?: string | null;
}

interface WorkRow {
  id: string;
  title: string;
  year: number | null;
  venue: string | null;
  canonical_doi: string | null;
  url: string | null;
  sms_level: number | null;
  abstract: string | null;
}

function cadenceExpired(lastSentAt: string | null | undefined, cadence: string): boolean {
  if (!lastSentAt) return true;
  const last = new Date(lastSentAt).getTime();
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const thresholdMs = cadence === 'daily' ? dayMs : 7 * dayMs;
  return now - last >= thresholdMs;
}

function smsLabel(level: number | null): string {
  if (!level) return '';
  const labels: Record<number, string> = { 5: 'SMS 5 ★★★★★', 4: 'SMS 4 ★★★★', 3: 'SMS 3 ★★★', 2: 'SMS 2 ★★', 1: 'SMS 1 ★' };
  return labels[level] ?? '';
}

function buildEmailHtml(subscription: SubscriptionRow, papers: WorkRow[]): string {
  const paperItems = papers.map((p) => {
    const link = p.url ?? (p.canonical_doi ? `https://doi.org/${p.canonical_doi}` : null);
    const title = link
      ? `<a href="${link}" style="color:#0f7b86;text-decoration:none;font-weight:600;">${escapeHtml(p.title)}</a>`
      : `<strong>${escapeHtml(p.title)}</strong>`;
    const meta = [p.year, p.venue, smsLabel(p.sms_level)].filter(Boolean).join(' · ');
    return `
      <li style="margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #e2e8f0;">
        <div style="font-size:14px;line-height:1.5;">${title}</div>
        ${meta ? `<div style="font-size:12px;color:#64748b;margin-top:4px;">${escapeHtml(meta)}</div>` : ''}
      </li>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:32px auto;">
    <tr><td style="background:linear-gradient(135deg,#0f7b86,#0f1d35);padding:24px 32px;border-radius:12px 12px 0 0;">
      <h1 style="color:#fff;font-size:18px;margin:0;">Horizon Scanner</h1>
      <p style="color:#a5f3fc;font-size:13px;margin:4px 0 0;">Evidence intelligence for IADB policy research</p>
    </td></tr>
    <tr><td style="background:#fff;padding:24px 32px;border:1px solid #e2e8f0;border-top:none;">
      <h2 style="font-size:16px;color:#0f172a;margin:0 0 4px;">New papers: ${escapeHtml(subscription.label)}</h2>
      <p style="font-size:13px;color:#64748b;margin:0 0 20px;">${papers.length} new paper${papers.length !== 1 ? 's' : ''} since your last digest</p>
      <ul style="padding:0;list-style:none;margin:0;">${paperItems}</ul>
    </td></tr>
    <tr><td style="background:#f8fafc;padding:16px 32px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;">
      <p style="font-size:11px;color:#94a3b8;margin:0;">
        You're receiving this because you follow "${escapeHtml(subscription.label)}" on Horizon Scanner.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!RESEND_API_KEY) {
    console.warn("[alert-digest] RESEND_API_KEY not set — skipping email send");
    return false;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("[alert-digest] Resend error:", err);
    return false;
  }
  return true;
}

async function findMatchingPapers(sub: SubscriptionRow, sinceDate: string): Promise<WorkRow[]> {
  // Build query based on subscription type
  let query = adminClient
    .from("works")
    .select("id, title, year, venue, canonical_doi, url, sms_level, abstract")
    .gte("corpus_imported_at", sinceDate)
    .eq("excluded", false)
    .order("sms_level", { ascending: false, nullsFirst: false })
    .limit(10);

  if (sub.type === "topic" && sub.topic) {
    query = query.contains("scl_topics", [sub.topic]);
  } else if ((sub.type === "search" || sub.type === "topic") && sub.query) {
    // FTS match using websearch syntax
    query = query.textSearch("fts_vector", sub.query, { type: "websearch" });
  } else {
    return [];
  }

  const { data, error } = await query;
  if (error) {
    console.error("[alert-digest] Paper query error:", error.message);
    return [];
  }
  return (data || []) as WorkRow[];
}

export async function handler(req: Request): Promise<Response> {
  // Allow manual trigger via POST (no auth required for cron-invoked functions)
  const isForced = req.method === "POST" && req.headers.get("content-type")?.includes("application/json")
    ? (await req.json().catch(() => ({}))).force === true
    : false;

  console.log(`[alert-digest] Starting digest run (forced=${isForced})`);

  // Fetch all subscriptions
  const { data: subscriptions, error: subError } = await adminClient
    .from("subscriptions")
    .select("id, user_id, type, label, cadence, query, topic, last_sent_at")
    .order("created_at");

  if (subError || !subscriptions) {
    console.error("[alert-digest] Failed to fetch subscriptions:", subError?.message);
    return new Response(JSON.stringify({ error: "Failed to fetch subscriptions" }), { status: 500 });
  }

  const results = { processed: 0, sent: 0, skipped: 0, errors: 0 };

  for (const sub of subscriptions as SubscriptionRow[]) {
    results.processed++;

    // Check cadence — skip if not due yet (unless forced)
    if (!isForced && !cadenceExpired(sub.last_sent_at, sub.cadence)) {
      results.skipped++;
      continue;
    }

    // Determine since-date for paper lookup
    const sinceDate = sub.last_sent_at ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Find matching papers
    const papers = await findMatchingPapers(sub, sinceDate);
    if (papers.length === 0) {
      // Still update last_sent_at so we don't re-check until next cadence
      await adminClient
        .from("subscriptions")
        .update({ last_sent_at: new Date().toISOString() })
        .eq("id", sub.id);
      results.skipped++;
      continue;
    }

    // Get user's email from auth.users
    const { data: userData } = await adminClient.auth.admin.getUserById(sub.user_id);
    const email = userData?.user?.email;
    if (!email) {
      console.warn(`[alert-digest] No email for user ${sub.user_id} — skipping`);
      results.skipped++;
      continue;
    }

    // Send email
    const html = buildEmailHtml(sub, papers);
    const subject = `[Horizon Scanner] ${sub.cadence === 'daily' ? 'Daily' : 'Weekly'} digest: ${sub.label}`;
    const sent = await sendEmail(email, subject, html);

    if (sent) {
      results.sent++;
      await adminClient
        .from("subscriptions")
        .update({ last_sent_at: new Date().toISOString() })
        .eq("id", sub.id);
    } else {
      results.errors++;
    }
  }

  console.log(`[alert-digest] Done:`, results);
  return new Response(JSON.stringify(results), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
