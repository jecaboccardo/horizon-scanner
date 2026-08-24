-- BYOK synthesis: an admin's encrypted provider key + the grant roster.
-- DDL only; runtime data path is unchanged. service_role GRANT + PostgREST
-- schema reload are applied at deploy time (see the plan's ops task).

create table if not exists public.synthesis_keys (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  provider      text not null check (provider in ('gemini','claude')),
  enc_key       text not null,          -- base64 AES-256-GCM ciphertext
  enc_iv        text not null,          -- base64 12-byte IV
  model         text,                   -- null => provider default
  label         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
create index if not exists synthesis_keys_owner_idx
  on public.synthesis_keys (owner_user_id) where revoked_at is null;

create table if not exists public.synthesis_grants (
  id              uuid primary key default gen_random_uuid(),
  key_id          uuid not null references public.synthesis_keys(id) on delete cascade,
  grantee_user_id uuid not null,
  created_by      uuid not null,
  created_at      timestamptz not null default now(),
  revoked_at      timestamptz
);
-- At most one ACTIVE grant per grantee (re-grant revokes the prior one).
create unique index if not exists synthesis_grants_one_active_per_user
  on public.synthesis_grants (grantee_user_id) where revoked_at is null;
create index if not exists synthesis_grants_key_idx
  on public.synthesis_grants (key_id) where revoked_at is null;
