-- Shared rate limits and individually revocable administrator sessions.
-- Apply before deploying the authentication security changes. No player data is changed.
begin;

create table if not exists public.auth_rate_limits (
  scope text not null check (char_length(scope) between 1 and 100),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  attempts integer not null check (attempts between 1 and 1000000),
  window_started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (scope, key_hash),
  check (expires_at > window_started_at)
);

create index if not exists auth_rate_limits_expiry_idx on public.auth_rate_limits (expires_at);

create table if not exists public.auth_admin_sessions (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > created_at)
);

create index if not exists auth_admin_sessions_expiry_idx on public.auth_admin_sessions (expires_at);

revoke all on public.auth_rate_limits from public;
revoke all on public.auth_admin_sessions from public;

commit;

-- Periodic maintenance (run outside request processing):
-- delete from public.auth_rate_limits where expires_at < now() - interval '1 day';
-- delete from public.auth_admin_sessions where expires_at < now();
