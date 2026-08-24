-- Migration: grant DELETE on jel_papers to authenticated.
--
-- BUG (2026-06-08): the RLS migration 20260527000001_jel_papers_rls.sql created
-- a `for delete` POLICY ("users delete own rows") but never issued the matching
-- table-level GRANT. In Postgres, RLS policies only take effect AFTER the role
-- holds the base table privilege — so with no DELETE grant, EVERY authenticated
-- user (even the legitimate owner) got `permission denied for table jel_papers`
-- when deleting a paper through the RLS client. Errored/stuck papers were
-- therefore impossible to remove from the Library.
--
-- jel_papers already grants INSERT/SELECT/UPDATE to authenticated; only DELETE
-- was missing. `briefs` (where deletion works) has the full set — this aligns
-- jel_papers with it. The DELETE policy already scopes rows to the owner
-- (auth.uid()::text = tenant_id), so granting the privilege is safe.
--
-- Idempotent: GRANT is a no-op if already present.

grant delete on table public.jel_papers to authenticated;
