-- Migration 5: subscriptions table
-- Purpose: Alert subscriptions — topic, author, or search monitoring
-- Maps to AlertSubscription type in types.ts

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  label text not null,
  cadence text not null default 'weekly',
  query text,
  author_id text,
  topic text,
  created_at timestamptz default now()
);

-- type values: 'topic' | 'author' | 'search'
-- cadence values: 'daily' | 'weekly'
