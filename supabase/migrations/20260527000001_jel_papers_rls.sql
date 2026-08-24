-- Migration: Row Level Security for jel_papers
-- tenant_id is stored as text (UUID string from auth.uid()).
-- adminClient (service role) bypasses RLS — the startup watchdog and
-- background pipeline writer both use adminClient so they are unaffected.

alter table public.jel_papers enable row level security;

create policy "jel_papers: users see own rows or admin sees all"
  on public.jel_papers for select
  to authenticated
  using (
    (select auth.uid()::text) = tenant_id
    or (select auth.jwt()->'app_metadata'->>'is_admin') = 'true'
  );

create policy "jel_papers: users insert own rows"
  on public.jel_papers for insert
  to authenticated
  with check (
    (select auth.uid()::text) = tenant_id
  );

create policy "jel_papers: users update own rows"
  on public.jel_papers for update
  to authenticated
  using ((select auth.uid()::text) = tenant_id)
  with check ((select auth.uid()::text) = tenant_id);

create policy "jel_papers: users delete own rows"
  on public.jel_papers for delete
  to authenticated
  using (
    (select auth.uid()::text) = tenant_id
  );
