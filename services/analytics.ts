import posthog from 'posthog-js';
import { supabase } from './supabaseClient';

export type Severity = 'critical' | 'warning' | 'info';

export interface TrackProps {
  severity?: Severity;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Privacy scrubbing for external sinks (frontend mirror of telemetry.ts)
//
// PRIVACY BOUNDARY (locked): raw search query text / free-text NEVER goes to
// PostHog or Sentry. Only event names + non-identifying props (counts, persona,
// channels, latency). scrubProps() drops any free-text key and keeps a length
// signal where useful.
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_PATTERNS = [
  'query', 'question', 'prompt', 'text', 'instruction', 'abstract', 'title',
  'body', 'content', 'email', 'answer', 'message', 'doi', 'url', 'paste',
];

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  // 'error_message' / 'component_stack' are explicitly allowed for crash reports
  // (they contain stack frames, not user free-text) — handled by caller, not here.
  return SENSITIVE_KEY_PATTERNS.some((p) => k.includes(p));
}

export function scrubProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (isSensitiveKey(key)) {
      if (typeof value === 'string') out[`${key}_len`] = value.length;
      continue;
    }
    if (value == null || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'string') {
      out[key] = value.length > 64 ? value.slice(0, 64) : value;
    } else if (Array.isArray(value)) {
      const allPrimitive = value.every(
        (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
      );
      out[key] = allPrimitive ? value.slice(0, 20) : { count: value.length };
    }
  }
  return out;
}

export function initAnalytics() {
  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  if (key) {
    const host = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? 'https://us.i.posthog.com';
    posthog.init(key, {
      api_host: host,
      person_profiles: 'identified_only',
      capture_pageview: true,
      capture_pageleave: true,
    });
  }
  // Sentry is scaffolded but no-ops without a DSN — see captureException().
  initSentry();
}

export function identify(userId: string, email?: string) {
  if (import.meta.env.VITE_POSTHOG_KEY) posthog.identify(userId, { email });
}

export function resetAnalytics() {
  if (import.meta.env.VITE_POSTHOG_KEY) posthog.reset();
}

/**
 * Track a product event. Props are SCRUBBED before leaving the browser — pass
 * the raw object; query/free-text keys are dropped automatically.
 */
export function track(event: string, props: TrackProps = {}) {
  if (!import.meta.env.VITE_POSTHOG_KEY) return;
  const { severity = 'info', ...rest } = props;
  posthog.capture(event, { severity, ...scrubProps(rest) });
}

// ---------------------------------------------------------------------------
// Convenience wrappers for the two flagship scrubbed events (Phase 3).
// These never send the query string — only counts / channels / persona.
// ---------------------------------------------------------------------------

export function trackSearchSubmitted(props: {
  channels?: string[];
  evidenceMatch?: string;
  hasSourceFilter?: boolean;
  queryLength?: number;
}) {
  track('search_submitted', { severity: 'info', ...props });
}

export function trackBriefGenerated(props: {
  persona?: string;
  lang?: string;
  evidenceCount?: number;
  fallback?: boolean;
  latencyMs?: number;
}) {
  track('brief_generated', { severity: 'info', ...props });
}

// ---------------------------------------------------------------------------
// logEvent — first-party usage-event helper for FRONTEND-ONLY actions.
//
// POSTs the RAW event to our own Postgres via POST /api/events (authenticated;
// the server attributes user_id + tenant_id). Raw context (filter values,
// export formats) is fine in our DB. SEPARATELY mirrors a SCRUBBED copy to
// PostHog. Fire-and-forget: never awaited on a UI interaction, never throws.
//
// Server-side actions (search, brief, paper generation, feedback, etc.) are
// instrumented in the API handler / pipeline directly — do NOT double-log
// those here. Use logEvent only for actions that never hit a dedicated route
// (filters changed, exports, copies, language switch, paper-detail open, ...).
// ---------------------------------------------------------------------------

const EVENTS_API_BASE = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || '/api').replace(/\/$/, '');

export interface LogEventInput {
  eventType: string;
  status?: 'started' | 'completed' | 'failed';
  latencyMs?: number;
  error?: string;
  targetType?: string;
  targetId?: string;
  payload?: Record<string, unknown>;
}

export function logEvent(input: LogEventInput): void {
  // 1. Our Postgres (raw context allowed). Fire-and-forget.
  void (async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
      await fetch(`${EVENTS_API_BASE}/events`, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
        keepalive: true, // survive page unload (export/navigate-away events)
      });
    } catch {
      // Telemetry must never break the UI. Swallow.
    }
  })();

  // 2. PostHog mirror — SCRUBBED (drops query/title/etc; keeps counts/enums).
  try {
    track(input.eventType, {
      severity: 'info',
      status: input.status,
      latencyMs: input.latencyMs,
      targetType: input.targetType,
      targetId: input.targetId,
      ...(input.payload ?? {}),
    });
  } catch {
    /* swallow */
  }
}

// ---------------------------------------------------------------------------
// Sentry (frontend) — thin, dependency-free, fetch-based exception capture.
// NO-OP without VITE_SENTRY_DSN. We avoid adding @sentry/browser as a hard
// dependency so the app builds with zero observability configured.
// ---------------------------------------------------------------------------

interface SentryEndpoint { url: string; publicKey: string; }
let _sentryEndpoint: SentryEndpoint | null = null;
let _sentryEnv = 'production';

function parseDsn(dsn: string): SentryEndpoint | null {
  try {
    const u = new URL(dsn);
    const publicKey = u.username;
    const projectId = u.pathname.replace(/^\/+/, '');
    if (!publicKey || !projectId) return null;
    return { url: `${u.protocol}//${u.host}/api/${projectId}/store/`, publicKey };
  } catch {
    return null;
  }
}

function initSentry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  const env = import.meta.env.VITE_SENTRY_ENV as string | undefined;
  if (env) _sentryEnv = env;
  _sentryEndpoint = dsn ? parseDsn(dsn) : null;
}

/**
 * Capture an exception to Sentry. NO-OP without VITE_SENTRY_DSN. Fire-and-forget,
 * never throws. Tags must be non-identifying.
 */
export function captureException(err: Error, tags?: Record<string, string>) {
  if (!_sentryEndpoint) return;
  try {
    const event = {
      event_id: (crypto as any).randomUUID?.().replace(/-/g, '') ?? String(Date.now()),
      timestamp: new Date().toISOString(),
      platform: 'javascript',
      level: 'error',
      environment: _sentryEnv,
      tags: tags ?? {},
      exception: {
        values: [{ type: err.name || 'Error', value: (err.message || String(err)).slice(0, 500) }],
      },
    };
    void fetch(_sentryEndpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=horizon-scanner/1, sentry_key=${_sentryEndpoint.publicKey}`,
      },
      body: JSON.stringify(event),
    }).catch(() => { /* swallow */ });
  } catch {
    /* swallow */
  }
}
