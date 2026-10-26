-- Phone/password authentication tables for the Neon app backend.
-- Run once in Neon after 001_app_schema.sql.

begin;

create table if not exists public.auth_credentials (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists auth_sessions_user_id_idx on public.auth_sessions (user_id);
create index if not exists auth_sessions_expiry_idx on public.auth_sessions (expires_at);

commit;
