-- ============================================================================
-- Durable plugin keys — long-lived per-user credentials for the Claude Code
-- plugin (the browser session JWT expires hourly and is useless for a saved
-- config). A key is presented as `Authorization: Bearer hsk_...`; authenticateRequest
-- resolves it to the owning user. Only the SHA-256 hash is stored — the raw key
-- is shown to the user exactly once at creation.
--
-- 🔒 Plugin-key auth is SCOPED in the handler to the plugin's endpoints only
-- (path allowlist) and never grants admin — a leaked key cannot reach the rest
-- of the API.
--
-- DDL — apply via the VPS (Kong/PostgREST cannot run DDL):
--   docker exec -i supabase-db psql -U postgres -d iadb < \
--     supabase/migrations/20260616000001_plugin_keys.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.plugin_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  tenant_id    text,
  token_hash   text NOT NULL UNIQUE,   -- sha256(raw key), hex
  prefix       text NOT NULL,          -- e.g. "hsk_ab12cd" for display only
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

-- Fast active-key lookup on the auth hot path.
CREATE INDEX IF NOT EXISTS plugin_keys_active_hash_idx
  ON public.plugin_keys (token_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS plugin_keys_user_idx
  ON public.plugin_keys (user_id);

-- RLS on with no policies: the service role (adminClient) bypasses RLS and the
-- API handlers filter by user_id explicitly; no other role may read the hashes.
ALTER TABLE public.plugin_keys ENABLE ROW LEVEL SECURITY;

-- service_role (adminClient) must have a table GRANT even though it bypasses RLS
-- (RLS-bypass ≠ grant-bypass — the 2026-06-08 jel_papers delete bug). anon/authenticated
-- get NOTHING (RLS denies + no grant) — key hashes never leave the service path.
GRANT ALL ON public.plugin_keys TO service_role;

-- PostgREST caches the schema; a new table is invisible to the Kong/rest gateway
-- (which adminClient uses) until the cache reloads.
NOTIFY pgrst, 'reload schema';
