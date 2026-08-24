-- Migration: weight_alerts
-- Purpose: System-wide alerts triggered when aggregate domain weight drift exceeds threshold.
-- Note: No user_id column — these are admin/system-level events, not per-user.

create table public.weight_alerts (
  id uuid primary key default gen_random_uuid(),
  alert_type text not null default 'drift_suspension',
  message text not null,
  total_drift_pct float not null,
  created_at timestamptz default now(),
  resolved_at timestamptz
);
