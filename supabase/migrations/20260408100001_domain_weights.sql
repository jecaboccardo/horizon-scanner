-- Migration: domain_weights
-- Purpose: Per-user Bayesian weight tracking per domain for the learning agent.
-- Note: Uses beta_param (not beta) to avoid collision with PostgreSQL reserved word.

create table public.domain_weights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  domain text not null,
  alpha float not null default 2.0,
  beta_param float not null default 2.0,
  weight float not null default 1.0,
  signal_count int not null default 0,
  updated_at timestamptz default now(),
  unique (user_id, domain)
);
