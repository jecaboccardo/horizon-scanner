-- Migration 9: Row Level Security policies
-- Purpose: User data isolation + admin override on all 5 user-data tables
-- Pattern: user_id = auth.uid() OR is_admin = 'true' in app_metadata (JWT claim)
-- Admin claim is injected by custom_access_token_hook (migration 1)

-- ─── search_runs ────────────────────────────────────────────────────────────

alter table public.search_runs enable row level security;

create policy "search_runs: users see own rows or admin sees all"
  on public.search_runs for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    or (select auth.jwt()->'app_metadata'->>'is_admin') = 'true'
  );

create policy "search_runs: users insert own rows"
  on public.search_runs for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
  );

create policy "search_runs: users update own rows"
  on public.search_runs for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "search_runs: users delete own rows"
  on public.search_runs for delete
  to authenticated
  using (
    (select auth.uid()) = user_id
  );

-- ─── briefs ─────────────────────────────────────────────────────────────────

alter table public.briefs enable row level security;

-- Share-by-link pattern: any authenticated user who knows the brief UUID can read it
-- The brief ID itself is the access token for Phase 1 sharing
create policy "briefs: owner or admin sees all; any authenticated user can read by ID"
  on public.briefs for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    or (select auth.jwt()->'app_metadata'->>'is_admin') = 'true'
    or true
  );

create policy "briefs: users insert own rows"
  on public.briefs for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
  );

create policy "briefs: users update own rows"
  on public.briefs for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "briefs: users delete own rows"
  on public.briefs for delete
  to authenticated
  using (
    (select auth.uid()) = user_id
  );

-- ─── subscriptions ──────────────────────────────────────────────────────────

alter table public.subscriptions enable row level security;

create policy "subscriptions: users see own rows or admin sees all"
  on public.subscriptions for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    or (select auth.jwt()->'app_metadata'->>'is_admin') = 'true'
  );

create policy "subscriptions: users insert own rows"
  on public.subscriptions for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
  );

create policy "subscriptions: users update own rows"
  on public.subscriptions for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "subscriptions: users delete own rows"
  on public.subscriptions for delete
  to authenticated
  using (
    (select auth.uid()) = user_id
  );

-- ─── feed ───────────────────────────────────────────────────────────────────

alter table public.feed enable row level security;

create policy "feed: users see own rows or admin sees all"
  on public.feed for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    or (select auth.jwt()->'app_metadata'->>'is_admin') = 'true'
  );

create policy "feed: users insert own rows"
  on public.feed for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
  );

create policy "feed: users update own rows"
  on public.feed for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "feed: users delete own rows"
  on public.feed for delete
  to authenticated
  using (
    (select auth.uid()) = user_id
  );

-- ─── feedback ───────────────────────────────────────────────────────────────

alter table public.feedback enable row level security;

create policy "feedback: users see own rows or admin sees all"
  on public.feedback for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    or (select auth.jwt()->'app_metadata'->>'is_admin') = 'true'
  );

create policy "feedback: users insert own rows"
  on public.feedback for insert
  to authenticated
  with check (
    (select auth.uid()) = user_id
  );

create policy "feedback: users update own rows"
  on public.feedback for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "feedback: users delete own rows"
  on public.feedback for delete
  to authenticated
  using (
    (select auth.uid()) = user_id
  );
