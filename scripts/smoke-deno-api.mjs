#!/usr/bin/env node
/**
 * Deno API smoke test for the local/prod-parity API.
 *
 * Required:
 *   - GET /api/_health
 *   - GET /api/_version
 *
 * Optional:
 *   - GET /api/snapshot when API_SMOKE_TOKEN or SUPABASE_ACCESS_TOKEN is set.
 *
 * By default this test fails if the API is unreachable. Use --optional when
 * running in environments where the dev server may not be up.
 */

import { config } from "dotenv";

config();

const args = new Set(process.argv.slice(2));
const OPTIONAL = args.has("--optional");
const BASE = (
  process.env.API_SMOKE_BASE_URL ??
  process.env.DENO_API_BASE_URL ??
  process.env.VITE_API_BASE_URL ??
  "http://localhost:3002"
).replace(/\/+$/, "");
const TOKEN = process.env.API_SMOKE_TOKEN ?? process.env.SUPABASE_ACCESS_TOKEN ?? "";

async function fetchJson(path, init = {}) {
  const url = `${BASE}${path}`;
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    if (OPTIONAL) {
      console.warn(`[smoke-api] SKIP ${path} - ${err.message}`);
      return { skipped: true };
    }
    throw new Error(`${path} unreachable at ${url}: ${err.message}`);
  }

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${path} returned non-JSON (${res.status}): ${text.slice(0, 120)}`);
  }

  if (!res.ok) {
    throw new Error(`${path} returned ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

const health = await fetchJson("/api/_health");
if (!health.skipped) {
  if (health.status !== "ok") throw new Error(`_health status was ${JSON.stringify(health)}`);
  console.log(`[smoke-api] _health ok (${health.runtime ?? "unknown-runtime"})`);
}

const version = await fetchJson("/api/_version");
if (!version.skipped) {
  if (!version.buildMarker) throw new Error(`_version missing buildMarker: ${JSON.stringify(version)}`);
  console.log(`[smoke-api] _version ok (${version.buildMarker})`);
}

if (TOKEN) {
  const snapshot = await fetchJson("/api/snapshot", {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!snapshot.skipped) {
    for (const key of ["sources", "works", "searchRuns", "briefs", "generatedAt"]) {
      if (!(key in snapshot)) throw new Error(`snapshot missing ${key}`);
    }
    console.log(`[smoke-api] snapshot ok (${snapshot.works?.length ?? 0} works)`);
  }
} else {
  console.log("[smoke-api] snapshot skipped - set API_SMOKE_TOKEN to exercise authenticated routes");
}
