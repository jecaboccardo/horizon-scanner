-- Migration 6: feed table
-- Purpose: User-specific feed items (papers, briefs, signals surfaced by the system)
-- Maps to FeedItem type in types.ts

create table if not exists public.feed (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  title text not null,
  reason text,
  linked_entity_id uuid,
  created_at timestamptz default now()
);

-- kind values: 'paper' | 'brief' | 'signal' (matches types.ts FeedItemKind)
-- linked_entity_id: UUID of the related work, brief, or signal entity

create index if not exists feed_user_created_idx
  on public.feed (user_id, created_at desc);
