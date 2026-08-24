-- Migration: learning_rls
-- Purpose: Row Level Security on domain_weights, weight_proposals, and weight_alerts.
-- Pattern: matches 20260407000009_rls_policies.sql — user_id = auth.uid() OR is_admin in app_metadata

-- ─── domain_weights ─────────────────────────────────────────────────────────

alter table public.domain_weights enable row level security;

create policy "domain_weights: users see own rows or admin sees all"
  on public.domain_weights for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    or (select auth.jwt()->'app_metadata'->>'is_admin') = 'true'
  );

create policy "domain_weights: users insert own rows"
  on public.domain_weights for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
  );

create policy "domain_weights: users update own rows"
  on public.domain_weights for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "domain_weights: users delete own rows"
  on public.domain_weights for delete
  to authenticated
  using (
    (select auth.uid()) = user_id
  );

-- ─── weight_proposals ───────────────────────────────────────────────────────

alter table public.weight_proposals enable row level security;

-- Admin can manage all rows (insert, update, select, delete)
create policy "weight_proposals: admin can manage"
  on public.weight_proposals for all
  to authenticated
  using (
    (select auth.jwt()->'app_metadata'->>'is_admin') = 'true'
  )
  with check (
    (select auth.jwt()->'app_metadata'->>'is_admin') = 'true'
  );

-- Users can only read their own proposals
create policy "weight_proposals: users see own rows"
  on public.weight_proposals for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- ─── weight_alerts ──────────────────────────────────────────────────────────

alter table public.weight_alerts enable row level security;

-- Admin-only: select and insert. No user access at all.
create policy "weight_alerts: admin select"
  on public.weight_alerts for select
  to authenticated
  using (
    (select auth.jwt()->'app_metadata'->>'is_admin') = 'true'
  );

create policy "weight_alerts: admin insert"
  on public.weight_alerts for insert
  to authenticated
  with check (
    (select auth.jwt()->'app_metadata'->>'is_admin') = 'true'
  );

create policy "weight_alerts: admin update"
  on public.weight_alerts for update
  to authenticated
  using (
    (select auth.jwt()->'app_metadata'->>'is_admin') = 'true'
  )
  with check (
    (select auth.jwt()->'app_metadata'->>'is_admin') = 'true'
  );
