-- 20260505000001_extraction_grants.sql
-- Backfill GRANTs for wave1 extraction tables. Original migrations created the
-- tables but did not grant access to service_role, so the worker's PostgREST
-- calls returned 42501 "permission denied for table extraction_queue".
--
-- This is the standard Supabase pattern for service-role-only internal tables:
-- the role bypasses RLS but still needs explicit table GRANTs.

-- Schema usage (idempotent; harmless if already granted)
grant usage on schema public to service_role;

-- Tables created in 20260504000001..20260504000006
grant all on table evidence_cards     to service_role;
grant all on table extraction_queue   to service_role;
grant all on table extraction_issues  to service_role;
grant all on table brief_evals        to service_role;
grant all on table worker_heartbeat   to service_role;

-- Sequences for any serial/bigserial columns on those tables
grant all on all sequences in schema public to service_role;

-- RPC the worker calls every poll
grant execute on function claim_extraction_batch(integer) to service_role;

-- Default privileges so future tables/sequences/functions in public auto-grant
-- to service_role (prevents this class of bug from recurring)
alter default privileges in schema public grant all on tables    to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on functions to service_role;
