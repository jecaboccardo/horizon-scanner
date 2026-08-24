-- Phase 5: Conversational Refinement — brief_messages table
-- Stores chat follow-up messages per brief (append-only, user-isolated)

create table if not exists public.brief_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  brief_id uuid not null references public.briefs(id) on delete cascade,
  role text not null check (role in ('user', 'model')),
  content text not null,
  citations jsonb not null default '[]',
  created_at timestamptz default now()
);

-- Index for efficient history retrieval (ordered by brief + time)
create index if not exists brief_messages_brief_created_idx
  on public.brief_messages (brief_id, created_at asc);

-- Enable RLS
alter table public.brief_messages enable row level security;

-- Users can only see their own messages
create policy "brief_messages: users see own rows"
  on public.brief_messages for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Users can only insert their own messages
create policy "brief_messages: users insert own rows"
  on public.brief_messages for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- No update or delete policies — chat messages are append-only immutable records
