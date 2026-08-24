#!/usr/bin/env node
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

try {
  const env = readFileSync(resolve(process.cwd(), ".env"), "utf8");
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const SUPA_URL = process.env.SUPABASE_URL;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_ANON_KEY;
const API = "https://v0-horizon-scanner-iadb.vercel.app";
const EMAIL = "horizon-scanner@iadb.org";

const admin = createClient(SUPA_URL, SVC);
const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
  type: "magiclink",
  email: EMAIL,
});
if (linkErr) { console.error("generateLink:", linkErr); process.exit(1); }

const anon = createClient(SUPA_URL, ANON);
const { data: verified, error: vErr } = await anon.auth.verifyOtp({
  type: "magiclink",
  token_hash: link.properties.hashed_token,
});
if (vErr) { console.error("verifyOtp:", vErr); process.exit(1); }

const token = verified.session.access_token;

const res = await fetch(`${API}/api/_debug/last-search-classification`, {
  headers: { "Authorization": `Bearer ${token}` },
});
const text = await res.text();
console.log("status:", res.status);
console.log(text);
