-- Prepare admin withdrawal reconciliation. No existing balances/orders change.
-- Run as the Neon database owner before deploying the admin review feature.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table if not exists public.withdrawal_resolutions (
  id uuid primary key default gen_random_uuid(),
  withdrawal_id uuid not null unique references public.withdrawals(id) on delete restrict,
  user_id uuid not null references public.profiles(id) on delete restrict,
  request_id uuid not null unique,
  action text not null check (action in ('mark_paid', 'refund')),
  amount bigint not null check (amount between 1 and 9007199254740991),
  provider_reference text check (provider_reference is null or
    (char_length(btrim(provider_reference)) between 1 and 160)),
  reason text not null check (char_length(btrim(reason)) between 10 and 500),
  checked_provider boolean not null check (checked_provider),
  actor_session_hash text not null check (actor_session_hash ~ '^[0-9a-f]{64}$'),
  client_ip text not null check (char_length(client_ip) between 1 and 80),
  balance_before bigint not null check (balance_before between 0 and 9007199254740991),
  balance_after bigint not null check (balance_after between 0 and 9007199254740991),
  balance_minor smallint not null check (balance_minor between 0 and 99),
  created_at timestamptz not null default clock_timestamp(),
  check (
    (action = 'refund' and provider_reference is null and balance_after = balance_before + amount)
    or (action = 'mark_paid' and provider_reference is not null and balance_after = balance_before)
  )
);

-- Runtime may append/read evidence, but cannot edit or delete its audit trail.
revoke all on public.withdrawal_resolutions from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'j777_runtime') then
    revoke all on public.withdrawal_resolutions from j777_runtime;
    grant select, insert on public.withdrawal_resolutions to j777_runtime;
  end if;
end $$;

commit;
select 'Withdrawal review storage is ready; existing balances and orders were preserved' as result;
