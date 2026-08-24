-- Migration: weight_proposals
-- Purpose: Admin-reviewed proposals for updating domain weights.
-- Status values: 'pending' | 'approved' | 'rejected'

create table public.weight_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  domain text not null,
  current_weight float not null,
  proposed_weight float not null,
  explanation text not null,
  signal_count int not null,
  drift_pct float,
  status text not null default 'pending',
  created_at timestamptz default now(),
  reviewed_at timestamptz
);
