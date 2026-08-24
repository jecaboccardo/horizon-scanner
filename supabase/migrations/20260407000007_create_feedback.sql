-- Migration 7: feedback table
-- Purpose: User feedback on papers and briefs (likes, dislikes, saves, dismissals)
-- Maps to FeedbackEvent type in types.ts
-- Used by the learning agent in Phase 6 to adjust source/methodology weights

create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  brief_id uuid references public.briefs(id) on delete set null,
  work_id text,
  type text not null,
  reason text,
  created_at timestamptz default now()
);

-- type values: 'like' | 'dislike' | 'save' | 'dismiss' (matches types.ts FeedbackRating)
-- work_id: text (not uuid) — work IDs come from external APIs (DOIs, OpenAlex IDs, etc.)
-- brief_id: nullable — feedback can be on a brief or on an individual work

create index if not exists feedback_user_created_idx
  on public.feedback (user_id, created_at desc);

create index if not exists feedback_work_idx
  on public.feedback (work_id)
  where work_id is not null;
