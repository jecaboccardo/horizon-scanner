-- ============================================================================
-- Phase 3 "Visibility" — telemetry layer (own-Postgres)
--
-- Two append-only tables for first-party observability. Written best-effort by
-- supabase/functions/_shared/telemetry.ts; a failed insert NEVER breaks or
-- slows a user request (see the fail-safe wrappers there).
--
-- PRIVACY: raw search QUERY TEXT may be stored here (our own VPS Postgres) but
-- is scrubbed from anything sent to external sinks (Sentry / PostHog). See
-- scrubForExternal() in telemetry.ts.
--
-- This migration cannot be applied through Kong/PostREST (DDL). Apply with:
--   DATABASE_URL=postgresql://postgres:PASS@15.235.47.35:PORT/iadb \
--     node scripts/apply-migrations.mjs
-- or:
--   docker exec -i supabase-db psql -U postgres -d iadb < \
--     supabase/migrations/20260603000001_telemetry.sql
-- ============================================================================

-- ---------------------------------------------------------------------------
-- llm_calls — one row per outbound LLM/embedding call (Gemini, Qwen, Nomic).
-- The top-priority signal lives here: brief_synthesis rows with status='fallback'
-- mean the deterministic fallback fired instead of real Gemini synthesis.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.llm_calls (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  model       text,
  operation   text,         -- brief_synthesis | query_expansion | embedding | chat | ...
  tokens_in   int,
  tokens_out  int,
  latency_ms  int,
  status      text,         -- ok | error | timeout | fallback
  error       text,
  tenant_id   text
);

CREATE INDEX IF NOT EXISTS llm_calls_ts_idx
  ON public.llm_calls (ts DESC);
CREATE INDEX IF NOT EXISTS llm_calls_operation_status_idx
  ON public.llm_calls (operation, status);

-- ---------------------------------------------------------------------------
-- usage_events — product-level events (a search ran, a brief generated, etc).
-- payload is free-form jsonb; it MAY contain query text in our own DB but that
-- text is scrubbed before any external sink.
-- ---------------------------------------------------------------------------
-- Full first-party usage-events layer. Every row supports the 6 W's:
--   who      : user_id + tenant_id
--   what     : event_type (e.g. search.submitted, brief.generated, paper.revised)
--   when     : ts
--   how long : latency_ms
--   outcome  : status ('started' | 'completed' | 'failed'  — also legacy 'ok')
--   why      : error (failure reason when status='failed')
--   on-what  : target_type + target_id (e.g. 'brief' + brief id, 'work' + work id)
--   context  : payload jsonb (MAY carry raw query/filter text in OUR DB only;
--              scrubForExternal() strips it before any external sink)
-- Async actions emit a started -> completed/failed PAIR so duration,
-- abandonment, and failure reason are all captured.
CREATE TABLE IF NOT EXISTS public.usage_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  tenant_id   text,
  user_id     text,
  event_type  text,         -- search.submitted | brief.generated | paper.generation_completed | ...
  payload     jsonb,
  latency_ms  int,
  status      text,         -- started | completed | failed (legacy: ok)
  error       text,         -- failure reason when status='failed'
  target_type text,         -- search_run | brief | plan | paper | work | subscription | source | ...
  target_id   text          -- id of the targeted entity
);

CREATE INDEX IF NOT EXISTS usage_events_ts_idx
  ON public.usage_events (ts DESC);
CREATE INDEX IF NOT EXISTS usage_events_event_type_idx
  ON public.usage_events (event_type);
-- Funnel / per-event-over-time queries.
CREATE INDEX IF NOT EXISTS usage_events_event_type_ts_idx
  ON public.usage_events (event_type, ts DESC);
-- Per-user activity / attribution queries.
CREATE INDEX IF NOT EXISTS usage_events_user_ts_idx
  ON public.usage_events (user_id, ts DESC);

-- ---------------------------------------------------------------------------
-- Fallback-rate tripwire query (documented; not a view, run ad hoc):
--
--   SELECT
--     count(*) FILTER (WHERE status = 'fallback')::float
--       / NULLIF(count(*), 0) AS fallback_rate,
--     count(*) AS total_synth
--   FROM public.llm_calls
--   WHERE operation = 'brief_synthesis'
--     AND ts > now() - interval '24 hours';
-- ---------------------------------------------------------------------------
