-- Migration 1: profiles table + custom access token hook
-- Purpose: User profiles with is_admin flag; hook injects admin claim into JWT app_metadata

create table if not exists public.profiles (
  id uuid not null primary key references auth.users(id) on delete cascade,
  is_admin boolean not null default false,
  display_name text,
  created_at timestamptz default now()
);

-- Grant auth admin access so the hook can read profiles
grant all on table public.profiles to supabase_auth_admin;

-- Revoke access from application roles — profiles are read via service role only
revoke all on table public.profiles from authenticated;
revoke all on table public.profiles from anon;
revoke all on table public.profiles from public;

-- Custom Access Token Hook
-- Runs before each JWT is issued; injects is_admin into app_metadata if true
-- Enabled in Dashboard → Authentication → Hooks → Custom Access Token Hook
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
security definer
as $$
  declare
    claims jsonb;
    is_admin_val boolean;
  begin
    select is_admin into is_admin_val
      from public.profiles
      where id = (event->>'user_id')::uuid;

    if is_admin_val then
      claims := event->'claims';
      if jsonb_typeof(claims->'app_metadata') is null then
        claims := jsonb_set(claims, '{app_metadata}', '{}');
      end if;
      claims := jsonb_set(claims, '{app_metadata,is_admin}', 'true');
      event := jsonb_set(event, '{claims}', claims);
    end if;

    return event;
  end;
$$;

grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
