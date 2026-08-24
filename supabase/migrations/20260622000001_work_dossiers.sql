-- ============================================================================
-- work_dossiers — per-paper full-text dossier + enrichment card cache.
--
-- The "cache-and-grow" store behind Tyler Tier-A + the JEL enrichment pass.
-- A paper's OA PDF is fetched + JS-extracted ONCE (on demand, at generation,
-- for CITED papers only — never bulk, never at retrieval) into a two-tier
-- dossier; every future paper that cites it reuses this row. Tier-1
-- (index_entry, ~400 tok) is cheap nav; Tier-2 (full_text) is pulled on demand.
-- enrichment_card holds the effect-size/caveat substance the abstract omits,
-- each field provenance-tagged full_text (assert) vs web (hedge).
--
-- 🔒 PROMPT-INPUT ONLY. This table NEVER writes back to `works` (golden rule).
--    It is a derived cache; a dangling row (work later denylisted) is harmless.
--
-- DDL — apply via the VPS (Kong/PostgREST cannot run DDL):
--   docker exec -i supabase-db psql -U postgres -d iadb < \
--     supabase/migrations/20260622000001_work_dossiers.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.work_dossiers (
  work_id         text PRIMARY KEY,        -- works.id (no FK — decoupled cache)
  index_entry     text,                    -- Tier-1: compact nav entry (~400 tok)
  full_text       text,                    -- Tier-2: cleaned full text (on demand)
  token_count     int,                     -- size of full_text, for prompt budgeting
  enrichment_card jsonb,                   -- {effect,sample,design,mechanism,caveats,
                                           --  implication, provenance:{field->full_text|web}}
  source          text,                    -- 'oa_pdf' | 'upload' | 'web' | 'abstract_only'
  source_url      text,
  status          text NOT NULL DEFAULT 'pending', -- 'ok' | 'no_fulltext' | 'fetch_failed'
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- "which dossiers still need fetching / re-fetching" sweeps.
CREATE INDEX IF NOT EXISTS work_dossiers_status_idx ON public.work_dossiers (status);

-- RLS on, no policies: only the service role (adminClient) touches dossiers — they
-- are a service-path prompt-input cache, never user-facing. anon/authenticated get
-- nothing (RLS denies + no grant).
ALTER TABLE public.work_dossiers ENABLE ROW LEVEL SECURITY;

-- service_role needs an explicit GRANT even though it bypasses RLS
-- (RLS-bypass ≠ grant-bypass — the 2026-06-08 jel_papers delete bug).
GRANT ALL ON public.work_dossiers TO service_role;

-- PostgREST caches the schema; the new table is invisible to the Kong/rest gateway
-- (adminClient's path) until the cache reloads.
NOTIFY pgrst, 'reload schema';
