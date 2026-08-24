/**
 * supabase/functions/_shared/sinks.ts
 *
 * Phase 3 "Visibility" — server-side external sink scaffolds (Deno API path).
 *
 * Thin, dependency-free (fetch-based) wrappers for PostHog + Sentry. Both
 * NO-OP when their env keys are absent — the app builds and runs with zero
 * external observability configured. All emits are fire-and-forget and never
 * throw, so an outage at PostHog/Sentry can never break or slow a request.
 *
 * PRIVACY: callers are responsible for scrubbing free-text before calling
 * these. telemetry.ts always runs scrubForExternal() first. These functions do
 * NOT re-scrub — keep that contract in mind if you call them directly.
 *
 * Env:
 *   POSTHOG_KEY    PostHog project API key (server-side capture)
 *   POSTHOG_HOST   default https://us.i.posthog.com
 *   SENTRY_DSN     Sentry DSN (parsed into the ingest endpoint)
 *   SENTRY_ENV     environment tag (default: production)
 */

function readEnv(key: string): string | undefined {
  // deno-lint-ignore no-explicit-any
  const denoEnv = (globalThis as any).Deno?.env;
  if (denoEnv && typeof denoEnv.get === "function") {
    return denoEnv.get(key) ?? undefined;
  }
  // deno-lint-ignore no-explicit-any
  return (globalThis as any).process?.env?.[key];
}

// ---------------------------------------------------------------------------
// PostHog (server-side capture via /capture HTTP API)
// ---------------------------------------------------------------------------

let _posthogChecked = false;
let _posthogKey: string | undefined;
let _posthogHost = "https://us.i.posthog.com";

function posthogConfig(): { key: string; host: string } | null {
  if (!_posthogChecked) {
    _posthogChecked = true;
    _posthogKey = readEnv("POSTHOG_KEY");
    const host = readEnv("POSTHOG_HOST");
    if (host) _posthogHost = host.replace(/\/+$/, "");
    if (_posthogKey) {
      console.log(`[sinks] PostHog server capture ENABLED (host=${_posthogHost})`);
    } else {
      console.log("[sinks] PostHog server capture disabled (POSTHOG_KEY absent)");
    }
  }
  return _posthogKey ? { key: _posthogKey, host: _posthogHost } : null;
}

/**
 * Emit a server-side event to PostHog. NO-OP without POSTHOG_KEY.
 * Fire-and-forget; payload MUST already be scrubbed by the caller.
 */
export function captureServerEvent(
  event: string,
  // deno-lint-ignore no-explicit-any
  properties: Record<string, any>,
  distinctId?: string,
): void {
  const cfg = posthogConfig();
  if (!cfg) return;
  try {
    const body = JSON.stringify({
      api_key: cfg.key,
      event,
      // Tenant id is non-identifying here (e.g. "iadb-demo"); never an email.
      distinct_id: distinctId || "server",
      properties: { ...properties, $lib: "horizon-scanner-server" },
      timestamp: new Date().toISOString(),
    });
    void fetch(`${cfg.host}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(5_000),
    }).catch((err) => {
      console.warn("[sinks] posthog capture failed (swallowed):", err instanceof Error ? err.message : String(err));
    });
  } catch (err) {
    console.warn("[sinks] posthog capture sync error (swallowed):", err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Sentry (exception capture via the Store HTTP API, DSN-derived endpoint)
// ---------------------------------------------------------------------------

interface SentryEndpoint {
  url: string;
  publicKey: string;
}

let _sentryChecked = false;
let _sentryEndpoint: SentryEndpoint | null = null;
let _sentryEnv = "production";

/**
 * Parse a Sentry DSN into the store endpoint + public key.
 * DSN shape: https://<publicKey>@<host>/<projectId>
 */
function parseDsn(dsn: string): SentryEndpoint | null {
  try {
    const u = new URL(dsn);
    const publicKey = u.username;
    const projectId = u.pathname.replace(/^\/+/, "");
    if (!publicKey || !projectId) return null;
    const url = `${u.protocol}//${u.host}/api/${projectId}/store/`;
    return { url, publicKey };
  } catch {
    return null;
  }
}

function sentryConfig(): SentryEndpoint | null {
  if (!_sentryChecked) {
    _sentryChecked = true;
    const dsn = readEnv("SENTRY_DSN");
    const env = readEnv("SENTRY_ENV");
    if (env) _sentryEnv = env;
    _sentryEndpoint = dsn ? parseDsn(dsn) : null;
    if (_sentryEndpoint) {
      console.log("[sinks] Sentry exception capture ENABLED");
    } else {
      console.log("[sinks] Sentry exception capture disabled (SENTRY_DSN absent or invalid)");
    }
  }
  return _sentryEndpoint;
}

/**
 * Capture an exception/message to Sentry. NO-OP without a valid SENTRY_DSN.
 * Fire-and-forget; tags should be non-identifying (operation, status, model).
 */
export function captureServerException(
  err: Error,
  tags?: Record<string, string>,
): void {
  const cfg = sentryConfig();
  if (!cfg) return;
  try {
    const event = {
      event_id: crypto.randomUUID().replace(/-/g, ""),
      timestamp: new Date().toISOString(),
      platform: "javascript",
      level: "error",
      environment: _sentryEnv,
      server_name: "horizon-scanner-deno-api",
      tags: tags ?? {},
      exception: {
        values: [
          {
            type: err.name || "Error",
            value: (err.message || String(err)).slice(0, 500),
            stacktrace: err.stack ? { frames: [{ filename: "server", function: err.stack.split("\n")[0]?.slice(0, 200) }] } : undefined,
          },
        ],
      },
    };
    void fetch(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=horizon-scanner/1, sentry_key=${cfg.publicKey}`,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5_000),
    }).catch((e) => {
      console.warn("[sinks] sentry capture failed (swallowed):", e instanceof Error ? e.message : String(e));
    });
  } catch (e) {
    console.warn("[sinks] sentry capture sync error (swallowed):", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Init log on server boot — surfaces which sinks are active. Pure logging;
 * the actual config is lazy-initialised on first capture. Safe to call always.
 */
export function initServerSinks(): void {
  posthogConfig();
  sentryConfig();
}
